import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The tenant-wide receipts list — `GET /api/v1/receipts` / `listReceipts`.
 *
 * It exists to answer "what did we take, and does it match the bank
 * slip", which no screen could answer before because every view of money
 * received was scoped to one account.
 *
 * The decisions worth pinning:
 *   1. A receipt is money that ARRIVED, so PAYMENT and DEPOSIT are both
 *      in scope. A security deposit taken at the counter is in the till
 *      and will be in the bank deposit; omitting it would under-report
 *      the day and look complete doing so.
 *   2. Amounts come back POSITIVE. Money received is stored negative
 *      because it is a credit; this list is read by someone counting cash.
 *   3. `totalReceived` covers the whole filter, not the page. A daily
 *      total that stopped at the page boundary would be wrong silently.
 *   4. `subtotals` splits the same money by kind, with every type
 *      spelled out — "no deposits today" is an answer, a missing key is
 *      a question about whether the query ran.
 *   5. Reversed payments stay IN the total. Monday's deposit contained a
 *      cheque that bounced on Wednesday; netting it out of Monday would
 *      stop the figure agreeing with the bank.
 *   6. `from`/`to` bound the day the money was taken, not the day the
 *      row was written.
 */

const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtility = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let receipts: typeof import("../../services/ar/payment.service.js");

let accountId: string;
let otherAccountId: string;

const Q = { page: 1, limit: 25, sort: "effectiveDate" as const, order: "desc" as const };

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  receipts = await import("../../services/ar/payment.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Ada", lastName: "Lovelace" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "PAY-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
      customerId: customer.id,
    },
  });
  accountId = account.id;

  const otherCycle = await prisma.billingCycle.create({
    data: { utilityId: otherUtility, name: "X", cycleCode: "X01", billDayOfMonth: 1, frequency: "MONTHLY" },
  });
  const otherAccount = await prisma.account.create({
    data: {
      utilityId: otherUtility,
      accountNumber: "OTHER-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: otherCycle.id,
    },
  });
  otherAccountId = otherAccount.id;

  await pay({ amount: "40.00", on: "2026-06-01", tender: "CASH", ref: "DRAWER-1" });
  await pay({ amount: "25.50", on: "2026-06-01", tender: "CHECK", ref: "CHQ-8841" });
  await pay({ amount: "10.00", on: "2026-06-02", tender: "CARD", ref: "TXN-999" });
  await pay({ amount: "500.00", on: "2026-06-01", tender: "CASH", utility: otherUtility });
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

async function pay(o: {
  amount: string;
  on: string;
  tender: "CASH" | "CHECK" | "CARD" | "ACH" | "LOCKBOX";
  ref?: string;
  utility?: string;
}): Promise<string> {
  const { prisma } = prismaImports;
  const u = o.utility ?? utilityId;
  const entry = await prisma.ledgerEntry.create({
    data: {
      utilityId: u,
      accountId: u === utilityId ? accountId : otherAccountId,
      type: "PAYMENT",
      // Stored negative: a payment is a credit.
      amount: `-${o.amount}`,
      openAmount: "0.00",
      dueDate: null,
      effectiveDate: new Date(o.on),
      tender: o.tender,
      externalRef: o.ref ?? null,
    },
  });
  return entry.id;
}

/**
 * A security deposit, written the way `recordDeposit` writes one: a
 * credit that stays OPEN, because the utility holds it until the account
 * closes or the customer earns it back.
 */
async function deposit(o: {
  amount: string;
  on: string;
  tender?: "CASH" | "CHECK" | "CARD" | "ACH" | "LOCKBOX";
  ref?: string;
}): Promise<string> {
  const { prisma } = prismaImports;
  const entry = await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "DEPOSIT",
      amount: `-${o.amount}`,
      openAmount: `-${o.amount}`,
      dueDate: null,
      effectiveDate: new Date(o.on),
      tender: o.tender ?? null,
      externalRef: o.ref ?? null,
    },
  });
  return entry.id;
}

const refs = (p: { data: { externalRef: string | null }[] }) => p.data.map((r) => r.externalRef);

