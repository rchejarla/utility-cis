/**
 * A late-fee ladder that has already run, on a real overdue bill.
 *
 * The rules alone demo nothing: `evaluateAll` charges a fee dated the
 * day it runs, and a fee prints on the first bill issued *after* its
 * effective date — so a sweep today puts its fee on next month's bill
 * and today's billing run shows an unchanged page. To see the line, the
 * fees have to pre-date the bill the run is about to produce, which
 * means seeding them where the ladder would have put them weeks ago.
 *
 * Everything the ladder itself writes is written here, in the same
 * shapes, because leaving any of it out breaks the next real sweep:
 *
 *   - the FEE entry, carrying `assessed_on_id` — the bill it punishes,
 *     which is what the bill and the AR screen now name;
 *   - the `delinquency_action` for the tier, which is the record of what
 *     was *done* to the account;
 *   - the `delinquency_action_fee` link. Without it `alreadyChargedBill`
 *     finds nothing and the next sweep charges tier 1 all over again.
 *
 * Written with Prisma rather than by calling the services, like every
 * other section of the seed: `seed.js` runs as plain `node seed.js` and
 * cannot import the TypeScript. The cost is that the fee arithmetic
 * lives in two places, so this only handles FLAT_FEE and says so loudly
 * rather than quietly miscomputing a percentage.
 */

const AUTOMATED_ACTOR_ID = "00000000-0000-4000-8000-00000000de10";
const DAY_MS = 86_400_000;

/** `assessFee`'s default term, so a seeded fee ages like a real one. */
const FEE_DUE_DAYS = 30;

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The bill date the next billing run will use for this cycle.
 *
 * `createBillingRun` takes `computeBillPeriod(...).periodEnd` as the
 * bill date, and that is the most recent `billDayOfMonth` on or before
 * today. Recomputed here rather than guessed, because it is the upper
 * bound of the window the fees have to fall inside — a fee dated after
 * it prints on the month after, and the demo shows nothing.
 */
function nextRunBillDate(billDayOfMonth, today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return today.getUTCDate() >= billDayOfMonth
    ? new Date(Date.UTC(y, m, billDayOfMonth))
    : new Date(Date.UTC(y, m - 1, billDayOfMonth));
}

/**
 * Seed the fees two tiers would have raised on the account's oldest
 * unpaid bill.
 *
 * Returns what it wrote, or `{ skipped: <why> }` when the account has
 * no overdue bill charge to punish — a seed that reports zero is better
 * than one that invents a bill to make its own demo work.
 */
