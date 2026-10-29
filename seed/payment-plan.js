/**
 * A payment plan the demo account is keeping to.
 *
 * Without it neither of slice 1's two screens can be opened on a fresh
 * database without hand-building a plan in SQL, and the screens are half
 * the slice. Every other feature here seeds its demo; the delinquency
 * ladder got a module of its own last week for the same reason.
 *
 * What it seeds is what a real arrangement looks like, not the simplest
 * thing that renders:
 *
 *   - **Two covered debts of different kinds** — the opening balance,
 *     which has no bill at all, and the oldest bill charge. Two of the
 *     five real debits on a converted account carry no bill number, and
 *     a screen built against bill charges alone renders a blank where
 *     the commonest line should be.
 *   - **The down payment already paid**, so the panel reads "on track"
 *     rather than opening on a failure state.
 *   - **A real `ledger_application`**, not just a reduced `open_amount`:
 *     the AR reconciliation proves applications against open amounts,
 *     and a seeded payment that moved one without the other would make
 *     the demo database fail its own invariant.
 *
 * Written with Prisma rather than by calling the services, like every
 * other section of the seed: `seed.js` runs as plain `node seed.js` and
 * cannot import the TypeScript.
 */

const DAY_MS = 86_400_000;

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

/** UTC midnight, so a DATE column lands on the day it says. */
function utcDay(date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function money(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * @returns a short description of what was agreed, for the seed's log.
 */
async function seedPaymentPlan({ p, utilityId, accountId, approvedBy }) {
  // Everything still open on the account, oldest first. The plan covers
  // the arrears that existed when it was agreed — not "everything from
  // now on" — so this is read once and then named explicitly.
  const open = await p.ledgerEntry.findMany({
    where: { utilityId, accountId, openAmount: { gt: 0 } },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    select: {
      id: true,
      type: true,
      openAmount: true,
      dueDate: true,
      bill: { select: { billNumber: true } },
    },
  });

  // Already overdue, which is what a plan is agreed about. A bill that
  // is not yet due is offered in the dialog but not assumed, and a
  // seeded plan should look like one an operator would actually agree.
  const today = utcDay(new Date());
  const arrears = open.filter((e) => e.dueDate && e.dueDate < today).slice(0, 2);

  if (arrears.length === 0) {
    return { skipped: "no overdue debts on the demo account" };
  }

  const totalBalance = arrears.reduce((sum, e) => sum + Number(e.openAmount), 0);

  // The tenant's default terms: 25% down, then six monthly payments.
  const downPayment = Math.round(totalBalance * 25) / 100;
  const remainder = totalBalance - downPayment;
  const installmentCount = 6;
  const base = Math.floor((remainder / installmentCount) * 100) / 100;

  // Agreed a fortnight ago, so the down payment has had time to arrive
  // and the panel has something to show other than "nothing yet".
  const startDate = utcDay(addDays(new Date(), -14));

  const plan = await p.paymentPlan.create({
    data: {
      utilityId,
      accountId,
      status: "ACTIVE",
      totalBalance: money(totalBalance),
      downPayment: money(downPayment),
      installmentAmount: money(base),
      installmentFrequency: "MONTHLY",
      installmentCount,
      startDate,
      approvedBy,
      notes: "Agreed at the counter — customer between jobs.",
      // The six judgement terms, frozen at agreement, matching the
      // shipped defaults.
      graceDays: 5,
      missedBeforeDefault: 1,
      partialInstallmentCounts: false,
      currentBillCounts: true,
      suppressFeesWhileKept: true,
      assessSuppressedFeesOnDefault: false,
    },
    select: { id: true },
  });

  await p.paymentPlanDebit.createMany({
    data: arrears.map((e) => ({ utilityId, planId: plan.id, entryId: e.id })),
  });

  /*
   * The down payment, as a real payment with real applications.
   *
   * Allocated oldest-first across the covered debts, which is what
   * `applyCreditToDebits` would have done for a payment marked against
   * this plan.
   */
  const payment = await p.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "PAYMENT",
      amount: money(-downPayment),
      openAmount: "0.00",
      effectiveDate: startDate,
      tender: "CHECK",
      memo: "Payment plan down payment",
      createdBy: approvedBy,
    },
    select: { id: true },
  });

  let left = downPayment;
  for (const debt of arrears) {
    if (left <= 0) break;
    const applied = Math.min(left, Number(debt.openAmount));
    await p.ledgerApplication.create({
      data: {
        utilityId,
        creditId: payment.id,
        debitId: debt.id,
        amount: money(applied),
      },
    });
    await p.ledgerEntry.update({
      where: { id: debt.id },
      data: { openAmount: money(Number(debt.openAmount) - applied) },
    });
    left -= applied;
  }

  // The cache, recomputed from the ledger the way the production path
  // maintains it — a seeded balance that disagrees with the entries
  // behind it is a demo database that fails its own reconciliation.
  const stillOpen = await p.ledgerEntry.aggregate({
    where: { utilityId, accountId, openAmount: { gt: 0 }, type: { not: "DEPOSIT" } },
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
      balance: (stillOpen._sum.openAmount ?? 0).toString(),
      lastDueDate: oldest ? oldest.dueDate : null,
    },
  });

  return {
    planId: plan.id,
    covered: arrears.map((e) => e.bill?.billNumber ?? "opening balance"),
    totalBalance: money(totalBalance),
    downPayment: money(downPayment),
    installmentAmount: money(base),
    installmentCount,
  };
}

module.exports = { seedPaymentPlan };
