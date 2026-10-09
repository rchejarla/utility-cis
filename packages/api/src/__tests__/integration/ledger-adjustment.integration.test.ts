import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 3 — manual charges, waivers and write-offs (§6.5).
 *
 * §3.5 is the rule these tests defend: three distinct acts, and
 * collapsing them loses billing accuracy, concessions and bad debt as
 * separately reportable facts. The charge was wrong -> reverse it. The
 * charge was right and we forgive it -> ADJUSTMENT_CREDIT. The charge
 * was right and uncollectable -> WRITE_OFF. Nothing here touches
 * bill.total: the bill stands as issued and the receivable is reduced.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let adjustment: typeof import("../../services/ar/adjustment.service.js");

let accountId: string;
let otherAccountId: string;
let billingCycleId: string;
let debitReasonId: string;
let creditReasonId: string;
let writeOffReasonId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  adjustment = await import("../../services/ar/adjustment.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "ADJ-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
    },
  });
  accountId = account.id;
  const other = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "ADJ-OTHER",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
    },
  });
  otherAccountId = other.id;

  for (const [code, appliesToType] of [
    ["OPENING_BALANCE", "ADJUSTMENT_DEBIT"],
    ["COURTESY_WAIVER", "ADJUSTMENT_CREDIT"],
    ["BAD_DEBT", "WRITE_OFF"],
  ] as const) {
    const r = await prisma.ledgerReasonDef.create({
      data: { utilityId, code, label: code, appliesToType },
    });
    if (appliesToType === "ADJUSTMENT_DEBIT") debitReasonId = r.id;
    else if (appliesToType === "ADJUSTMENT_CREDIT") creditReasonId = r.id;
    else writeOffReasonId = r.id;
  }
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.account.updateMany({
    where: { utilityId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function debit(amount: string, dueDate: string, forAccount = accountId): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId: forAccount,
      type: "ADJUSTMENT_DEBIT",
      amount,
      openAmount: amount,
      dueDate: new Date(dueDate),
      effectiveDate: new Date(dueDate),
      reasonId: debitReasonId,
      createdBy: ACTOR,
    },
  });
  await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, forAccount));
  return e.id;
}

async function openOf(id: string): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id } });
  return e.openAmount.toFixed(2);
}

