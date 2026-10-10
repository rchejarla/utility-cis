import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The tenant-wide payments list — `GET /api/v1/payments` / `listPayments`.
 *
 * It exists to answer "what did we take, and does it match the deposit",
 * which no screen could answer before because every payment view was
 * scoped to one account.
 *
 * The decisions worth pinning:
 *   1. Amounts come back POSITIVE. A payment is stored negative because
 *      it is a credit; a receipts list is read by someone counting cash.
 *   2. `totalReceived` covers the whole filter, not the page. A daily
 *      total that stopped at the page boundary would be wrong silently.
 *   3. Reversed payments stay IN the total. Monday's deposit contained a
 *      cheque that bounced on Wednesday; netting it out of Monday would
 *      stop the figure agreeing with the bank.
 *   4. `from`/`to` bound the day the money was taken, not the day the
 *      row was written.
 */

const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtility = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let payments: typeof import("../../services/ar/payment.service.js");

let accountId: string;
let otherAccountId: string;

const Q = { page: 1, limit: 25, sort: "effectiveDate" as const, order: "desc" as const };

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  payments = await import("../../services/ar/payment.service.js");

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

const refs = (p: { data: { externalRef: string | null }[] }) => p.data.map((r) => r.externalRef);

describe("listPayments", () => {
  it("returns amounts as positive figures", async () => {
    const res = await payments.listPayments(utilityId, { ...Q, search: "CHQ-8841" });
    // Stored as -25.50; a receipts list is read by someone counting cash.
    expect(res.data[0]!.amount).toBe("25.50");
  });

  it("totals the whole filter, not just the page", async () => {
    const res = await payments.listPayments(utilityId, { ...Q, limit: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.meta.total).toBe(3);
    // 40.00 + 25.50 + 10.00 across all three, despite one row on screen.
    expect(res.totalReceived).toBe("75.50");
  });

  it("totals one day's takings, for tying out against a deposit", async () => {
    const res = await payments.listPayments(utilityId, {
      ...Q,
      from: "2026-06-01",
      to: "2026-06-01",
    });
    expect(res.totalReceived).toBe("65.50");
    expect(res.meta.total).toBe(2);
  });

  it("treats `to` as inclusive of that day", async () => {
    const res = await payments.listPayments(utilityId, { ...Q, from: "2026-06-02", to: "2026-06-02" });
    expect(refs(res)).toEqual(["TXN-999"]);
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
      const res = await payments.listPayments(utilityId, {
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
    const res = await payments.listPayments(utilityId, { ...Q, tender: "CASH" });
    expect(refs(res)).toEqual(["DRAWER-1"]);
    expect(res.totalReceived).toBe("40.00");
  });

  it("finds a payment by its external reference", async () => {
    const res = await payments.listPayments(utilityId, { ...Q, search: "chq" });
    expect(refs(res)).toEqual(["CHQ-8841"]);
  });

  it("returns the account number and customer name, not just ids", async () => {
    const res = await payments.listPayments(utilityId, { ...Q, search: "DRAWER-1" });
    expect(res.data[0]!.account.accountNumber).toBe("PAY-001");
    expect(res.data[0]!.account.customerName).toBe("Ada Lovelace");
  });

  it("lists only payments — not charges, fees or reversals", async () => {
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
      const res = await payments.listPayments(utilityId, { ...Q, from: "2026-06-01", to: "2026-06-01" });
      // The fee shares the day but is money owed, not money taken.
      expect(res.meta.total).toBe(2);
      expect(res.totalReceived).toBe("65.50");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: fee.id } });
      await prisma.ledgerReasonDef.delete({ where: { id: reason.id } });
    }
  });

  it("never returns another utility's payments, nor counts them in the total", async () => {
    const res = await payments.listPayments(utilityId, Q);
    expect(res.meta.total).toBe(3);
    expect(res.totalReceived).toBe("75.50");

    const theirs = await payments.listPayments(otherUtility, Q);
    expect(theirs.meta.total).toBe(1);
    expect(theirs.totalReceived).toBe("500.00");
  });
});