describe("listReceipts", () => {
  it("returns amounts as positive figures", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, search: "CHQ-8841" });
    // Stored as -25.50; a receipts list is read by someone counting cash.
    expect(res.data[0]!.amount).toBe("25.50");
  });

  it("totals the whole filter, not just the page", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, limit: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.meta.total).toBe(3);
    // 40.00 + 25.50 + 10.00 across all three, despite one row on screen.
    expect(res.totalReceived).toBe("75.50");
  });

  it("totals one day's takings, for tying out against a bank deposit", async () => {
    const res = await receipts.listReceipts(utilityId, {
      ...Q,
      from: "2026-06-01",
      to: "2026-06-01",
    });
    expect(res.totalReceived).toBe("65.50");
    expect(res.meta.total).toBe(2);
  });

  it("treats `to` as inclusive of that day", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, from: "2026-06-02", to: "2026-06-02" });
    expect(refs(res)).toEqual(["TXN-999"]);
  });

  /**
   * The reason this list is not called "payments".
   *
   * A deposit taken at the counter goes into the same till and onto the
   * same bank slip as a cheque settling a bill. A total that left it out
   * would be short by exactly the deposit — and would look like a
   * complete day's takings while being wrong.
   */
  it("counts a deposit in the day's takings, because it is on the same bank slip", async () => {
    const { prisma } = prismaImports;
    const id = await deposit({ amount: "750.00", on: "2026-06-02", tender: "CASH", ref: "DEP-1" });
    try {
      const res = await receipts.listReceipts(utilityId, {
        ...Q,
        from: "2026-06-02",
        to: "2026-06-02",
      });
      expect(res.meta.total).toBe(2);
      // 10.00 of payment plus the 750.00 deposit, as the bank saw it.
      expect(res.totalReceived).toBe("760.00");
      expect(res.subtotals).toEqual({ PAYMENT: "10.00", DEPOSIT: "750.00" });
    } finally {
      await prisma.ledgerEntry.delete({ where: { id } });
    }
  });

  it("says which kind each receipt is, so a deposit is not read as a bill paid", async () => {
    const { prisma } = prismaImports;
    const id = await deposit({ amount: "750.00", on: "2026-06-02", tender: "CASH", ref: "DEP-1" });
    try {
      const res = await receipts.listReceipts(utilityId, { ...Q, search: "DEP-1" });
      expect(res.data[0]!.type).toBe("DEPOSIT");
      const paid = await receipts.listReceipts(utilityId, { ...Q, search: "TXN-999" });
      expect(paid.data[0]!.type).toBe("PAYMENT");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id } });
    }
  });

  it("narrows to one kind on request", async () => {
    const { prisma } = prismaImports;
    const id = await deposit({ amount: "750.00", on: "2026-06-02", tender: "CASH", ref: "DEP-1" });
    const day = { ...Q, from: "2026-06-02", to: "2026-06-02" };
    try {
      const onlyPayments = await receipts.listReceipts(utilityId, { ...day, type: "PAYMENT" });
      expect(refs(onlyPayments)).toEqual(["TXN-999"]);
      expect(onlyPayments.totalReceived).toBe("10.00");

      const onlyDeposits = await receipts.listReceipts(utilityId, { ...day, type: "DEPOSIT" });
      expect(refs(onlyDeposits)).toEqual(["DEP-1"]);
      expect(onlyDeposits.totalReceived).toBe("750.00");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id } });
    }
  });

  /**
   * A day with no deposits must SAY so. An absent key and a genuine zero
   * read identically to a person and mean different things — the same
   * reason the reconciliation report carries `checked`.
   */
  it("spells out a kind that took nothing, rather than omitting it", async () => {
    const res = await receipts.listReceipts(utilityId, Q);
    expect(res.subtotals).toEqual({ PAYMENT: "75.50", DEPOSIT: "0.00" });
  });

  it("keeps a reversed payment in the day's total, and marks the row", async () => {
    const { prisma } = prismaImports;
    const id = await pay({ amount: "90.00", on: "2026-06-03", tender: "CHECK", ref: "CHQ-BOUNCE" });
    const rev = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "REVERSAL",
        amount: "90.00",
        openAmount: "0.00",
        // Bounced two days later. The money WAS in the 3rd's deposit.
        effectiveDate: new Date("2026-06-05"),
        reversesId: id,
      },
    });
    try {
      const res = await receipts.listReceipts(utilityId, {
        ...Q,
        from: "2026-06-03",
        to: "2026-06-03",
      });
      expect(res.totalReceived).toBe("90.00");
      expect(res.data[0]!.reversed).toBe(true);
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: rev.id } });
      await prisma.ledgerEntry.delete({ where: { id } });
    }
  });

  it("filters by tender", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, tender: "CASH" });
    expect(refs(res)).toEqual(["DRAWER-1"]);
    expect(res.totalReceived).toBe("40.00");
  });

  it("finds a receipt by its external reference", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, search: "chq" });
    expect(refs(res)).toEqual(["CHQ-8841"]);
  });

  it("returns the account number and customer name, not just ids", async () => {
    const res = await receipts.listReceipts(utilityId, { ...Q, search: "DRAWER-1" });
    expect(res.data[0]!.account.accountNumber).toBe("PAY-001");
    expect(res.data[0]!.account.customerName).toBe("Ada Lovelace");
  });

  it("lists only money received — not charges, fees or reversals", async () => {
    const { prisma } = prismaImports;
    // A FEE must cite a reason -- the ledger_entry_reason_required CHECK
    // added in slice 3.
    const reason = await prisma.ledgerReasonDef.create({
      data: { utilityId, code: "LATE_FEE_PL", label: "Late fee", appliesToType: "FEE" },
    });
    const fee = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "FEE",
        amount: "15.00",
        openAmount: "15.00",
        dueDate: new Date("2026-07-01"),
        effectiveDate: new Date("2026-06-01"),
        reasonId: reason.id,
      },
    });
    try {
      const res = await receipts.listReceipts(utilityId, { ...Q, from: "2026-06-01", to: "2026-06-01" });
      // The fee shares the day but is money owed, not money taken.
      expect(res.meta.total).toBe(2);
      expect(res.totalReceived).toBe("65.50");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: fee.id } });
      await prisma.ledgerReasonDef.delete({ where: { id: reason.id } });
    }
  });

  it("never returns another utility's receipts, nor counts them in the total", async () => {
    const res = await receipts.listReceipts(utilityId, Q);
    expect(res.meta.total).toBe(3);
    expect(res.totalReceived).toBe("75.50");

    const theirs = await receipts.listReceipts(otherUtility, Q);
    expect(theirs.meta.total).toBe(1);
    expect(theirs.totalReceived).toBe("500.00");
  });
});
