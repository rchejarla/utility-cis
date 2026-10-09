import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Where days-past-due comes from, now that AR writes the cache.
 *
 * `Account.lastDueDate` used to mean "most recent invoice due date".
 * Since AR slice 1 it holds the **oldest open debit's** due date, which
 * is what dunning actually needs: an account with a six-month-old unpaid
 * bill and a current one is six months delinquent, not current. The
 * delinquency engine reads the column unchanged
 * (`delinquency.service.ts` :52 and :202), so this is the test that the
 * two halves agree.
 *
 * Without it the redefinition is a silent behaviour change in
 * money-adjacent code: the same account escalates to a higher tier than
 * it used to, and nothing fails.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let delinquency: typeof import("../../services/delinquency.service.js");

let accountId: string;
let ruleId: string;
let debitReasonId: string;

/** UTC midnight n days back, so `floor((now - d) / 1 day)` is exactly n. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  delinquency = await import("../../services/delinquency.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "AGING-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;

  // One tier, firing at 30 days past due. notificationEventType null so
  // evaluateAll takes no notification path — this test is about the
  // number it computes, not about delivery.
  const rule = await prisma.delinquencyRule.create({
    data: {
      utilityId,
      name: "Past Due Notice",
      tier: 1,
      daysPastDue: 30,
      minBalance: "25.00",
      actionType: "NOTICE_EMAIL",
      notificationEventType: null,
      autoApply: true,
      effectiveDate: new Date("2025-01-01"),
    },
  });
  ruleId = rule.id;

  // Slice 3's ledger_entry_reason_required.
  const reason = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: "AGING-FIXTURE",
      label: "Aging suite fixture",
      appliesToType: "ADJUSTMENT_DEBIT",
    },
  });
  debitReasonId = reason.id;
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.delinquencyAction.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
});

/** An open debit on the account, due `n` days ago. */
async function openDebit(amount: string, dueDaysAgo: number) {
  const { prisma } = prismaImports;
  await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "ADJUSTMENT_DEBIT",
      amount,
      openAmount: amount,
      dueDate: daysAgo(dueDaysAgo),
      effectiveDate: daysAgo(dueDaysAgo),
      reasonId: debitReasonId,
      createdBy: ACTOR,
    },
  });
}

describe("delinquency days-past-due, against the AR cache", () => {
  it("ages from the older of two open debits, not the newer", async () => {
    const { prisma } = prismaImports;
    await openDebit("120.00", 100);
    await openDebit("40.00", 5);
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("160.00");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe(
      daysAgo(100).toISOString().slice(0, 10),
    );

    // The tier fires at 30 days. Read off the newer debit the account
    // would be 5 days past due and this rule would not apply at all.
    const result = await delinquency.evaluateAll(utilityId);
    expect(result.accountsEvaluated).toBe(1);
    expect(result.actionsCreated).toBe(1);

    const action = await prisma.delinquencyAction.findFirstOrThrow({ where: { accountId } });
    expect(action.ruleId).toBe(ruleId);
    expect(action.daysPastDueAtAction).toBe(100);
    expect(action.balanceAtAction.toFixed(2)).toBe("160.00");
  });

  it("stops ageing the account once the older debit is settled", async () => {
    const { prisma } = prismaImports;
    await openDebit("120.00", 100);
    await openDebit("40.00", 5);

    // Settle the older one by hand — slice 2 owns payment allocation.
    const older = await prisma.ledgerEntry.findFirstOrThrow({
      where: { accountId, amount: "120.00" },
    });
    await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.update({ where: { id: older.id }, data: { openAmount: "0.00" } });
      await tx.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "PAYMENT",
          amount: "-120.00",
          openAmount: "0.00",
          effectiveDate: daysAgo(1),
          tender: "CHECK",
        },
      });
      await posting.recomputeAccountCache(tx, utilityId, accountId);
    });

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("40.00");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe(
      daysAgo(5).toISOString().slice(0, 10),
    );

    // 5 days past due, below the tier's 30 — no action.
    const result = await delinquency.evaluateAll(utilityId);
    expect(result.actionsCreated).toBe(0);
  });
});
