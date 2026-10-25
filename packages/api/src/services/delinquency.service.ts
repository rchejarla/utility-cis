import { prisma } from "../lib/prisma.js";
import { sendNotification } from "./notification.service.js";
import { assessFee } from "./ar/fee.service.js";
import { reverseEntry } from "./ar/reversal.service.js";
import { tierFeeAmount } from "./delinquency-fee.js";

/**
 * Who the ledger records as having raised an automated fee.
 *
 * A constant and not a seeded `cis_user` row: neither
 * `ledger_entry.created_by` nor `audit_log.actor_id` is a foreign key to
 * that table, and the only reader that turns an actor id into a name is
 * the audit list, which does so only for rows whose `actor_name` is null
 * — and these carry one. Seeding a reserved user per tenant would buy
 * nothing and cost a provisioning change plus a fixture in every suite.
 */
export const AUTOMATED_ACTOR_ID = "00000000-0000-4000-8000-00000000de10";
export const AUTOMATED_ACTOR_NAME = "Delinquency (automated)";

/**
 * Delinquency evaluation engine. The nightly job calls evaluateAll()
 * which walks every account with a positive balance and applies the
 * tenant's delinquency rules tier by tier.
 */

/**
 * Whether this tier's own fee is still hanging over the account.
 *
 * The partial unique index stops a *second live action*, which is what
 * keeps a duplicate out of one sweep and out of a concurrent one. It
 * cannot stop a re-charge, because it is deliberately partial: a
 * cancelled or resolved action leaves the account past due with nothing
 * live, and the next hourly tick would charge the tier again. A CSR
 * pressing Cancel does that, and `resolveAccount` — granting a payment
 * plan — cancels every PENDING action at once, so an account on three
 * charging tiers would be re-charged all three, and again on every
 * later resolve.
 *
 * So the gate is the money, not the action. Outstanding means **open or
 * reversed**: an open fee has not been dealt with, and a reversed one
 * was somebody deciding the customer does not owe it, which an hourly
 * sweep must not overrule. Only a fee paid in full and not reversed
 * clears the way, which is also what ending a delinquency episode looks
 * like — so a customer who clears their balance and falls behind on a
 * later bill is charged again, rather than paying one late fee per
 * account per lifetime.
 */
async function tierFeeOutstanding(
  tx: Parameters<typeof tierFeeAmount>[0],
  utilityId: string,
  accountId: string,
  ruleId: string,
): Promise<boolean> {
  const priorFees = await tx.delinquencyAction.findMany({
    where: { utilityId, accountId, ruleId, feeEntryId: { not: null } },
    select: { feeEntryId: true },
  });
  if (priorFees.length === 0) return false;

  const outstanding = await tx.ledgerEntry.count({
    where: {
      utilityId,
      id: { in: priorFees.map((a) => a.feeEntryId!) },
      OR: [{ openAmount: { not: 0 } }, { reversedBy: { some: {} } }],
    },
  });
  return outstanding > 0;
}

/**
 * Reverse the fees this ladder raised at lower tiers of the same
 * ladder, before this tier raises its own.
 *
 * The candidates are found by walking `DelinquencyAction.feeEntryId`,
 * not by asking what reason a fee cites. That is what keeps a
 * returned-payment fee and a late fee a CSR added by hand out of reach:
 * neither has a delinquency action, whatever the tenant has named its
 * reasons. The question is which fees this ladder owns, and ownership is
 * not a category.
 *
 * Reversal rather than deletion, so a statement reads $10 fee, $10
 * reversal, $25 fee — and because `reverseEntry` gives back what the
 * entry consumed. Reversing before the new fee is raised is what lets a
 * freed payment be re-applied to it.
 *
 * `accountType` has to match, or a RESIDENTIAL tier would reach into a
 * COMMERCIAL ladder's fees; those are separate ladders, as
 * `@@unique([utilityId, accountType, tier])` already says.
 */
