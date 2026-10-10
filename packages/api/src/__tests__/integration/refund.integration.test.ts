import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Refunds — giving money back.
 *
 * The decisions this pins, in descending order of what it would cost to
 * get them wrong:
 *
 *   1. **A credit refund cannot touch a deposit, and a deposit return
 *      cannot touch a credit balance.** Both pools are negative
 *      `openAmount`, so a walk filtered on sign alone would pay an
 *      overpayment out of a security deposit. That is the same silent
 *      spend the allocation exclusion exists to prevent, and it is money
 *      belonging to the customer being used for the wrong purpose.
 *   2. **Asking for more than is available is refused, with the figure.**
 *      Quietly refunding the lesser amount leaves an operator believing
 *      a customer was made whole and a cheque already written.
 *   3. **Availability comes from the open credits, never the cache.**
 *      `Account.balance` is a NET figure and a cache; neither can
 *      authorise a payment out.
 *   4. A refund is a positive DEBIT that fully discharges what it pays,
 *      so nothing is left open behind a cheque that has gone.
 *   5. It carries its disbursement record — tender, reference, issue
 *      date — on the entry, and it cannot fall due.
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
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "REF-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
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
  await prisma.ledgerApplication.deleteMany({ where: { utilityId } });
  await prisma.ledgerEntry.deleteMany({ where: { utilityId } });
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, depositAmount: 0, lastDueDate: null },
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

/** Leaves `over` open as a customer credit balance. */
async function overpay(billed: string, paid: string): Promise<void> {
  await debit(billed);
  await payment.recordPayment(utilityId, ACTOR, "T", accountId, { amount: paid, tender: "CHECK" });
}

