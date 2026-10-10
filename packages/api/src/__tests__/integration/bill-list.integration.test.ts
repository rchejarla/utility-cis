import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The tenant-wide bill list — `GET /api/v1/bills` / `listBills`.
 *
 * It exists because every other bill route is account-scoped or
 * single-id, so a bill number could not be looked up without already
 * knowing its account. These tests pin the three decisions in it that can
 * actually be wrong:
 *
 *   1. `posted` is tri-state. Omitted must mean "every bill", not either
 *      branch, or the list silently hides half the data.
 *   2. `to` is an inclusive date-only bound. Comparing against midnight
 *      would drop the final day's bills.
 *   3. `search` matches the bill number, which is the identifier a caller
 *      reads off a piece of paper.
 *
 * Tenant scoping gets its own case because a cross-account list is
 * exactly where a missing `utilityId` leaks another utility's billing.
 */

const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtility = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let bills: typeof import("../../services/bill.service.js");

let accountId: string;
let otherAccountId: string;
let billingCycleId: string;

const Q = {
  page: 1,
  limit: 20,
  sort: "billDate" as const,
  order: "desc" as const,
};

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  bills = await import("../../services/bill.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "Residential 1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  billingCycleId = cycle.id;

  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Ada", lastName: "Lovelace" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "BL-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
      customerId: customer.id,
    },
  });
  accountId = account.id;

  // Another tenant, with its own cycle and account, to prove scoping.
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

  await makeBill({ number: "B-JAN", billDate: "2026-01-10", total: "10.00", posted: true });
  await makeBill({ number: "B-JUN-30", billDate: "2026-06-30", total: "20.00", posted: false });
  await makeBill({ number: "B-JUL", billDate: "2026-07-05", total: "30.00", posted: false });
  await makeBill({
    number: "B-OTHER",
    billDate: "2026-06-30",
    total: "99.00",
    posted: true,
    utility: otherUtility,
  });
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

async function makeBill(o: {
  number: string;
  billDate: string;
  total: string;
  posted: boolean;
  utility?: string;
}) {
  const { prisma } = prismaImports;
  const u = o.utility ?? utilityId;
  const isOther = u !== utilityId;
  await prisma.bill.create({
    data: {
      utilityId: u,
      accountId: isOther ? otherAccountId : accountId,
      billingCycleId: isOther
        ? (await prisma.billingCycle.findFirstOrThrow({ where: { utilityId: u } })).id
        : billingCycleId,
      periodStart: new Date("2026-01-01"),
      periodEnd: new Date(o.billDate),
      billDate: new Date(o.billDate),
      dueDate: new Date(o.billDate),
      subtotal: o.total,
      taxes: "0",
      credits: "0",
      total: o.total,
      billNumber: o.number,
      postedAt: o.posted ? new Date(o.billDate) : null,
    },
  });
}

const numbers = (r: { data: { billNumber: string }[] }) => r.data.map((b) => b.billNumber);

