import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../lib/prisma.js";
import { sendNotification } from "./notification.service.js";
import { assessFee } from "./ar/fee.service.js";
import { reverseEntry } from "./ar/reversal.service.js";
import { chargeableDebits, tierFeeAmount } from "./delinquency-fee.js";
import type { TxClient } from "./ar/posting.service.js";

/** A tier that charges, with the fee columns proven non-null by the caller. */
interface ChargingRule {
  id: string;
  tier: number;
  name: string;
  daysPastDue: number;
  accountType: string | null;
  feeType: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  feeAmount: Prisma.Decimal;
  maxFee: Prisma.Decimal | null;
  feeReasonId: string;
  feeMode: "ACCUMULATE" | "REPLACE_LOWER_TIERS";
}

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
 * Charge every unpaid bill that has passed one of these tiers.
 *
 * One transaction for the account: `chargeableDebits` locks it and
 * reads, and the writes follow, so the figures a fee is computed from
 * are the figures still true when it is written. Tiers run low to high,
 * so a replacing tier meets the fees below it already in place.
 */
async function chargeOverdueBills(
  utilityId: string,
  accountId: string,
  chargingRules: ChargingRule[],
  liveActionByRule: Map<string, string>,
  now: Date,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const debits = await chargeableDebits(tx, utilityId, accountId, now);
    if (debits.length === 0) return 0;

    let raised = 0;
    for (const rule of [...chargingRules].sort((a, b) => a.tier - b.tier)) {
      for (const debit of debits) {
        // The bill's own clock, not the account's. A bill three days
        // late is charged nothing however old its neighbours are.
        if (debit.daysPastDue < rule.daysPastDue) continue;
        if (await alreadyChargedBill(tx, utilityId, rule.id, debit.id)) continue;

        const amount = tierFeeAmount(
          { feeType: rule.feeType, feeAmount: rule.feeAmount, maxFee: rule.maxFee },
          debit,
        );
        /*
         * Nothing to charge, so nothing is reversed either. Replacement
         * sits behind this check because running it first let a tier
         * reverse the fee below it and then charge nothing — forgiveness
         * arriving as a side effect of a schedule, which the
         * `delinquency_rule_replace_needs_fee` CHECK exists to forbid
         * and cannot see, since it constrains configuration and this is
         * an outcome.
         */
        if (!amount) continue;

        if (rule.feeMode === "REPLACE_LOWER_TIERS") {
          await replaceLowerTierFeesOnBill(tx, utilityId, accountId, rule, debit.id);
        }

        const fee = await assessFee(
          utilityId,
          AUTOMATED_ACTOR_ID,
          AUTOMATED_ACTOR_NAME,
          accountId,
          {
            amount,
            reasonId: rule.feeReasonId,
            // The bill this fee punishes. `fee.service.ts` reserved the
            // field for exactly this and nothing had used it.
            assessedOnId: debit.id,
            memo: `${rule.name} — ${debit.daysPastDue} days past due`,
          },
          tx,
        );
        await tx.delinquencyActionFee.create({
          data: { utilityId, actionId: liveActionByRule.get(rule.id)!, entryId: fee.feeId },
        });
        raised++;
      }
    }
    return raised;
  });
}

/**
 * Whether this tier has already charged this bill.
 *
 * Once, and once only. A bill is a fixed thing: the ladder expresses
 * escalation over time through *higher tiers* — $10 at 15 days, $25 at
 * 30 — not by charging the same tier again as the same bill ages. So
 * the state of the earlier fee does not matter. Paid, still open, or
 * waived by an operator at the counter, this tier is done with this
 * bill.
 *
 * Going per bill is what let this become so simple. The account-level
 * version had to ask whether the fee was open or reversed, to tell "the
 * account cleared and fell behind again" (charge again) from "a CSR
 * cancelled the action" (do not) — and it got that wrong in both
 * directions before a reviewer caught it. Per bill there is nothing to
 * tell apart: next month's unpaid bill is a different bill and is
 * charged on its own account, and no cancelled action can re-arm a
 * charge on a bill already charged.
 *
 * The partial unique index still does its own job, which is stopping a
 * duplicate *action* within or across sweeps. This stops a duplicate
 * charge.
 */