async function replaceLowerTierFees(
  tx: Parameters<typeof tierFeeAmount>[0],
  utilityId: string,
  accountId: string,
  rule: { tier: number; accountType: string | null; name: string },
): Promise<void> {
  const lower = await tx.delinquencyAction.findMany({
    where: {
      utilityId,
      accountId,
      status: { in: ["PENDING", "COMPLETED"] },
      feeEntryId: { not: null },
      rule: { tier: { lt: rule.tier }, accountType: rule.accountType },
    },
    select: { feeEntryId: true },
  });
  if (lower.length === 0) return;

  const feeIds = lower.map((a) => a.feeEntryId!);

  /*
   * A fee already reversed is skipped rather than reversed again, which
   * `reverseEntry` refuses with a 409. That state is reachable:
   * `resolveAccount` resolves only the highest live tier and cancels the
   * PENDING ones, so a lower COMPLETED action can outlive the tier above
   * it, and when the account falls behind again this tier meets a
   * candidate whose fee it already reversed. Without this the whole
   * tenant's sweep would throw over it.
   */
  const alreadyReversed = new Set(
    (
      await tx.ledgerEntry.findMany({
        where: { utilityId, reversesId: { in: feeIds } },
        select: { reversesId: true },
      })
    ).map((r) => r.reversesId),
  );

  for (const feeId of feeIds) {
    if (alreadyReversed.has(feeId)) continue;
    try {
      await reverseEntry(
        utilityId,
        AUTOMATED_ACTOR_ID,
        AUTOMATED_ACTOR_NAME,
        feeId,
        { memo: `Replaced by ${rule.name}` },
        tx,
      );
    } catch (e) {
      /*
       * The set above is read before `reverseEntry` takes the account
       * lock, so a second process can reverse the same fee in between
       * and this one arrives to a 409. Already reversed is the outcome
       * we wanted; it is not a reason to fail the tenant's sweep. Any
       * other error still is.
       */
      if ((e as { code?: string }).code !== "ENTRY_ALREADY_REVERSED") throw e;
    }
  }
}

/**
 * A unique violation on `delinquency_action_one_live_per_rule` — the
 * partial index that makes "one live action per account per tier" true
 * across processes rather than only within one loop.
 */
function isDuplicateAction(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "P2002"
  );
}

