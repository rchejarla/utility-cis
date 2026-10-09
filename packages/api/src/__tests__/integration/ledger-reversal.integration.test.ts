import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 2 — reversing a posted entry (§6.6).
 *
 * A correction is a new entry, never an edit, because amount, type and
 * the dates are immutable once posted (§5). The cases below pin the part
 * the spec leaves open: what happens to the reversed entry's own
 * openAmount. Leaving it open keeps the balance right while leaving a
 * bounced payment available for allocation to spend again, so the
 * reversal is applied against it and both land on zero.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let reversal: typeof import("../../services/ar/reversal.service.js");

let accountId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  reversal = await import("../../services/ar/reversal.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "REV-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function debit(amount: string, dueDate: string): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "ADJUSTMENT_DEBIT",
      amount,
      openAmount: amount,
      dueDate: new Date(dueDate),
      effectiveDate: new Date(dueDate),
      createdBy: ACTOR,
    },
  });
  await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
  return e.id;
}

async function openOf(id: string): Promise<string> {
  const { prisma } = prismaImports;
  const e = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id } });
  return e.openAmount.toFixed(2);
}

describe("reverseEntry", () => {
  // Review Focus: restore exactly what was consumed, no more.
  it("restores a partially applied payment and leaves no reusable credit", async () => {
    const { prisma } = prismaImports;
    const d = await debit("100.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      tender: "CHECK",
    });
    expect(await openOf(d)).toBe("60.00");

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});

    // The 40.00 it consumed comes back on the debit — and only that.
    expect(await openOf(d)).toBe("100.00");
    expect(res.restored).toEqual([{ entryId: d, openAmount: "100.00" }]);
    // The bounced payment is closed, not left open for allocation to spend.
    expect(await openOf(pay.paymentId)).toBe("0.00");
    expect(await openOf(res.reversalId)).toBe("0.00");
    expect(res.balance).toBe("100.00");

    const rev = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.reversalId } });
    expect(rev.type).toBe("REVERSAL");
    expect(rev.amount.toFixed(2)).toBe("40.00");
    expect(rev.reversesId).toBe(pay.paymentId);

    // The application it undid is gone, replaced by the settling one.
    const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
    expect(apps).toHaveLength(1);
    expect(apps[0]!.creditId).toBe(pay.paymentId);
    expect(apps[0]!.debitId).toBe(res.reversalId);
    expect(apps[0]!.amount.toFixed(2)).toBe("40.00");
  });

  it("reversing a charge that was partly paid leaves the payment as a credit", async () => {
    const d = await debit("100.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "30.00",
      tender: "CHECK",
    });

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", d, {});

    expect(await openOf(d)).toBe("0.00");
    expect(await openOf(res.reversalId)).toBe("0.00");
    // They paid 30 toward a charge that no longer exists: a refund due.
    expect(await openOf(pay.paymentId)).toBe("-30.00");
    expect(res.balance).toBe("-30.00");
    expect(res.amount).toBe("-100.00");
  });

  it("reverses an unapplied payment with nothing to restore", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    expect(res.restored).toEqual([]);
    expect(res.balance).toBe("0.00");
    expect(await openOf(pay.paymentId)).toBe("0.00");
    expect(await openOf(res.reversalId)).toBe("0.00");
  });

  it("restores every debit a payment was spread across", async () => {
    const a = await debit("30.00", "2026-05-14");
    const b = await debit("30.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "45.00",
      tender: "CHECK",
    });
    expect(await openOf(a)).toBe("0.00");
    expect(await openOf(b)).toBe("15.00");

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});

    expect(await openOf(a)).toBe("30.00");
    expect(await openOf(b)).toBe("30.00");
    expect(res.restored).toHaveLength(2);
    expect(res.balance).toBe("60.00");
  });

  // Review Focus: both refusals.
  it("refuses to reverse the same entry twice", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      tender: "CASH",
    });
    await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    await expect(
      reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {}),
    ).rejects.toMatchObject({ code: "ENTRY_ALREADY_REVERSED" });
  });

  it("refuses to reverse a REVERSAL", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    await expect(
      reversal.reverseEntry(utilityId, ACTOR, "T", res.reversalId, {}),
    ).rejects.toMatchObject({ code: "CANNOT_REVERSE_REVERSAL" });
  });

  it("reports dependent fees without reversing them", async () => {
    const { prisma } = prismaImports;
    const charge = await debit("100.00", "2026-06-14");
    const fee = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "FEE",
        amount: "15.00",
        openAmount: "15.00",
        dueDate: new Date("2026-07-14"),
        effectiveDate: new Date("2026-06-20"),
        assessedOnId: charge,
        createdBy: ACTOR,
      },
    });

    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", charge, {});

    expect(res.dependentFees).toEqual([{ id: fee.id, amount: "15.00", dueDate: "2026-07-14" }]);
    // Reported, not reversed — §6.6 is explicit that this is a human call.
    const stillThere = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: fee.id } });
    expect(stillThere.openAmount.toFixed(2)).toBe("15.00");
    expect(await prisma.ledgerEntry.count({ where: { reversesId: fee.id } })).toBe(0);
    // The fee still stands, so it is still owed.
    expect(res.balance).toBe("15.00");
  });

  it("refuses an unknown entry and an entry in another tenant", async () => {
    await expect(
      reversal.reverseEntry(
        utilityId,
        ACTOR,
        "T",
        "00000000-0000-4000-8000-00000000dead",
        {},
      ),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });

    const mine = await debit("10.00", "2026-06-14");
    await expect(
      reversal.reverseEntry("00000000-0000-4000-8000-0000000000bb", ACTOR, "T", mine, {}),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
  });

  it("records the reason and memo when given", async () => {
    const { prisma } = prismaImports;
    const reasonId = "00000000-0000-4000-8000-00000000aa01";
    await prisma.ledgerReasonDef.create({
      data: {
        id: reasonId,
        utilityId,
        code: "NSF",
        label: "Returned unpaid",
        appliesToType: "REVERSAL",
      },
    });
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00",
      tender: "CHECK",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {
      reasonId,
      memo: "cheque returned",
    });
    const rev = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.reversalId } });
    expect(rev.reasonId).toBe(reasonId);
    expect(rev.memo).toBe("cheque returned");
  });

  it("writes one audit row for the reversal", async () => {
    const { prisma } = prismaImports;
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00",
      tender: "CASH",
    });
    const res = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerEntry", entityId: res.reversalId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");
  });

  it("leaves nothing behind when the caller's transaction rolls back", async () => {
    const { prisma } = prismaImports;
    const d = await debit("100.00", "2026-06-14");
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      tender: "CHECK",
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {}, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The application it would have deleted is still there.
    expect(await openOf(d)).toBe("60.00");
    expect(await prisma.ledgerApplication.count({ where: { creditId: pay.paymentId } })).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { type: "REVERSAL" } })).toBe(0);
  });
});
