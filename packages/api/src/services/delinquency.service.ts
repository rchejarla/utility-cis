import { prisma } from "../lib/prisma.js";
import { sendNotification } from "./notification.service.js";

/**
 * Delinquency evaluation engine. The nightly job calls evaluateAll()
 * which walks every account with a positive balance and applies the
 * tenant's delinquency rules tier by tier.
 */

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

    const applicableRules = rules.filter((r) => {
      if (r.accountType && r.accountType !== account.accountType) return false;
      if (r.daysPastDue > daysPastDue) return false;
      if (Number(r.minBalance) > balance) return false;
      if (!r.autoApply) return false;
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

      let notificationId: string | null = null;
      if (rule.notificationEventType) {
        const channel =
          rule.actionType === "NOTICE_SMS" ? "SMS" as const : "EMAIL" as const;
        notificationId = await sendNotification(utilityId, {
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
      }

      await prisma.delinquencyAction.create({
        data: {
          utilityId,
          accountId: account.id,
          ruleId: rule.id,
          tier: rule.tier,
          actionType: rule.actionType,
          status: notificationId ? "COMPLETED" : "PENDING",
          balanceAtAction: balance,
          daysPastDueAtAction: daysPastDue,
          triggeredBy: "AUTOMATED",
          notificationId,
        },
      });

      actionSet.add(key);
      actionsCreated++;
    }
  }

  return { accountsEvaluated: accounts.length, actionsCreated };
}

/**
 * Wrapper around `evaluateAll` for the BullMQ-worker entry point. On
 * success, updates `tenant_config.delinquencyLastRunAt` so the
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
  await prisma.tenantConfig.update({
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

