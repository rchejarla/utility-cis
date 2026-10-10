import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The tenant-wide disbursements list — `GET /api/v1/disbursements`.
 *
 * The mirror of the receipts list, and a separate one on purpose: a
 * receipts total is tied out against a bank deposit slip, which holds
 * only money in, and this against a cheque run.
 *
 * What it pins:
 *   1. **The pool is derived, not stored.** A refund says which pool it
 *      drew from by the credits it discharged. There is no column, so
 *      there is nothing to disagree with the ledger — but the derivation
 *      has to be right, and it has to be right for a deposit return
 *      made on an account that also holds ordinary credit.
 *   2. **Subtotals cover the FILTER, not the page.** They are summed by
 *      the database through the applications relation, for the same
 *      reason the total is: a split that silently covered one page
 *      stops adding up to the total past 25 rows.
 *   3. A reversed refund stays IN the total — the cheque left that day.
 *   4. Another tenant's refunds are never visible or counted.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtilityId = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let deposit: typeof import("../../services/ar/deposit.service.js");
let refund: typeof import("../../services/ar/refund.service.js");

let accountId: string;
let otherAccountId: string;
let debitReasonId: string;

const Q = { page: 1, limit: 25, sort: "effectiveDate" as const, order: "desc" as const };

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  deposit = await import("../../services/ar/deposit.service.js");
  refund = await import("../../services/ar/refund.service.js");

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
      accountNumber: "DISB-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
      customerId: customer.id,
    },
  });
  accountId = account.id;

  const otherCycle = await prisma.billingCycle.create({
    data: { utilityId: otherUtilityId, name: "X", cycleCode: "X01", billDayOfMonth: 1, frequency: "MONTHLY" },
  });
  const otherAccount = await prisma.account.create({
    data: {
      utilityId: otherUtilityId,
      accountNumber: "OTHER-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: otherCycle.id,
    },
  });
  otherAccountId = otherAccount.id;

  const reason = await prisma.ledgerReasonDef.create({
    data: { utilityId, code: "MISC_DEBIT", label: "Misc charge", appliesToType: "ADJUSTMENT_DEBIT" },
  });
  debitReasonId = reason.id;
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.account.updateMany({ data: { balance: 0, depositAmount: 0, lastDueDate: null } });
});

async function debit(amount: string): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.ledgerEntry.create({
    data: {
      utilityId,
      accountId,
      type: "ADJUSTMENT_DEBIT",
      amount,
      openAmount: amount,
      dueDate: new Date("2026-06-14"),
      effectiveDate: new Date("2026-06-14"),
      reasonId: debitReasonId,
      createdBy: ACTOR,
    },
  });
  await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
}

/** Leaves an open credit balance of `paid - billed`. */
async function overpay(billed: string, paid: string): Promise<void> {
  await debit(billed);
  await payment.recordPayment(utilityId, ACTOR, "T", accountId, { amount: paid, tender: "CHECK" });
}

