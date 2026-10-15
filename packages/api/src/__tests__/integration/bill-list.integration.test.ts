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
    data: { utilityId, name: "Residential 1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
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
    data: { utilityId: otherUtility, name: "X", cycleCode: "X01", readDayOfMonth: 1, billDayOfMonth: 1, frequency: "MONTHLY" },
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

  /**
   * The `state` filter, which answers settlement rather than issuance.
   *
   * Every state is derived from the bill's own BILL_CHARGE entry — there
   * is no status column on Bill and deliberately shouldn't be, so these
   * cases are really about whether the ledger is being read correctly.
   *
   * One fixture serves them all: a $10 charge on B-JAN, mutated per
   * case, so each assertion is about the where clause and not about
   * which bill happened to be set up.
   */
  describe("state filter", () => {
    async function withCharge(
      over: { openAmount?: string; applied?: boolean; reversed?: boolean } = {},
    ) {
      const { prisma } = prismaImports;
      const bill = await prisma.bill.findFirstOrThrow({
        where: { utilityId, billNumber: "B-JAN" },
      });
      const charge = await prisma.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "BILL_CHARGE",
          amount: "10.00",
          openAmount: over.openAmount ?? "10.00",
          dueDate: new Date("2026-02-10"),
          effectiveDate: new Date("2026-01-10"),
          billId: bill.id,
        },
      });
      const extra: string[] = [];
      if (over.applied) {
        const credit = await prisma.ledgerEntry.create({
          data: {
            utilityId, accountId, type: "PAYMENT", amount: "-4.00", openAmount: "0.00",
            effectiveDate: new Date("2026-01-20"),
          },
        });
        extra.push(credit.id);
        await prisma.ledgerApplication.create({
          data: { utilityId, creditId: credit.id, debitId: charge.id, amount: "4.00" },
        });
      }
      if (over.reversed) {
        const rev = await prisma.ledgerEntry.create({
          data: {
            utilityId, accountId, type: "REVERSAL", amount: "-10.00", openAmount: "0.00",
            effectiveDate: new Date("2026-01-11"), reversesId: charge.id,
          },
        });
        extra.push(rev.id);
      }
      return async () => {
        await prisma.ledgerApplication.deleteMany({ where: { debitId: charge.id } });
        for (const id of extra.reverse()) {
          await prisma.ledgerEntry.delete({ where: { id } });
        }
        await prisma.ledgerEntry.delete({ where: { id: charge.id } });
      };
    }

    const found = async (state: Parameters<typeof bills.listBills>[1]["state"]) =>
      numbers(await bills.listBills(utilityId, { ...Q, state }));

    it("finds an unpaid charge as outstanding and overdue, not as paid", async () => {
      const cleanup = await withCharge();
      try {
        expect(await found("outstanding")).toContain("B-JAN");
        // Due 2026-02-10, long past, with the whole amount still owed.
        expect(await found("overdue")).toContain("B-JAN");
        expect(await found("paid")).not.toContain("B-JAN");
        expect(await found("partPaid")).not.toContain("B-JAN");
      } finally {
        await cleanup();
      }
    });

    /**
     * The due-date boundary, in the host's own zone, asserted in the
     * filter and in the row together.
     *
     * `bill.dueDate` is `@db.Date`, so the comparison point has to be UTC
     * midnight of the LOCAL calendar date. Deriving it from UTC parts
     * instead — `new Date().toISOString().slice(0, 10)` — moved "today"
     * on at UTC midnight, so from early evening anywhere west of
     * Greenwich a bill due today came back from `state=overdue`. The row
     * disagreed, because the pill was computed in the browser's zone
     * instead. One of those answers had to go; this pins what is left.
     */
    it("does not call a bill due today overdue, in the filter or the row", async () => {
      const { prisma } = prismaImports;
      const target = await prisma.bill.findFirstOrThrow({
        where: { utilityId, billNumber: "B-JAN" },
      });
      const originalDueDate = target.dueDate;
      const now = new Date();
      const dueToday = new Date(
        Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
      );
      const dueYesterday = new Date(dueToday.getTime() - 86_400_000);

      const rowOf = async (billNumber: string) => {
        const page = await bills.listBills(utilityId, Q);
        return page.data.find((b) => b.billNumber === billNumber);
      };

      const cleanup = await withCharge();
      try {
        await prisma.bill.update({
          where: { id: target.id },
          data: { dueDate: dueToday },
        });
        expect(await found("overdue")).not.toContain("B-JAN");
        expect((await rowOf("B-JAN"))?.overdue).toBe(false);

        await prisma.bill.update({
          where: { id: target.id },
          data: { dueDate: dueYesterday },
        });
        expect(await found("overdue")).toContain("B-JAN");
        expect((await rowOf("B-JAN"))?.overdue).toBe(true);
      } finally {
        await prisma.bill.update({
          where: { id: target.id },
          data: { dueDate: originalDueDate },
        });
        await cleanup();
      }
    }, 60_000);

    /**
     * `partPaid` in the row has to mean what `state=partPaid` means.
     *
     * The pill used to decide it in the browser with `openAmount <
     * total` — a 2dp ledger column against a 4dp bill column — so a bill
     * with nothing applied but a fractional cent in its total read "Part
     * paid" and was absent from the Part-paid filter. The filter asks
     * through the applications; so does the field now.
     */
    it("agrees with the partPaid filter, including on an unpaid fractional total", async () => {
      const { prisma } = prismaImports;
      const rowOf = async (billNumber: string) => {
        const page = await bills.listBills(utilityId, Q);
        return page.data.find((b) => b.billNumber === billNumber);
      };

      // Nothing applied, and a total that does not land on a cent.
      const target = await prisma.bill.findFirstOrThrow({
        where: { utilityId, billNumber: "B-JAN" },
      });
      const originalTotal = target.total;
      await prisma.bill.update({
        where: { id: target.id },
        data: { total: "10.0049" },
      });
      const unpaid = await withCharge();
      try {
        expect(await found("partPaid")).not.toContain("B-JAN");
        expect((await rowOf("B-JAN"))?.partPaid).toBe(false);
      } finally {
        await unpaid();
      }

      // Something applied, with some still owed.
      const partly = await withCharge({ openAmount: "6.00", applied: true });
      try {
        expect(await found("partPaid")).toContain("B-JAN");
        expect((await rowOf("B-JAN"))?.partPaid).toBe(true);
      } finally {
        await partly();
        await prisma.bill.update({
          where: { id: target.id },
          data: { total: originalTotal },
        });
      }
    }, 60_000);

    /**
     * The account's own Bills tab and the tenant-wide list describe the
     * same bill, so they have to describe it identically.
     *
     * The tab used to show `Bill # · Period · Due · Total · Created` from
     * an endpoint that returned no charge, no open amount and no posted
     * state — it could not have shown a status, and the obvious fix
     * would have been to work one out in the browser, which is the bug
     * `partPaid` above exists to record. Both lists now get their answer
     * from `settlementOf`, and this is what notices if one of them stops.
     */
    it("tells the account's own list exactly what the tenant-wide list says", async () => {
      const partly = await withCharge({ openAmount: "6.00", applied: true });
      try {
        const page = await bills.listBills(utilityId, Q);
        const wide = page.data.find((b) => b.billNumber === "B-JAN");
        const scoped = (await bills.listBillsForAccount(utilityId, accountId)).find(
          (b) => b.billNumber === "B-JAN",
        );

        expect(scoped).toBeDefined();
        expect(scoped?.charge).toEqual(wide?.charge);
        expect(scoped?.partPaid).toBe(wide?.partPaid);
        expect(scoped?.overdue).toBe(wide?.overdue);
        // And the fields the row's acts are addressed through, which the
        // tab had no way to offer before.
        expect(scoped?.accountId).toBe(accountId);
        expect(scoped?.charge?.entryId).toBeTruthy();
        expect(scoped?.partPaid).toBe(true);
      } finally {
        await partly();
      }
    }, 60_000);

    it("finds a settled charge as paid and nothing else", async () => {
      const cleanup = await withCharge({ openAmount: "0.00", applied: true });
      try {
        expect(await found("paid")).toContain("B-JAN");
        expect(await found("outstanding")).not.toContain("B-JAN");
        expect(await found("overdue")).not.toContain("B-JAN");
        // Nothing is owed, so there is no part of it left to be part paid.
        expect(await found("partPaid")).not.toContain("B-JAN");
      } finally {
        await cleanup();
      }
    });

    /**
     * Part paid is asked through the applications, not by comparing
     * openAmount to amount — Prisma cannot compare two columns, and the
     * applications are what actually consumed the charge.
     */
    it("finds a part-paid charge as both part paid and outstanding", async () => {
      const cleanup = await withCharge({ openAmount: "6.00", applied: true });
      try {
        expect(await found("partPaid")).toContain("B-JAN");
        expect(await found("outstanding")).toContain("B-JAN");
        expect(await found("paid")).not.toContain("B-JAN");
      } finally {
        await cleanup();
      }
    });

    it("does not call an untouched charge part paid", async () => {
      const cleanup = await withCharge({ openAmount: "10.00" });
      try {
        expect(await found("partPaid")).not.toContain("B-JAN");
      } finally {
        await cleanup();
      }
    });

    /** A reversed charge is owed by nobody, so it is not outstanding. */
    it("excludes a reversed charge from outstanding and overdue", async () => {
      const cleanup = await withCharge({ reversed: true });
      try {
        expect(await found("reversed")).toContain("B-JAN");
        expect(await found("outstanding")).not.toContain("B-JAN");
        expect(await found("overdue")).not.toContain("B-JAN");
      } finally {
        await cleanup();
      }
    });

    it("finds a bill with no charge as unposted, and only that", async () => {
      // B-JUL is the unposted fixture; it has no ledger entry at all.
      expect(await found("unposted")).toContain("B-JUL");
      expect(await found("outstanding")).not.toContain("B-JUL");
      expect(await found("paid")).not.toContain("B-JUL");
    });

    it("still returns every bill when no state is given", async () => {
      const all = await bills.listBills(utilityId, Q);
      expect(all.meta.total).toBeGreaterThan(1);
    });
  });

  /**
   * Search covers who the bill is for, not just its number.
   *
   * A caller rarely holds the paper. They give a name, or read an
   * account number off an older statement — and `nextBillNumber`
   * produces BILL-YYYYMM-<counter>, so neither is in the bill number.
   */
  describe("search", () => {
    const found = async (search: string) =>
      numbers(await bills.listBills(utilityId, { ...Q, search }));

    it("still matches the bill number", async () => {
      expect(await found("B-JAN")).toContain("B-JAN");
    });

    it("matches the account number", async () => {
      // The fixture account is BL-001; no bill number contains it.
      const hits = await found("BL-001");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((n) => !n.includes("BL-001"))).toBe(true);
    });

    it("matches a customer's surname", async () => {
      expect((await found("Lovelace")).length).toBeGreaterThan(0);
    });

    /**
     * The one the house pattern gets wrong. ORing the raw string across
     * firstName and lastName matches neither, because neither field
     * contains "Ada Lovelace" — so every token is matched separately
     * and all of them must hit.
     */
    it("matches a full name, both halves of it", async () => {
      expect((await found("Ada Lovelace")).length).toBeGreaterThan(0);
      // Order should not matter either.
      expect((await found("Lovelace Ada")).length).toBeGreaterThan(0);
    });

    it("requires every token to match, so a wrong half finds nothing", async () => {
      expect(await found("Ada Nobody")).toEqual([]);
    });

    it("is case-insensitive on names", async () => {
      expect((await found("lovelace")).length).toBeGreaterThan(0);
    });

    it("does not let a customer name cross tenants", async () => {
      // The other tenant's bill must not surface for this tenant's
      // search, and the reverse: searching our customer from theirs.
      expect(await found("B-OTHER")).toEqual([]);
      expect(numbers(await bills.listBills(otherUtility, { ...Q, search: "Lovelace" }))).toEqual([]);
    });
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
