import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
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

/**
 * The services this file calls directly, as a route reaches them: acting
 * for the tenant, not merely naming it.
 *
 * Each already receives the tenant — production passed it from a request
 * or a job whose scope had been entered, so the argument and the scope
 * are always the same id. A direct service test has the argument and not
 * the scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` also overrides a surrounding `seedAsPlatform`, which is
 * what lets fixture rows be arranged across tenants while the call under
 * test stays confined to one.
 */
const recordDeposit = (...args: Parameters<typeof deposit.recordDeposit>) =>
  runAsTenant(args[0], async () => deposit.recordDeposit(...args));

const recordPayment = (...args: Parameters<typeof payment.recordPayment>) =>
  runAsTenant(args[0], async () => payment.recordPayment(...args));

const recordRefund = (...args: Parameters<typeof refund.recordRefund>) =>
  runAsTenant(args[0], async () => refund.recordRefund(...args));

/**
 * A transaction entered the way a route enters one: inside the tenant's
 * scope.
 *
 * A service taking `(tx, utilityId, …)` cannot receive the scope as an
 * argument, so it has to be around the call — which is the order a
 * request does it in.
 */
const asTenantTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  runAsTenant(utilityId, async () => prismaImports.prisma.$transaction(fn));

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  deposit = await import("../../services/ar/deposit.service.js");
  refund = await import("../../services/ar/refund.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
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
    data: { utilityId: otherUtilityId, name: "X", cycleCode: "X01", readDayOfMonth: 1, billDayOfMonth: 1, frequency: "MONTHLY" },
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
}), 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  // `$disconnect` does not dispose a pool the application owns —
  // that is the driver-adapter contract — so the tenant and
  // platform pools are ended here. Without it the container stops
  // while connections are live and Postgres reports 57P01.
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop();
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerApplication.deleteMany({ where: { utilityId } });
  await prisma.ledgerEntry.deleteMany({ where: { utilityId } });
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, depositAmount: 0, lastDueDate: null },
  });
}),
);

async function debit(amount: string, dueDate = "2026-06-14"): Promise<string> {

  /*

   * Arranging rows, so the authority the fixtures use. Calls under

   * test re-enter their own tenant scope.

   */

  return seedAsPlatform(async () => {
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
    await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
    return e.id;


  });

}

/** Leaves `over` open as a customer credit balance. */
async function overpay(billed: string, paid: string): Promise<void> {
  await debit(billed);
  await recordPayment(utilityId, ACTOR, "T", accountId, { amount: paid, tender: "CHECK" });
}

describe("recordRefund", () => {
  it("returns an overpayment and brings the balance to zero", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      const before = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(before.balance.toFixed(2)).toBe("-200.00");

      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));

  it("carries its disbursement record, and cannot fall due", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));

  it("refuses more than is available, and says how much there was", async () => {
    await overpay("500.00", "700.00");
    await expect(
      recordRefund(utilityId, ACTOR, "T", accountId, { amount: "250.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE", statusCode: 422 });

    // And the figure is in the message, not just the code.
    await recordRefund(utilityId, ACTOR, "T", accountId, {
      amount: "250.00",
      source: "CREDIT",
    })
      .catch((e: Error) => {
        expect(e.message).toContain("200.00");
      });
  });

  it("writes nothing when it refuses", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      await expect(
        recordRefund(utilityId, ACTOR, "T", accountId, { amount: "250.00", source: "CREDIT" }),
      ).rejects.toThrow();
      expect(await prisma.ledgerEntry.count({ where: { utilityId, type: "REFUND" } })).toBe(0);
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(acct.balance.toFixed(2)).toBe("-200.00");
  
    }));

  it("refuses a refund on an account with nothing to give back", async () => {
    await debit("100.00");
    await expect(
      recordRefund(utilityId, ACTOR, "T", accountId, { amount: "10.00", source: "CREDIT" }),
    ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE", statusCode: 422 });
  });

  it("refuses a zero or negative amount", async () => {
    await overpay("500.00", "700.00");
    for (const amount of ["0.00", "-5.00"]) {
      await expect(
        recordRefund(utilityId, ACTOR, "T", accountId, { amount, source: "CREDIT" }),
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
  it("will not pay a credit refund out of a security deposit", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await recordDeposit(utilityId, ACTOR, "T", accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      await expect(
        recordRefund(utilityId, ACTOR, "T", accountId, { amount: "100.00", source: "CREDIT" }),
      ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE" });

      // Untouched, and still held.
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(acct.depositAmount.toFixed(2)).toBe("500.00");
      const dep = await prisma.ledgerEntry.findFirstOrThrow({ where: { utilityId, type: "DEPOSIT" } });
      expect(dep.openAmount.toFixed(2)).toBe("-500.00");
  
    }));

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
  it("spends the credit and not the deposit when the account holds both", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // Deposit first, so oldest-first would reach for it before the credit.
      await recordDeposit(utilityId, ACTOR, "T", accountId, {
        amount: "500.00",
        tender: "CHECK",
      });
      await overpay("500.00", "700.00");

      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));

  /** The mirror: a deposit return must not reach for the overpayment. */
  it("spends the deposit and not the credit when returning a deposit", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      await recordDeposit(utilityId, ACTOR, "T", accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));

  it("will not return a deposit out of a credit balance", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");

      await expect(
        recordRefund(utilityId, ACTOR, "T", accountId, { amount: "100.00", source: "DEPOSIT" }),
      ).rejects.toMatchObject({ code: "REFUND_NOTHING_AVAILABLE" });

      // The credit is still there to be refunded as a credit.
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(acct.balance.toFixed(2)).toBe("-200.00");
  
    }));

  it("returns a deposit, leaving the receivable balance alone", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await debit("169.25");
      await recordDeposit(utilityId, ACTOR, "T", accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));

  /**
   * `Account.balance` is a cache AND a net figure. A drifted one must not
   * authorise money leaving the building, so availability is summed from
   * the open credits every time.
   */
  it("reads availability from the ledger, not from the cached balance", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      // Pretend the cache has drifted to show far more credit than exists.
      await prisma.account.update({ where: { id: accountId }, data: { balance: "-9999.00" } });

      await expect(
        recordRefund(utilityId, ACTOR, "T", accountId, { amount: "300.00", source: "CREDIT" }),
      ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_AVAILABLE" });

      // And the real 200.00 is still refundable.
      const ok = await recordRefund(utilityId, ACTOR, "T", accountId, {
        amount: "200.00",
        source: "CREDIT",
      });
      // Recomputed on the way out, so the drift is corrected as a side
      // effect rather than persisted.
      expect(ok.balance).toBe("0.00");
  
    }));

  it("refunds part of a credit and leaves the rest open", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
        amount: "50.00",
        source: "CREDIT",
      });
      expect(res.balance).toBe("-150.00");
      const credit = await prisma.ledgerEntry.findFirstOrThrow({
        where: { utilityId, type: "PAYMENT" },
      });
      expect(credit.openAmount.toFixed(2)).toBe("-150.00");
  
    }));

  it("never refunds against another tenant's account", async () => {
    await expect(
      recordRefund(utilityId, ACTOR, "T", otherAccountId, {
        amount: "10.00",
        source: "CREDIT",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND", statusCode: 404 });
  });

  it("writes an audit row naming the pool it drew from", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await overpay("500.00", "700.00");
      const res = await recordRefund(utilityId, ACTOR, "T", accountId, {
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
  
    }));
});