describe("listDisbursements", () => {
  it("lists a credit refund with its disbursement record", async () => {
    await overpay("500.00", "700.00");
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
      externalRef: "CHQ-7001",
      issuedOn: "2026-07-02",
    });

    const res = await refund.listDisbursements(utilityId, Q);
    expect(res.meta.total).toBe(1);
    const row = res.data[0]!;
    expect(row.amount).toBe("200.00");
    expect(row.source).toBe("CREDIT");
    expect(row.tender).toBe("CHECK");
    expect(row.externalRef).toBe("CHQ-7001");
    expect(row.effectiveDate.toISOString().slice(0, 10)).toBe("2026-07-02");
    expect(row.account.accountNumber).toBe("DISB-001");
    expect(row.account.customerName).toBe("Ada Lovelace");
    expect(res.totalPaidOut).toBe("200.00");
  });

  /**
   * The derivation, where it could go wrong: the account holds ordinary
   * credit AND a deposit, and the refund returned the deposit. Reading
   * the pool off anything but the credits it actually discharged would
   * label this a credit refund.
   */
  it("derives the pool from the credits discharged, not from what else the account holds", async () => {
    await overpay("500.00", "700.00");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      source: "DEPOSIT",
      tender: "CHECK",
    });

    const res = await refund.listDisbursements(utilityId, Q);
    expect(res.meta.total).toBe(1);
    expect(res.data[0]!.source).toBe("DEPOSIT");
    expect(res.subtotals).toEqual({ CREDIT: "0.00", DEPOSIT: "500.00" });
  });

  it("splits the two kinds, and states a zero rather than omitting it", async () => {
    await overpay("500.00", "700.00");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "300.00",
      tender: "CASH",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "300.00",
      source: "DEPOSIT",
      tender: "CHECK",
    });

    const both = await refund.listDisbursements(utilityId, Q);
    expect(both.totalPaidOut).toBe("500.00");
    expect(both.subtotals).toEqual({ CREDIT: "200.00", DEPOSIT: "300.00" });

    // Narrowed to the cash day, where no deposit was returned.
    const none = await refund.listDisbursements(utilityId, { ...Q, tender: "CASH" });
    expect(none.totalPaidOut).toBe("0.00");
    expect(none.subtotals).toEqual({ CREDIT: "0.00", DEPOSIT: "0.00" });
  });

  /**
   * The split has to cover the filter, not the page. With one row on
   * screen out of two, a page-scoped split would report half the money
   * beside a total reporting all of it.
   */
  it("keeps the split on the filter when the page is smaller than the result", async () => {
    await overpay("500.00", "700.00");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "300.00",
      tender: "CHECK",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "300.00",
      source: "DEPOSIT",
      tender: "CHECK",
    });

    const res = await refund.listDisbursements(utilityId, { ...Q, limit: 1 });
    expect(res.data).toHaveLength(1);
    expect(res.meta.total).toBe(2);
    expect(res.totalPaidOut).toBe("500.00");
    // Both kinds still whole, though only one row came back.
    expect(res.subtotals).toEqual({ CREDIT: "200.00", DEPOSIT: "300.00" });
  });

  it("keeps a reversed refund in the total, and marks the row", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    const issued = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
      issuedOn: "2026-07-02",
    });
    // Voided two days later. The cheque still left on the 2nd.
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "REVERSAL",
        amount: "-200.00",
        openAmount: "0.00",
        effectiveDate: new Date("2026-07-04"),
        reversesId: issued.entryId,
      },
    });

    const res = await refund.listDisbursements(utilityId, {
      ...Q,
      from: "2026-07-02",
      to: "2026-07-02",
    });
    expect(res.totalPaidOut).toBe("200.00");
    expect(res.data[0]!.reversed).toBe(true);
  });

  it("lists nothing but refunds — not payments, deposits or charges", async () => {
    await overpay("500.00", "700.00");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "300.00",
      tender: "CHECK",
    });
    const res = await refund.listDisbursements(utilityId, Q);
    // Money arrived on this account three times and left none.
    expect(res.meta.total).toBe(0);
    expect(res.totalPaidOut).toBe("0.00");
  });

  it("bounds the range by the day the money left", async () => {
    await overpay("500.00", "700.00");
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "100.00",
      source: "CREDIT",
      tender: "CHECK",
      issuedOn: "2026-07-02",
    });
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "50.00",
      source: "CREDIT",
      tender: "CHECK",
      issuedOn: "2026-07-05",
    });

    const day = await refund.listDisbursements(utilityId, {
      ...Q,
      from: "2026-07-02",
      to: "2026-07-02",
    });
    expect(day.totalPaidOut).toBe("100.00");
    // `to` inclusive of its own day.
    const span = await refund.listDisbursements(utilityId, {
      ...Q,
      from: "2026-07-02",
      to: "2026-07-05",
    });
    expect(span.totalPaidOut).toBe("150.00");
  });

  it("never returns another tenant's disbursements, nor counts them", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
    });
    // Theirs, written directly: a bare REFUND with no applications, which
    // also exercises the unknown-pool path.
    await prisma.ledgerEntry.create({
      data: {
        utilityId: otherUtilityId,
        accountId: otherAccountId,
        type: "REFUND",
        amount: "999.00",
        openAmount: "0.00",
        effectiveDate: new Date("2026-07-02"),
        tender: "CHECK",
        externalRef: "THEIRS",
      },
    });

    const mine = await refund.listDisbursements(utilityId, Q);
    expect(mine.meta.total).toBe(1);
    expect(mine.totalPaidOut).toBe("200.00");
    expect(JSON.stringify(mine)).not.toContain("THEIRS");

    const theirs = await refund.listDisbursements(otherUtilityId, Q);
    expect(theirs.meta.total).toBe(1);
    // No applications behind it, so the pool is unknown rather than
    // defaulted to a credit refund.
    expect(theirs.data[0]!.source).toBeNull();
    expect(theirs.subtotals).toEqual({ CREDIT: "0.00", DEPOSIT: "0.00" });
  });
});