describe("recordRefund", () => {
  it("returns an overpayment and brings the balance to zero", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(before.balance.toFixed(2)).toBe("-200.00");

    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
      externalRef: "CHQ-5001",
    });

    expect(res.amount).toBe("200.00");
    expect(res.balance).toBe("0.00");
    // The refund discharged the credit rather than sitting beside it.
    expect(res.applied).toHaveLength(1);
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.type).toBe("REFUND");
    // Positive: a refund is a debit that discharges a credit the
    // customer already held.
    expect(entry.amount.toFixed(2)).toBe("200.00");
    expect(entry.openAmount.toFixed(2)).toBe("0.00");
  });

  it("carries its disbursement record, and cannot fall due", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
      tender: "CHECK",
      externalRef: "CHQ-5001",
      issuedOn: "2026-07-02",
    });
    const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.entryId } });
    expect(entry.tender).toBe("CHECK");
    expect(entry.externalRef).toBe("CHQ-5001");
    expect(entry.effectiveDate.toISOString().slice(0, 10)).toBe("2026-07-02");
    // A refund is not owed BY the customer. A due date would also put it
    // in the aging index and in front of the delinquency sweep.
    expect(entry.dueDate).toBeNull();
  });

  it("refuses more than is available, and says how much there was", async () => {
    await overpay("500.00", "700.00");
    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "250.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE", statusCode: 422 });

    // And the figure is in the message, not just the code.
    await refund
      .recordRefund(utilityId, ACTOR, "T", accountId, { amount: "250.00", source: "CREDIT" })
      .catch((e: Error) => {
        expect(e.message).toContain("200.00");
      });
  });

  it("writes nothing when it refuses", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "250.00", source: "CREDIT" }),
    ).rejects.toThrow();
    expect(await prisma.ledgerEntry.count({ where: { utilityId, type: "REFUND" } })).toBe(0);
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(acct.balance.toFixed(2)).toBe("-200.00");
  });

  it("refuses a refund on an account with nothing to give back", async () => {
    await debit("100.00");
    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "10.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE", statusCode: 422 });
  });

  it("refuses a zero or negative amount", async () => {
    await overpay("500.00", "700.00");
    for (const amount of ["0.00", "-5.00"]) {
      await expect(
        refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount, source: "CREDIT" }),
      ).rejects.toMatchObject({ code: "REFUND_AMOUNT_INVALID" });
    }
  });

  /**
   * The case that matters most.
   *
   * A deposit is a credit by sign. An overpayment refund walking credits
   * by sign alone would pay itself out of the customer's security
   * deposit — money the utility holds, not money it owes back yet — and
   * nothing would look wrong afterwards: the balance would be right, the
   * invariant would hold, and the deposit would simply be gone.
   */
  it("will not pay a credit refund out of a security deposit", async () => {
    const { prisma } = prismaImports;
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });

    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "100.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE" });

    // Untouched, and still held.
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(acct.depositAmount.toFixed(2)).toBe("500.00");
    const dep = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId, type: "DEPOSIT" } });
    expect(dep.openAmount.toFixed(2)).toBe("-500.00");
  });

  /**
   * The same protection, where it is actually load-bearing.
   *
   * The test above passes on the availability check alone: with no
   * credit to be found, the refund is refused before allocation runs. It
   * would therefore stay green if the allocation walk silently went back
   * to filtering on sign.
   *
   * Here both pools are funded, so the availability check lets the
   * refund through and the allocation walk decides what gets spent. A
   * credit refund must take the $200 overpayment and leave all $500 of
   * the deposit alone — even though the deposit is older, and allocation
   * is oldest-first.
   */
  it("spends the credit and not the deposit when the account holds both", async () => {
    const { prisma } = prismaImports;
    // Deposit first, so oldest-first would reach for it before the credit.
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });
    await overpay("500.00", "700.00");

    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
    });

    expect(res.balance).toBe("0.00");
    // Every cent of the deposit still held.
    expect(res.depositAmount).toBe("500.00");
    const dep = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId, type: "DEPOSIT" } });
    expect(dep.openAmount.toFixed(2)).toBe("-500.00");
    // And what was consumed was the payment, named explicitly so the
    // assertion cannot be satisfied by consuming nothing.
    const credit = await prisma.ledgerEntry.findFirstOrThrow({
      where: { utilityId, type: "PAYMENT" },
    });
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]!.creditId).toBe(credit.id);
  });

  /** The mirror: a deposit return must not reach for the overpayment. */
  it("spends the deposit and not the credit when returning a deposit", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });

    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      source: "DEPOSIT",
    });

    expect(res.depositAmount).toBe("0.00");
    // The overpayment is still the customer's to be refunded separately.
    expect(res.balance).toBe("-200.00");
    const credit = await prisma.ledgerEntry.findFirstOrThrow({
      where: { utilityId, type: "PAYMENT" },
    });
    expect(credit.openAmount.toFixed(2)).toBe("-200.00");
    const dep = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId, type: "DEPOSIT" } });
    expect(res.applied).toHaveLength(1);
    expect(res.applied[0]!.creditId).toBe(dep.id);
  });

  it("will not return a deposit out of a credit balance", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");

    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "100.00", source: "DEPOSIT" }),
    ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE" });

    // The credit is still there to be refunded as a credit.
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(acct.balance.toFixed(2)).toBe("-200.00");
  });

  it("returns a deposit, leaving the receivable balance alone", async () => {
    const { prisma } = prismaImports;
    await debit("169.25");
    await deposit.recordDeposit(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      tender: "CHECK",
    });

    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "500.00",
      source: "DEPOSIT",
      tender: "CHECK",
      externalRef: "CHQ-DEP-RET",
    });

    expect(res.depositAmount).toBe("0.00");
    // What they owe is untouched: releasing a deposit is not a payment.
    // An account in arrears that gets its deposit back still owes.
    expect(res.balance).toBe("169.25");
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(acct.balance.toFixed(2)).toBe("169.25");
    expect(acct.depositAmount.toFixed(2)).toBe("0.00");
    const dep = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId, type: "DEPOSIT" } });
    expect(dep.openAmount.toFixed(2)).toBe("0.00");
  });

  /**
   * `Account.balance` is a cache AND a net figure. A drifted one must not
   * authorise money leaving the building, so availability is summed from
   * the open credits every time.
   */
  it("reads availability from the ledger, not from the cached balance", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    // Pretend the cache has drifted to show far more credit than exists.
    await prisma.account.update({ where: { id: accountId }, data: { balance: "-9999.00" } });

    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", accountId, { amount: "300.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE" });

    // And the real 200.00 is still refundable.
    const ok = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
    });
    // Recomputed on the way out, so the drift is corrected as a side
    // effect rather than persisted.
    expect(ok.balance).toBe("0.00");
  });

  it("refunds part of a credit and leaves the rest open", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "50.00",
      source: "CREDIT",
    });
    expect(res.balance).toBe("-150.00");
    const credit = await prisma.ledgerEntry.findFirstOrThrow({
      where: { utilityId, type: "PAYMENT" },
    });
    expect(credit.openAmount.toFixed(2)).toBe("-150.00");
  });

  it("never refunds against another tenant's account", async () => {
    await expect(
      refund.recordRefund(utilityId, ACTOR, "T", otherAccountId, {
        amount: "10.00",
        source: "CREDIT",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", statusCode: 404 });
  });

  it("writes an audit row naming the pool it drew from", async () => {
    const { prisma } = prismaImports;
    await overpay("500.00", "700.00");
    const res = await refund.recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "200.00",
      source: "CREDIT",
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { utilityId, entityId: res.entryId },
      orderBy: { createdAt: "desc" },
    });
    // The event type rides in `metadata`; `afterState` carries the act.
    expect(JSON.stringify(audit.metadata)).toContain("ledger_refund.issued");
    expect(JSON.stringify(audit.afterState)).toContain("CREDIT");
  });
});
