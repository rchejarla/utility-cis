import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 4a — reading an account's ledger for display.
 *
 * The cases here are the ones a screen gets wrong: an account with no
 * entries, a credit balance, an entry that has been reversed, and the
 * difference between what was charged and what is still owed. That last
 * one is the whole point of an open-item ledger and the easiest thing to
 * render as a single number.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtilityId = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let reversal: typeof import("../../services/ar/reversal.service.js");
let fee: typeof import("../../services/ar/fee.service.js");
let ledger: typeof import("../../services/ar/ledger.service.js");

let accountId: string;
let emptyAccountId: string;
let billingCycleId: string;
let lateFeeId: string;
let debitReasonId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  reversal = await import("../../services/ar/reversal.service.js");
  fee = await import("../../services/ar/fee.service.js");
  ledger = await import("../../services/ar/ledger.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "LIST-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
    },
  });
  accountId = account.id;
  const empty = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "LIST-EMPTY",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
    },
  });
  emptyAccountId = empty.id;

  const lateFee = await prisma.ledgerReasonDef.create({
    data: { utilityId, code: "LATE_FEE", label: "Late payment fee", appliesToType: "FEE" },
  });
  lateFeeId = lateFee.id;
  const opening = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: "OPENING_BALANCE",
      label: "Opening balance",
      appliesToType: "ADJUSTMENT_DEBIT",
    },
  });
  debitReasonId = opening.id;
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
  await prisma.account.updateMany({
    where: { utilityId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function debit(amount: string, dueDate = "2026-06-14"): Promise<string> {
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
      reasonId: debitReasonId,
      createdBy: ACTOR,
    },
  });
  await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
  return e.id;
}

async function makeBill(total: string): Promise<string> {
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
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-LIST-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}