describe("listBills", () => {
  it("returns every bill for the tenant when posted is omitted", async () => {
    const res = await bills.listBills(utilityId, Q);
    // Tri-state: all three, posted and unposted alike.
    expect(numbers(res).sort()).toEqual(["B-JAN", "B-JUL", "B-JUN-30"]);
    expect(res.meta.total).toBe(3);
  });

  it("filters to unposted bills — the posting queue", async () => {
    const res = await bills.listBills(utilityId, { ...Q, posted: false });
    expect(numbers(res).sort()).toEqual(["B-JUL", "B-JUN-30"]);
  });

  it("filters to posted bills", async () => {
    const res = await bills.listBills(utilityId, { ...Q, posted: true });
    expect(numbers(res)).toEqual(["B-JAN"]);
  });

  it("treats `to` as inclusive of that day", async () => {
    // The bill dated exactly 2026-06-30 must be included — an exclusive
    // bound would drop it. This holds with a plain `lte` only because
    // billDate is a DATE column; see the note in listBills.
    const res = await bills.listBills(utilityId, { ...Q, from: "2026-01-01", to: "2026-06-30" });
    expect(numbers(res).sort()).toEqual(["B-JAN", "B-JUN-30"]);
  });

  it("excludes bills after `to`", async () => {
    const res = await bills.listBills(utilityId, { ...Q, to: "2026-06-29" });
    expect(numbers(res)).toEqual(["B-JAN"]);
  });

  it("honours `from` as an inclusive lower bound", async () => {
    const res = await bills.listBills(utilityId, { ...Q, from: "2026-06-30" });
    expect(numbers(res).sort()).toEqual(["B-JUL", "B-JUN-30"]);
  });

  it("finds a bill by number, case-insensitively and partially", async () => {
    const res = await bills.listBills(utilityId, { ...Q, search: "jun" });
    expect(numbers(res)).toEqual(["B-JUN-30"]);
  });

  it("returns the account number and customer name, not just ids", async () => {
    const res = await bills.listBills(utilityId, { ...Q, search: "B-JAN" });
    expect(res.data[0]!.account.accountNumber).toBe("BL-001");
    expect(res.data[0]!.account.customerName).toBe("Ada Lovelace");
    expect(res.data[0]!.billingCycleName).toBe("Residential 1");
  });

  it("carries postedAt so a caller can tell a calculation from a receivable", async () => {
    const posted = await bills.listBills(utilityId, { ...Q, search: "B-JAN" });
    expect(posted.data[0]!.postedAt).toBeInstanceOf(Date);
    const unposted = await bills.listBills(utilityId, { ...Q, search: "B-JUL" });
    expect(unposted.data[0]!.postedAt).toBeNull();
  });

  it("carries the bill's own charge entry: what is still owed, and its id", async () => {
    const { prisma } = prismaImports;
    const bill = await prisma.bill.findFirstOrThrow({ where: { utilityId, billNumber: "B-JAN" } });
    // A $10 charge with $4 paid off leaves $6 owed on THIS bill, which is
    // not the bill total -- the two are authoritative for different
    // things (ss4.6), and a CSR on a call needs the second number.
    const entry = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "BILL_CHARGE",
        amount: "10.00",
        openAmount: "6.00",
        dueDate: new Date("2026-02-10"),
        effectiveDate: new Date("2026-01-10"),
        billId: bill.id,
      },
    });
    try {
      const res = await bills.listBills(utilityId, { ...Q, search: "B-JAN" });
      expect(res.data[0]!.charge).toEqual({
        entryId: entry.id,
        openAmount: "6.00",
        reversed: false,
      });
      // The bill total is untouched by what has been paid against it.
      expect(res.data[0]!.total).toBe("10.0000");
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: entry.id } });
    }
  });

  it("reports a reversed charge, so a bill cannot be voided twice", async () => {
    const { prisma } = prismaImports;
    const bill = await prisma.bill.findFirstOrThrow({ where: { utilityId, billNumber: "B-JAN" } });
    const charge = await prisma.ledgerEntry.create({
      data: {
        utilityId, accountId, type: "BILL_CHARGE", amount: "10.00", openAmount: "0.00",
        dueDate: new Date("2026-02-10"), effectiveDate: new Date("2026-01-10"), billId: bill.id,
      },
    });
    const rev = await prisma.ledgerEntry.create({
      data: {
        utilityId, accountId, type: "REVERSAL", amount: "-10.00", openAmount: "0.00",
        effectiveDate: new Date("2026-01-11"), reversesId: charge.id,
      },
    });
    try {
      const res = await bills.listBills(utilityId, { ...Q, search: "B-JAN" });
      expect(res.data[0]!.charge!.reversed).toBe(true);
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: rev.id } });
      await prisma.ledgerEntry.delete({ where: { id: charge.id } });
    }
  });

  it("reports charge: null while a bill is unposted", async () => {
    const res = await bills.listBills(utilityId, { ...Q, search: "B-JUL" });
    expect(res.data[0]!.postedAt).toBeNull();
    expect(res.data[0]!.charge).toBeNull();
  });

  it("does not mistake a waiver credit for the bill's charge", async () => {
    // Waiver credits can carry a billId. Only BILL_CHARGE is the bill's
    // own receivable, so a credit against the bill must not surface here.
    const { prisma } = prismaImports;
    const bill = await prisma.bill.findFirstOrThrow({ where: { utilityId, billNumber: "B-JUN-30" } });
    const credit = await prisma.ledgerEntry.create({
      data: {
        utilityId, accountId, type: "ADJUSTMENT_CREDIT", amount: "-5.00", openAmount: "0.00",
        effectiveDate: new Date("2026-07-01"), billId: bill.id,
      },
    });
    try {
      const res = await bills.listBills(utilityId, { ...Q, search: "B-JUN-30" });
      expect(res.data[0]!.charge).toBeNull();
    } finally {
      await prisma.ledgerEntry.delete({ where: { id: credit.id } });
    }
  });

  it("never returns another utility's bills", async () => {
    const res = await bills.listBills(utilityId, Q);
    expect(numbers(res)).not.toContain("B-OTHER");

    // And the other tenant sees only its own, so the filter is scoping
    // rather than just hiding one fixture.
    const theirs = await bills.listBills(otherUtility, Q);
    expect(numbers(theirs)).toEqual(["B-OTHER"]);
  });

  it("does not let a search cross tenants", async () => {
    const res = await bills.listBills(utilityId, { ...Q, search: "B-OTHER" });
    expect(res.data).toEqual([]);
    expect(res.meta.total).toBe(0);
  });

  it("paginates with a correct total", async () => {
    const res = await bills.listBills(utilityId, { ...Q, limit: 2 });
    expect(res.data).toHaveLength(2);
    expect(res.meta.total).toBe(3);
    expect(res.meta.pages).toBe(2);
  });

  it("sorts by billDate descending by default", async () => {
    const res = await bills.listBills(utilityId, Q);
    expect(numbers(res)).toEqual(["B-JUL", "B-JUN-30", "B-JAN"]);
  });
});