describe("waive", () => {
  it("closes the nominated debit when the amounts match", async () => {
    const d = await debit("40.00", "2026-06-14");
    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      reasonId: creditReasonId,
      debitId: d,
    });

    expect(res.amount).toBe("-40.00");
    expect(res.applied).toHaveLength(1);
    expect(res.unapplied).toBe("0.00");
    expect(await openOf(d)).toBe("0.00");
    expect(await openOf(res.entryId)).toBe("0.00");
    expect(res.balance).toBe("0.00");

    const { prisma } = prismaImports;
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.type).toBe("ADJUSTMENT_CREDIT");
    expect(entry.reasonId).toBe(creditReasonId);
    // A credit has nothing to fall due.
    expect(entry.dueDate).toBeNull();
  });

  it("waives part of a debit, leaving the rest owed", async () => {
    const d = await debit("40.00", "2026-06-14");
    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "15.00",
      reasonId: creditReasonId,
      debitId: d,
    });
    expect(await openOf(d)).toBe("25.00");
    expect(res.unapplied).toBe("0.00");
    expect(res.balance).toBe("25.00");
  });

  // Review Focus: the excess is a refund due and must NOT spill.
  it("leaves the excess open as a refund due and does not touch other debits", async () => {
    const small = await debit("10.00", "2026-06-14");
    const older = await debit("50.00", "2026-05-14"); // would be next in line

    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "30.00",
      reasonId: creditReasonId,
      debitId: small,
    });

    expect(await openOf(small)).toBe("0.00");
    expect(await openOf(older)).toBe("50.00"); // untouched
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]!.amount).toBe("10.00");
    expect(res.unapplied).toBe("20.00");
    expect(await openOf(res.entryId)).toBe("-20.00");
    expect(res.balance).toBe("30.00"); // 50 owed − 20 credit
  });

  it("waives an already-paid charge, leaving a full credit", async () => {
    const d = await debit("20.00", "2026-06-14");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "20.00",
      tender: "CHECK",
    });
    expect(await openOf(d)).toBe("0.00");

    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "20.00",
      reasonId: creditReasonId,
      debitId: d,
    });
    expect(res.applied).toEqual([]);
    expect(res.unapplied).toBe("20.00");
    expect(res.balance).toBe("-20.00"); // a refund due
  });

  it("does not touch bill.total — the bill stands as issued", async () => {
    const { prisma } = prismaImports;
    const bill = await prisma.bill.create({
      data: {
        utilityId,
        accountId,
        billingCycleId,
        periodStart: new Date("2026-04-16"),
        periodEnd: new Date("2026-05-15"),
        billDate: new Date("2026-05-15"),
        dueDate: new Date("2026-06-14"),
        subtotal: "60.0000",
        taxes: "0",
        credits: "0",
        total: "60.0000",
        billNumber: `ADJ-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    const posted = await posting.postBill(utilityId, ACTOR, "T", bill.id);

    await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "60.00",
      reasonId: creditReasonId,
      debitId: posted.entryId!,
    });

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(after.total.toFixed(4)).toBe("60.0000");
    expect(await openOf(posted.entryId!)).toBe("0.00");
  });

  it("refuses a WRITE_OFF reason — a concession is not a bad debt", async () => {
    const d = await debit("10.00", "2026-06-14");
    await expect(
      adjustment.waive(utilityId, ACTOR, "T", accountId, {
        amount: "10.00",
        reasonId: writeOffReasonId,
        debitId: d,
      }),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH", statusCode: 422 });
    expect(await openOf(d)).toBe("10.00");
  });

  it("refuses a debit in another account", async () => {
    const stray = await debit("10.00", "2026-06-14", otherAccountId);
    await expect(
      adjustment.waive(utilityId, ACTOR, "T", accountId, {
        amount: "10.00",
        reasonId: creditReasonId,
        debitId: stray,
      }),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
    expect(await openOf(stray)).toBe("10.00");
  });

  it("refuses to be applied to a credit entry", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00",
      tender: "CASH",
    });
    await expect(
      adjustment.waive(utilityId, ACTOR, "T", accountId, {
        amount: "5.00",
        reasonId: creditReasonId,
        debitId: pay.paymentId,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_DEBIT", statusCode: 422 });
  });

  it("writes one audit row", async () => {
    const { prisma } = prismaImports;
    const d = await debit("10.00", "2026-06-14");
    const res = await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "10.00",
      reasonId: creditReasonId,
      debitId: d,
    });
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerEntry", entityId: res.entryId },
    });
    expect(audits).toHaveLength(1);
  });
});

describe("writeOff", () => {
  it("posts a WRITE_OFF, which is a different fact from a waiver", async () => {
    const { prisma } = prismaImports;
    const d = await debit("40.00", "2026-06-14");
    const res = await adjustment.writeOff(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      reasonId: writeOffReasonId,
      debitId: d,
    });
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.type).toBe("WRITE_OFF");
    expect(entry.reasonId).toBe(writeOffReasonId);
    expect(await openOf(d)).toBe("0.00");
    expect(res.balance).toBe("0.00");
  });

  it("refuses an ADJUSTMENT_CREDIT reason — a bad debt is not a concession", async () => {
    const d = await debit("10.00", "2026-06-14");
    await expect(
      adjustment.writeOff(utilityId, ACTOR, "T", accountId, {
        amount: "10.00",
        reasonId: creditReasonId,
        debitId: d,
      }),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH" });
  });

  // The two acts are reportable separately, which is the whole point.
  it("is distinguishable from a waiver in the ledger", async () => {
    const { prisma } = prismaImports;
    const a = await debit("10.00", "2026-06-14");
    const b = await debit("10.00", "2026-06-15");
    await adjustment.waive(utilityId, ACTOR, "T", accountId, {
      amount: "10.00", reasonId: creditReasonId, debitId: a,
    });
    await adjustment.writeOff(utilityId, ACTOR, "T", accountId, {
      amount: "10.00", reasonId: writeOffReasonId, debitId: b,
    });

    const concessions = await prisma.ledgerEntry.count({
      where: { utilityId, type: "ADJUSTMENT_CREDIT" },
    });
    const badDebt = await prisma.ledgerEntry.count({ where: { utilityId, type: "WRITE_OFF" } });
    expect(concessions).toBe(1);
    expect(badDebt).toBe(1);
  });
});

describe("adjustDebit", () => {
  it("posts a positive ADJUSTMENT_DEBIT that ages", async () => {
    const { prisma } = prismaImports;
    const res = await adjustment.adjustDebit(utilityId, ACTOR, "T", accountId, {
      amount: "75.00",
      reasonId: debitReasonId,
      dueDate: "2026-08-01",
    });
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.type).toBe("ADJUSTMENT_DEBIT");
    expect(entry.amount.toFixed(2)).toBe("75.00");
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(res.amount).toBe("75.00");
    expect(res.balance).toBe("75.00");

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("defaults dueDate to 30 days after the effective date", async () => {
    const { prisma } = prismaImports;
    const res = await adjustment.adjustDebit(utilityId, ACTOR, "T", accountId, {
      amount: "20.00",
      reasonId: debitReasonId,
      effectiveDate: "2026-06-01",
    });
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.effectiveDate.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-07-01");
  });

  it("absorbs an open credit, like any new debit", async () => {
    const { prisma } = prismaImports;
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "PAYMENT",
        amount: "-20.00",
        openAmount: "-20.00",
        effectiveDate: new Date("2026-05-01"),
        tender: "CHECK",
        createdBy: ACTOR,
      },
    });
    const res = await adjustment.adjustDebit(utilityId, ACTOR, "T", accountId, {
      amount: "50.00",
      reasonId: debitReasonId,
    });
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]!.amount).toBe("20.00");
    expect(res.balance).toBe("30.00");
  });

  it("refuses a credit reason", async () => {
    await expect(
      adjustment.adjustDebit(utilityId, ACTOR, "T", accountId, {
        amount: "10.00",
        reasonId: creditReasonId,
      }),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH" });
  });

  it("refuses an unknown account", async () => {
    await expect(
      adjustment.adjustDebit(utilityId, ACTOR, "T", "00000000-0000-4000-8000-00000000dead", {
        amount: "10.00",
        reasonId: debitReasonId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});