export async function evaluateAll(utilityId: string): Promise<{
  accountsEvaluated: number;
  actionsCreated: number;
}> {
  const accounts = await prisma.account.findMany({
    where: {
      utilityId,
      balance: { gt: 0 },
      lastDueDate: { not: null },
      status: "ACTIVE",
    },
    select: {
      id: true,
      balance: true,
      lastDueDate: true,
      accountType: true,
      isProtected: true,
      customerId: true,
    },
  });

  const rules = await prisma.delinquencyRule.findMany({
    where: { utilityId, isActive: true },
    orderBy: { tier: "asc" },
  });

  const existingActions = await prisma.delinquencyAction.findMany({
    where: {
      utilityId,
      status: { in: ["PENDING", "COMPLETED"] },
    },
    select: { accountId: true, ruleId: true },
  });

  const actionSet = new Set(
    existingActions.map((a) => `${a.accountId}:${a.ruleId}`),
  );

  const now = new Date();
  let actionsCreated = 0;

  for (const account of accounts) {
    if (!account.lastDueDate) continue;

    const daysPastDue = Math.floor(
      (now.getTime() - new Date(account.lastDueDate).getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysPastDue <= 0) continue;

    const balance = Number(account.balance);

    /*
     * A rule reaches only debt that came due while it was in force.
     * Gated against `lastDueDate` and not against today, because the
     * question is whether the tier existed when the account fell
     * behind — otherwise configuring a tier this afternoon fires it at
     * every account that has ever been past due, retroactively.
     *
     * Both columns are DATE, so Prisma hands back UTC midnight on each
     * side and this is a day-level comparison. Equal dates pass: a tier
     * that came into force on the day the debt came due was in force.
     */
    const dueMs = new Date(account.lastDueDate).getTime();

    const applicableRules = rules.filter((r) => {
      if (r.accountType && r.accountType !== account.accountType) return false;
      if (r.daysPastDue > daysPastDue) return false;
      if (Number(r.minBalance) > balance) return false;
      if (!r.autoApply) return false;
      if (new Date(r.effectiveDate).getTime() > dueMs) return false;
      return true;
    });

    for (const rule of applicableRules) {
      const key = `${account.id}:${rule.id}`;
      if (actionSet.has(key)) continue;

      if (
        account.isProtected &&
        (rule.actionType === "SHUT_OFF_ELIGIBLE" || rule.actionType === "DISCONNECT")
      ) {
        continue;
      }

      let actionId: string | null = null;

      try {
        /*
         * The fee and the action commit together. An account marked
         * delinquent with no charge, or charged with no record of which
         * tier did it, are both worse than a sweep that fails and can be
         * re-run — and a duplicate fee is a wrong bill, which is why
         * this is a transaction and not two statements.
         *
         * The fee is written first so the action can name it in one
         * insert rather than an insert and an update. A unique violation
         * on the action therefore rolls the fee back with it, which is
         * what makes the race safe to lose.
         */
        await prisma.$transaction(async (tx) => {
          let feeEntryId: string | null = null;

          if (rule.feeType && rule.feeAmount && rule.feeReasonId) {
            const amount = (await tierFeeOutstanding(tx, utilityId, account.id, rule.id))
              ? null
              : await tierFeeAmount(tx, utilityId, account.id, {
                  feeType: rule.feeType,
                  feeAmount: rule.feeAmount,
                  maxFee: rule.maxFee,
                });

            /*
             * Null means there is nothing to charge — this tier's last
             * fee is still outstanding, or a percentage of a base that
             * rounds to nothing. The action is still written: the
             * account passed the tier.
             *
             * Replacement is inside this branch, not before it. Running
             * it first meant a tier could reverse the fee below it and
             * then charge nothing, which is forgiveness arriving as a
             * side effect of a schedule — the exact thing the
             * `delinquency_rule_replace_needs_fee` CHECK was written to
             * make inexpressible. That CHECK constrains configuration;
             * only this ordering constrains the outcome.
             */
            if (amount) {
              if (rule.feeMode === "REPLACE_LOWER_TIERS") {
                await replaceLowerTierFees(tx, utilityId, account.id, rule);
              }
              const fee = await assessFee(
                utilityId,
                AUTOMATED_ACTOR_ID,
                AUTOMATED_ACTOR_NAME,
                account.id,
                {
                  amount,
                  reasonId: rule.feeReasonId,
                  memo: `${rule.name} — ${daysPastDue} days past due`,
                },
                tx,
              );
              feeEntryId = fee.feeId;
            }
          }

          const action = await tx.delinquencyAction.create({
            data: {
              utilityId,
              accountId: account.id,
              ruleId: rule.id,
              tier: rule.tier,
              actionType: rule.actionType,
              status: "PENDING",
              balanceAtAction: balance,
              daysPastDueAtAction: daysPastDue,
              triggeredBy: "AUTOMATED",
              feeEntryId,
            },
            select: { id: true },
          });
          actionId = action.id;
        });
      } catch (e) {
        /*
         * Another process created this action between our read of the
         * live set and this insert. `actionSet` cannot see across
         * processes, so the partial unique index is what turns that
         * into a refusal instead of a duplicate; record it as taken
         * and carry on rather than failing the whole tenant's sweep
         * over one account.
         *
         * Nothing has been sent to the customer at this point, which is
         * the reason the notice moved below: a sweep that rolls back —
         * on a reason retired after the rule cited it, say — used to
         * leave a notice behind every hour while never writing an
         * action or a fee.
         */
        if (!isDuplicateAction(e)) throw e;
        actionSet.add(key);
        continue;
      }

      /*
       * The notice, after the money and outside its transaction. An
       * external dispatch inside a transaction holds a database lock
       * across someone else's network call, and a notice that fails to
       * send has to leave the action PENDING — which is what that
       * status is for. The action is the record that the tier fired;
       * the notification is an attempt to tell someone.
       */
      if (rule.notificationEventType && actionId) {
        const channel =
          rule.actionType === "NOTICE_SMS" ? "SMS" as const : "EMAIL" as const;
        const notificationId = await sendNotification(utilityId, {
          eventType: rule.notificationEventType,
          channel,
          recipientId: account.customerId ?? "",
          context: {
            accountId: account.id,
            delinquencyBalance: `$${balance.toFixed(2)}`,
            delinquencyDaysPastDue: String(daysPastDue),
            delinquencyTierName: rule.name,
            delinquencyActionType: rule.actionType,
          },
        });
        if (notificationId) {
          await prisma.delinquencyAction.update({
            where: { id: actionId },
            data: { notificationId, status: "COMPLETED" },
          });
        }
      }

      actionSet.add(key);
      actionsCreated++;
    }
  }

  return { accountsEvaluated: accounts.length, actionsCreated };
}

/**
 * Wrapper around `evaluateAll` for the BullMQ-worker entry point. On
 * success, updates `utility_config.delinquencyLastRunAt` so the
 * dispatcher's missed-tick recovery can detect when this tenant
 * hasn't been evaluated in over 23 hours.
 *
 * Kept as a separate function (rather than folding the timestamp
 * write into `evaluateAll`) so the legacy in-process path continues
 * to behave exactly as it did pre-migration during the gated rollout.
 * Removing this distinction is part of plan task 9 (legacy cleanup).
 */
export async function evaluateDelinquencyForTenant(
  utilityId: string,
  now: Date = new Date(),
): Promise<{ accountsEvaluated: number; actionsCreated: number }> {
  const result = await evaluateAll(utilityId);
  await prisma.utilityConfig.update({
    where: { utilityId },
    data: { delinquencyLastRunAt: now },
  });
  return result;
}

export async function resolveAccount(
  utilityId: string,
  accountId: string,
  resolutionType: string,
  notes?: string,
  userId?: string,
): Promise<number> {
  const now = new Date();

  const pendingActions = await prisma.delinquencyAction.updateMany({
    where: { utilityId, accountId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: now, resolutionType, notes },
  });

  const latestActive = await prisma.delinquencyAction.findFirst({
    where: { utilityId, accountId, status: { in: ["COMPLETED", "PENDING"] } },
    orderBy: { tier: "desc" },
  });

  if (latestActive) {
    await prisma.delinquencyAction.update({
      where: { id: latestActive.id },
      data: { status: "RESOLVED", resolvedAt: now, resolutionType, notes },
    });
  }

  return pendingActions.count + (latestActive ? 1 : 0);
}

export async function escalateAccount(
  utilityId: string,
  accountId: string,
  userId: string,
  notes?: string,
): Promise<{ action: unknown } | null> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, utilityId },
    select: { id: true, balance: true, lastDueDate: true, accountType: true, isProtected: true, customerId: true },
  });
  if (!account || !account.lastDueDate) return null;

  const currentMaxTier = await prisma.delinquencyAction.findFirst({
    where: { accountId, utilityId, status: { in: ["PENDING", "COMPLETED"] } },
    orderBy: { tier: "desc" },
    select: { tier: true },
  });

  const nextTier = (currentMaxTier?.tier ?? 0) + 1;

  const nextRule = await prisma.delinquencyRule.findFirst({
    where: { utilityId, tier: nextTier, isActive: true },
    orderBy: { tier: "asc" },
  });

  if (!nextRule) return null;

  const daysPastDue = Math.floor(
    (Date.now() - new Date(account.lastDueDate).getTime()) / (1000 * 60 * 60 * 24),
  );

  let notificationId: string | null = null;
  if (nextRule.notificationEventType) {
    const channel = nextRule.actionType === "NOTICE_SMS" ? "SMS" as const : "EMAIL" as const;
    notificationId = await sendNotification(utilityId, {
      eventType: nextRule.notificationEventType,
      channel,
      recipientId: account.customerId ?? "",
      context: {
        accountId: account.id,
        delinquencyBalance: `$${Number(account.balance).toFixed(2)}`,
        delinquencyDaysPastDue: String(daysPastDue),
        delinquencyTierName: nextRule.name,
        delinquencyActionType: nextRule.actionType,
      },
    });
  }

  const action = await prisma.delinquencyAction.create({
    data: {
      utilityId,
      accountId,
      ruleId: nextRule.id,
      tier: nextTier,
      actionType: nextRule.actionType,
      status: notificationId ? "COMPLETED" : "PENDING",
      balanceAtAction: Number(account.balance),
      daysPastDueAtAction: daysPastDue,
      triggeredBy: "MANUAL",
      triggeredByUserId: userId,
      notificationId,
      notes,
    },
    include: { rule: true },
  });

  return { action };
}