async function alreadyChargedBill(
  tx: TxClient,
  utilityId: string,
  ruleId: string,
  debitId: string,
): Promise<boolean> {
  const fees = await ladderFeesOnBill(tx, utilityId, debitId, { ruleId });
  return fees.length > 0;
}

/**
 * The fees this ladder raised on one bill, narrowed by how the caller
 * identifies the tier.
 *
 * Two hops rather than a relation filter: `delinquency_action_fee`
 * carries scalar columns only, because its foreign keys are
 * tenant-scoped composites that Prisma cannot express, so there is no
 * relation to filter through. Every query here still carries its own
 * `utility_id`.
 */
async function ladderFeesOnBill(
  tx: TxClient,
  utilityId: string,
  debitId: string,
  by: { ruleId: string } | { accountId: string; belowTier: number; accountType: string | null },
): Promise<Array<{ id: string; openAmount: Prisma.Decimal }>> {
  const actions = await tx.delinquencyAction.findMany({
    where:
      "ruleId" in by
        ? { utilityId, ruleId: by.ruleId }
        : {
            utilityId,
            accountId: by.accountId,
            status: { in: ["PENDING", "COMPLETED"] },
            rule: { tier: { lt: by.belowTier }, accountType: by.accountType },
          },
    select: { id: true },
  });
  if (actions.length === 0) return [];

  const links = await tx.delinquencyActionFee.findMany({
    where: { utilityId, actionId: { in: actions.map((a) => a.id) } },
    select: { entryId: true },
  });
  if (links.length === 0) return [];

  return tx.ledgerEntry.findMany({
    where: { utilityId, id: { in: links.map((l) => l.entryId) }, assessedOnId: debitId },
    select: { id: true, openAmount: true },
  });
}

/**
 * Reverse the fees this ladder raised on **this bill** at lower tiers.
 *
 * Found by walking `delinquency_action_fee`, not by asking what reason a
 * fee cites. That is what keeps a returned-payment fee and a late fee a
 * CSR added by hand out of reach: neither has a delinquency action,
 * whatever the tenant has named its reasons. The question is which fees
 * this ladder owns, and ownership is not a category.
 *
 * Scoped to the bill as well as the tier, so the $25 that supersedes a
 * $10 on one bill leaves another bill's $10 standing. `accountType` has
 * to match or a RESIDENTIAL tier would reach into a COMMERCIAL ladder's
 * fees; those are separate ladders, as the rule's own unique key says.
 */