describe("listLedger", () => {
  // Review Focus: the common case for a new account.
  it("returns an empty page with a zero balance for an account with no entries", async () => {
    const page = await ledger.listLedger(utilityId, emptyAccountId);
    expect(page.data).toEqual([]);
    expect(page.balance).toBe("0.00");
    expect(page.openCount).toBe(0);
  });

  it("returns newest first with the reason label resolved", async () => {
    await fee.assessFee(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      reasonId: lateFeeId,
      dueDate: "2026-07-14",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data[0]!.type).toBe("FEE");
    expect(page.data[0]!.reasonCode).toBe("LATE_FEE");
    expect(page.data[0]!.reasonLabel).toBe("Late payment fee");
    expect(page.data[0]!.dueDate).toBe("2026-07-14");
    expect(page.balance).toBe("25.00");
    expect(page.openCount).toBe(1);
  });

  // Review Focus: charged versus still owed.
  it("distinguishes a settled entry from a part-settled one", async () => {
    const d = await debit("40.00");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      tender: "CHECK",
    });

    const page = await ledger.listLedger(utilityId, accountId);
    const charge = page.data.find((r) => r.id === d)!;
    expect(charge.amount).toBe("40.00");
    expect(charge.openAmount).toBe("15.00");
    expect(charge.settled).toBe(false);

    const paid = page.data.find((r) => r.type === "PAYMENT")!;
    expect(paid.amount).toBe("-25.00");
    expect(paid.openAmount).toBe("0.00");
    expect(paid.settled).toBe(true);
    expect(paid.tender).toBe("CHECK");
    expect(paid.dueDate).toBeNull();
  });

  // Review Focus: a credit balance.
  it("reports a negative balance when the customer is in credit", async () => {
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "20.00",
      tender: "CARD",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.balance).toBe("-20.00");
    expect(page.data[0]!.openAmount).toBe("-20.00");
    expect(page.openCount).toBe(1);
  });

  it("names the bill an entry came from", async () => {
    const billId = await makeBill("50.0000");
    await posting.postBill(utilityId, ACTOR, "T", billId);
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data[0]!.type).toBe("BILL_CHARGE");
    expect(page.data[0]!.billNumber).toMatch(/^BILL-LIST-/);
    // A bill-derived charge cites no reason; it names its bill instead.
    expect(page.data[0]!.reasonCode).toBeNull();
  });

  // Review Focus: two rows that cancel each other.
  it("links a reversal to what it reversed, in both directions", async () => {
    const pay = await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "10.00",
      tender: "CHECK",
    });
    const rev = await reversal.reverseEntry(utilityId, ACTOR, "T", pay.paymentId, {});

    const page = await ledger.listLedger(utilityId, accountId);
    const original = page.data.find((r) => r.id === pay.paymentId)!;
    const reversalRow = page.data.find((r) => r.id === rev.reversalId)!;
    expect(original.reversedByEntryId).toBe(rev.reversalId);
    expect(original.reversesEntryId).toBeNull();
    expect(reversalRow.reversesEntryId).toBe(pay.paymentId);
    expect(reversalRow.reversedByEntryId).toBeNull();
  });

  it("counts only entries that are still open, across the whole account", async () => {
    await debit("40.00");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      tender: "CHECK",
    });
    const page = await ledger.listLedger(utilityId, accountId);
    expect(page.data).toHaveLength(2);
    expect(page.openCount).toBe(0);
    expect(page.balance).toBe("0.00");
  });

  it("filters to open entries when asked, without changing the balance", async () => {
    await debit("40.00");
    await payment.recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "40.00",
      tender: "CHECK",
    });
    const page = await ledger.listLedger(utilityId, accountId, { openOnly: true });
    expect(page.data).toEqual([]);
    // The header shows what the account owes, not the filtered sum.
    expect(page.balance).toBe("0.00");
  });

  /**
   * A deposit is open for as long as the utility holds it, so counting
   * open items by sign alone made an account owing nothing report
   * "1 open item" — directly beside a header reading "Nothing owed".
   *
   * The count and the filter have to agree, or a header saying three
   * sits over a list of four. Both exclude a deposit; the row itself
   * stays visible in the unfiltered ledger and in `depositHeld`, so
   * nothing becomes unreachable.
   *
   * Taken through `recordDeposit` rather than inserted directly, so the
   * `depositAmount` cache is maintained the way production maintains it
   * — an entry written behind the service's back would leave the column
   * at zero and the assertion below would be testing the fixture.
   */
  it("does not count a deposit as an open item, nor show it among them", async () => {
    const { prisma } = prismaImports;
    const { recordDeposit } = await import("../../services/ar/deposit.service.js");
    const taken = await recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });
    try {
      const all = await ledger.listLedger(utilityId, accountId);
      // Visible, and the utility is holding it.
      expect(all.data.some((e) => e.type === "DEPOSIT")).toBe(true);
      expect(all.depositHeld).toBe("500.00");
      // But it is not something owed, in either place.
      expect(all.openCount).toBe(0);
      expect(all.balance).toBe("0.00");

      const open = await ledger.listLedger(utilityId, accountId, { openOnly: true });
      expect(open.data).toEqual([]);
      expect(open.openCount).toBe(0);
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: taken.entryId } });
      await posting.recomputeAccountCache(prisma, utilityId, accountId);
    }
  });

  it("keeps openCount independent of the page size", async () => {
    for (let i = 0; i < 4; i++) await debit("10.00");
    const page = await ledger.listLedger(utilityId, accountId, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.openCount).toBe(4);
  });

  it("caps the page, so a long history cannot return unbounded", async () => {
    for (let i = 0; i < 5; i++) await debit("1.00");
    expect((await ledger.listLedger(utilityId, accountId, { limit: 3 })).data).toHaveLength(3);
    // A silly limit is clamped rather than honoured.
    expect((await ledger.listLedger(utilityId, accountId, { limit: 99_999 })).data).toHaveLength(5);
    expect((await ledger.listLedger(utilityId, accountId, { limit: 0 })).data).toHaveLength(1);
  });

  it("never returns another tenant's entries", async () => {
    const { prisma } = prismaImports;
    const otherCycle = await prisma.billingCycle.create({
      data: {
        utilityId: otherUtilityId,
        name: "R1",
        cycleCode: "R01",
        billDayOfMonth: 15,
        frequency: "MONTHLY",
      },
    });
    const otherAccount = await prisma.account.create({
      data: {
        utilityId: otherUtilityId,
        accountNumber: "LIST-OTHER",
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: otherCycle.id,
      },
    });
    const otherReason = await prisma.ledgerReasonDef.create({
      data: {
        utilityId: otherUtilityId,
        code: "OPENING_BALANCE",
        label: "Opening",
        appliesToType: "ADJUSTMENT_DEBIT",
      },
    });
    const stray = await prisma.ledgerEntry.create({
      data: {
        utilityId: otherUtilityId,
        accountId: otherAccount.id,
        type: "ADJUSTMENT_DEBIT",
        amount: "90.00",
        openAmount: "90.00",
        dueDate: new Date("2026-06-14"),
        effectiveDate: new Date("2026-06-14"),
        reasonId: otherReason.id,
      },
    });

    try {
      await debit("10.00");
      const page = await ledger.listLedger(utilityId, accountId);
      expect(page.data.map((r) => r.id)).not.toContain(stray.id);
      expect(page.data).toHaveLength(1);
      // And asking for the other tenant's account as this tenant is a 404.
      await expect(
        ledger.listLedger(utilityId, otherAccount.id),
      ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: stray.id } });
      await prisma.ledgerReasonDef.delete({ where: { id: otherReason.id } });
      await prisma.account.delete({ where: { id: otherAccount.id } });
      await prisma.billingCycle.delete({ where: { id: otherCycle.id } });
    }
  });

  it("refuses an unknown account", async () => {
    await expect(
      ledger.listLedger(utilityId, "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", statusCode: 404 });
  });
});