async function seedDelinquencyLadder({ p, utilityId, accountId, rules, today = new Date() }) {
  const account = await p.account.findFirst({
    where: { id: accountId, utilityId },
    select: { id: true, accountNumber: true, billingCycle: { select: { billDayOfMonth: true } } },
  });
  if (!account) return { skipped: "account not found" };

  /*
   * The oldest open, overdue bill charge — the same row
   * `chargeableDebits` would return first, minus the penalty and
   * deposit exclusions, which a BILL_CHARGE cannot trip.
   */
  const debit = await p.ledgerEntry.findFirst({
    where: {
      utilityId,
      accountId,
      type: "BILL_CHARGE",
      openAmount: { gt: 0 },
      dueDate: { lt: today },
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    select: { id: true, openAmount: true, dueDate: true, bill: { select: { billNumber: true, billDate: true } } },
  });
  if (!debit) return { skipped: "no open overdue bill charge on the demo account" };

  /*
   * The window a fee has to land in to print on the next run's bill:
   * after the account's latest existing bill, and on or before the bill
   * the run will produce. `windowEnd` is a day early so a fee never
   * shares the bill date, where `lte` would still catch it but a reader
   * could not tell which side of the boundary it was meant to be on.
   */
  const latest = await p.bill.findFirst({
    where: { utilityId, accountId },
    orderBy: [{ billDate: "desc" }, { billNumber: "desc" }],
    select: { billDate: true },
  });
  const windowStart = latest.billDate;
  const windowEnd = addDays(nextRunBillDate(account.billingCycle.billDayOfMonth, today), -1);
  if (windowEnd <= addDays(windowStart, 1)) {
    return { skipped: `no room between ${ymd(windowStart)} and ${ymd(windowEnd)} for a fee to print` };
  }

  const charging = rules
    .filter((r) => r.feeType && r.feeReasonId)
    .sort((a, b) => a.tier - b.tier);

  /**
   * Reverse the fees this seeded ladder raised on this bill at lower
   * tiers, the way `replaceLowerTierFeesOnBill` does through
   * `reverseEntry`: a REVERSAL carrying the negated amount, an
   * application settling it against the original, and both sides closed
   * to zero.
   *
   * Duplicated here for the reason the fee arithmetic is — `seed.js`
   * cannot import the services — and scoped to the fees this function
   * raised in this run, which is the whole of what a replacing tier may
   * reach. A fee a CSR added by hand has no delinquency action and is
   * none of its business.
   */
  async function replaceLowerTierFees(lowerFees, rule, effectiveDate) {
    for (const fee of lowerFees) {
      const reversal = await p.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "REVERSAL",
          amount: `-${fee.amount}`,
          // Closed immediately by the application below, so it never
          // has an open amount for the aging index to find — which is
          // also why a reversal carries no due date.
          openAmount: "0.00",
          dueDate: null,
          effectiveDate,
          reversesId: fee.id,
          memo: `Replaced by ${rule.name}`,
          createdBy: AUTOMATED_ACTOR_ID,
        },
        select: { id: true },
      });
      await p.ledgerApplication.create({
        data: { utilityId, creditId: reversal.id, debitId: fee.id, amount: fee.amount },
      });
      await p.ledgerEntry.update({ where: { id: fee.id }, data: { openAmount: "0.00" } });
    }
  }

  /** The fees raised so far, so a replacing tier can reach them. */
  const standing = [];
  const raised = [];
  for (const rule of charging) {
    const daysPastDue = Math.floor((today - debit.dueDate) / DAY_MS);
    if (daysPastDue < rule.daysPastDue) continue;

    if (rule.feeType !== "FLAT_FEE") {
      console.log(
        `  [skip] tier ${rule.tier} charges ${rule.feeType}; the seed only computes FLAT_FEE. ` +
          `Run POST /api/v1/delinquency/evaluate to let the ladder charge it for real.`,
      );
      continue;
    }

    /*
     * Where the ladder would have charged it: the day this bill reached
     * the tier. Clamped into the printing window, because on the first
     * days of a month the realistic date lands after the run's bill date
     * and the fee would print a month later — true to the product, and
     * useless as a demo. The clamp is the one thing here that is not
     * what the ladder would have done.
     */
    const earned = addDays(debit.dueDate, rule.daysPastDue);
    const effectiveDate = new Date(Math.min(earned.getTime(), windowEnd.getTime()));
    const amount = Number(rule.feeAmount).toFixed(2);

    /*
     * Replacement happens only once this tier knows it will charge, and
     * on this bill alone — the order the real sweep uses, because
     * running it first would let a tier reverse the fee below it and
     * raise nothing in its place. Forgiveness arriving as a side effect
     * of a schedule is what `delinquency_rule_replace_needs_fee` exists
     * to forbid.
     */
    if (rule.feeMode === "REPLACE_LOWER_TIERS" && standing.length > 0) {
      await replaceLowerTierFees(standing.splice(0), rule, effectiveDate);
    }

    const action = await p.delinquencyAction.create({
      data: {
        utilityId,
        accountId,
        ruleId: rule.id,
        tier: rule.tier,
        actionType: rule.actionType,
        // The notice went out weeks ago in this story. No `notification`
        // row backs it: the seed dispatches nothing, and inventing one
        // would put a message in the outbox nobody sent.
        status: "COMPLETED",
        balanceAtAction: debit.openAmount,
        daysPastDueAtAction: rule.daysPastDue,
        triggeredBy: "AUTOMATED",
        resolvedAt: null,
      },
      select: { id: true },
    });

    const fee = await p.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "FEE",
        amount,
        openAmount: amount,
        dueDate: addDays(effectiveDate, FEE_DUE_DAYS),
        effectiveDate,
        reasonId: rule.feeReasonId,
        // The bill this fee punishes. Without it the bill prints
        // "Late payment fee <date>" twice with nothing to tell the two
        // apart, which is the whole reason the column is read.
        assessedOnId: debit.id,
        memo: `${rule.name} — ${rule.daysPastDue} days past due`,
        createdBy: AUTOMATED_ACTOR_ID,
      },
      select: { id: true },
    });

    await p.delinquencyActionFee.create({
      data: { utilityId, actionId: action.id, entryId: fee.id },
    });

    standing.push({ id: fee.id, amount });
    raised.push({ tier: rule.tier, amount, effectiveDate, mode: rule.feeMode });
  }

  if (raised.length === 0) {
    return { skipped: "no tier had been reached by the overdue bill" };
  }

  /*
   * The caches the ledger maintains, set to what the entries now imply.
   * `GET /api/v1/ar/reconciliation` compares `account.balance` against
   * SUM(open_amount), so a seed that writes entries and leaves the cache
   * alone shows as drift on every fresh database.
   *
   * A DEPOSIT is excluded for the reason `recomputeAccountCache`
   * excludes it: money the utility holds is not money the customer owes,
   * and netting it in would hide this account from the sweep, which
   * looks for balance > 0.
   */
  const open = await p.ledgerEntry.aggregate({
    where: { utilityId, accountId, type: { not: "DEPOSIT" } },
    _sum: { openAmount: true },
  });
  const oldest = await p.ledgerEntry.findFirst({
    where: { utilityId, accountId, openAmount: { gt: 0 }, dueDate: { not: null } },
    orderBy: { dueDate: "asc" },
    select: { dueDate: true },
  });
  await p.account.update({
    where: { id: accountId },
    data: {
      balance: (open._sum.openAmount ?? 0).toString(),
      lastDueDate: oldest ? oldest.dueDate : null,
    },
  });

  return {
    accountNumber: account.accountNumber,
    billNumber: debit.bill.billNumber,
    dueDate: debit.dueDate,
    raised,
    printsOnBillDated: addDays(windowEnd, 1),
  };
}

module.exports = { seedDelinquencyLadder, nextRunBillDate };