async function replaceLowerTierFeesOnBill(
  tx: TxClient,
  utilityId: string,
  accountId: string,
  rule: ChargingRule,
  debitId: string,
): Promise<void> {
  const candidates = await ladderFeesOnBill(tx, utilityId, debitId, {
    accountId,
    belowTier: rule.tier,
    accountType: rule.accountType,
  });
  if (candidates.length === 0) return;

  const alreadyReversed = new Set(
    (
      await tx.ledgerEntry.findMany({
        where: { utilityId, reversesId: { in: candidates.map((c) => c.id) } },
        select: { reversesId: true },
      })
    ).map((r) => r.reversesId),
  );

  for (const fee of candidates) {
    /*
     * Already reversed is skipped rather than reversed again, which
     * `reverseEntry` refuses with a 409. Reachable without a race: an
     * operator waives the fee at the counter and a higher tier arrives
     * afterwards. The catch covers the race itself, where a second
     * process reverses between this read and the account lock.
     */
    if (alreadyReversed.has(fee.id)) continue;
    try {
      await reverseEntry(
        utilityId,
        AUTOMATED_ACTOR_ID,
        AUTOMATED_ACTOR_NAME,
        fee.id,
        { memo: `Replaced by ${rule.name}` },
        tx,
      );
    } catch (e) {
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
  feesRaised: number;
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
    select: { id: true, accountId: true, ruleId: true },
  });

  const actionSet = new Set(
    existingActions.map((a) => `${a.accountId}:${a.ruleId}`),
  );

  const now = new Date();
  let actionsCreated = 0;
  let feesRaised = 0;

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

    /*
     * The action pass: what is *done* to the account. One action per
     * tier per account, so three unpaid bills do not mean three
     * tier-one emails.
     */
    const liveActionByRule = new Map<string, string>();
    for (const rule of applicableRules) {
      const key = `${account.id}:${rule.id}`;
      if (actionSet.has(key)) {
        const existing = existingActions.find(
          (a) => a.accountId === account.id && a.ruleId === rule.id,
        );
        if (existing) liveActionByRule.set(rule.id, existing.id);
        continue;
      }

      if (
        account.isProtected &&
        (rule.actionType === "SHUT_OFF_ELIGIBLE" || rule.actionType === "DISCONNECT")
      ) {
        continue;
      }

      let actionId: string | null = null;

      try {
        const action = await prisma.delinquencyAction.create({
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
          },
          select: { id: true },
        });
        actionId = action.id;
      } catch (e) {
        /*
         * Another process created this action between our read of the
         * live set and this insert. `actionSet` cannot see across
         * processes, so the partial unique index is what turns that into
         * a refusal instead of a duplicate; record it as taken and carry
         * on rather than failing the whole tenant's sweep over one
         * account. Nothing has been sent to the customer yet, which is
         * why the notice comes after.
         */
        if (!isDuplicateAction(e)) throw e;
        actionSet.add(key);
        continue;
      }

      liveActionByRule.set(rule.id, actionId);

      /*
       * The notice, after the action and outside any transaction. An
       * external dispatch inside one holds a database lock across
       * someone else's network call, and a notice that fails to send has
       * to leave the action PENDING — which is what that status is for.
       */
      if (rule.notificationEventType) {
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

    /*
     * The charging pass: what is *owed*, one ladder per unpaid bill.
     *
     * Separate from the action pass, and not nested inside it, because a
     * bill can cross a tier's threshold long after that tier's action
     * was filed. Charging inside the action pass meant the second bill
     * was never charged at all: the action already existed, so the tier
     * was skipped entirely.
     *
     * Only tiers with a live action charge, so a tier skipped for a
     * protected account or held back by `autoApply` charges nothing
     * either.
     */
    const chargingRules: ChargingRule[] = [];
    for (const r of applicableRules) {
      if (!r.feeType || !r.feeAmount || !r.feeReasonId) continue;
      if (!liveActionByRule.has(r.id)) continue;
      chargingRules.push({
        id: r.id,
        tier: r.tier,
        name: r.name,
        daysPastDue: r.daysPastDue,
        accountType: r.accountType,
        feeType: r.feeType,
        feeAmount: r.feeAmount,
        maxFee: r.maxFee,
        feeReasonId: r.feeReasonId,
        feeMode: r.feeMode,
      });
    }
    if (chargingRules.length === 0) continue;

    feesRaised += await chargeOverdueBills(
      utilityId,
      account.id,
      chargingRules,
      liveActionByRule,
      now,
    );
  }

  return { accountsEvaluated: accounts.length, actionsCreated, feesRaised };
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

/**
 * Take the account off the ladder.
 *
 * `client` exists so agreeing a payment plan can resolve the account's
 * actions inside the same transaction that writes the plan. The two
 * must not be able to half-happen: a plan with the account still in the
 * shut-off queue is what the `PAYMENT_PLAN` button produced before
 * plans existed, and an account resolved with no plan is worse — the
 * ladder forgets it and nothing suppresses anything.
 *
 * Defaults to `prisma`, so the route caller is unchanged.
 */
export async function resolveAccount(
  utilityId: string,
  accountId: string,
  resolutionType: string,
  notes?: string,
  userId?: string,
  client: TxClient = prisma,
): Promise<number> {
  const now = new Date();

  const pendingActions = await client.delinquencyAction.updateMany({
    where: { utilityId, accountId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: now, resolutionType, notes },
  });

  const latestActive = await client.delinquencyAction.findFirst({
    where: { utilityId, accountId, status: { in: ["COMPLETED", "PENDING"] } },
    orderBy: { tier: "desc" },
  });

  if (latestActive) {
    await client.delinquencyAction.update({
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

