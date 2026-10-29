import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform, ensurePrincipal } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
/**
 * Where days-past-due comes from, now that AR writes the cache.
 *
 * `Account.lastDueDate` used to mean "most recent invoice due date".
 * Since AR slice 1 it holds the **oldest open debit's** due date, which
 * is what dunning actually needs: an account with a six-month-old unpaid
 * bill and a current one is six months delinquent, not current. The
 * delinquency engine reads the column unchanged
 * (`delinquency.service.ts` :52 and :202), so this is the test that the
 * two halves agree.
 *
 * Without it the redefinition is a silent behaviour change in
 * money-adjacent code: the same account escalates to a higher tier than
 * it used to, and nothing fails.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let delinquency: typeof import("../../services/delinquency.service.js");

let accountId: string;
let ruleId: string;
let debitReasonId: string;

/** UTC midnight n days back, so `floor((now - d) / 1 day)` is exactly n. */
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
const evaluateAll = (...args: Parameters<typeof delinquency.evaluateAll>) =>
  runAsTenant(args[0], async () => delinquency.evaluateAll(...args));

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

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  delinquency = await import("../../services/delinquency.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "AGING-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;

  // One tier, firing at 30 days past due. notificationEventType null so
  // evaluateAll takes no notification path — this test is about the
  // number it computes, not about delivery.
  const rule = await prisma.delinquencyRule.create({
    data: {
      utilityId,
      name: "Past Due Notice",
      tier: 1,
      daysPastDue: 30,
      minBalance: "25.00",
      actionType: "NOTICE_EMAIL",
      notificationEventType: null,
      autoApply: true,
      effectiveDate: new Date("2025-01-01"),
    },
  });
  ruleId = rule.id;

  // Slice 3's ledger_entry_reason_required.
  const reason = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: "AGING-FIXTURE",
      label: "Aging suite fixture",
      appliesToType: "ADJUSTMENT_DEBIT",
    },
  });
  debitReasonId = reason.id;

  // `payment_plan.approved_by` is a real key to cis_user: a plan with no
  // record of who agreed it is what the audit discipline forbids. This
  // suite had no users at all, and beforeEach does not clear them.
  await ensurePrincipal(prisma, utilityId, ACTOR);
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
  await prisma.delinquencyAction.deleteMany({});
  // Child first: payment_plan_debit -> ledger_entry is RESTRICT.
  await prisma.paymentPlanDebit.deleteMany({});
  await prisma.paymentPlan.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
}),
);

/** An open debit on the account, due `n` days ago. */
async function openDebit(amount: string, dueDaysAgo: number) {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under
   * test re-enter their own tenant scope.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate: daysAgo(dueDaysAgo),
        effectiveDate: daysAgo(dueDaysAgo),
        reasonId: debitReasonId,
        createdBy: ACTOR,
      },
    });

  });
}

describe("delinquency days-past-due, against the AR cache", () => {
  it("ages from the older of two open debits, not the newer", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await openDebit("120.00", 100);
      await openDebit("40.00", 5);
      await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("160.00");
      expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe(
        daysAgo(100).toISOString().slice(0, 10),
      );

      // The tier fires at 30 days. Read off the newer debit the account
      // would be 5 days past due and this rule would not apply at all.
      const result = await evaluateAll(utilityId);
      expect(result.accountsEvaluated).toBe(1);
      expect(result.actionsCreated).toBe(1);

      const action = await prisma.delinquencyAction.findFirstOrThrow({ where: { accountId } });
      expect(action.ruleId).toBe(ruleId);
      expect(action.daysPastDueAtAction).toBe(100);
      expect(action.balanceAtAction.toFixed(2)).toBe("160.00");
  
    }));

  it("stops ageing the account once the older debit is settled", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await openDebit("120.00", 100);
      await openDebit("40.00", 5);

      // Settle the older one by hand — slice 2 owns payment allocation.
      const older = await prisma.ledgerEntry.findFirstOrThrow({
        where: { accountId, amount: "120.00" },
      });
      await asTenantTx(async (tx) => {
        await tx.ledgerEntry.update({ where: { id: older.id }, data: { openAmount: "0.00" } });
        await tx.ledgerEntry.create({
          data: {
            utilityId,
            accountId,
            type: "PAYMENT",
            amount: "-120.00",
            openAmount: "0.00",
            effectiveDate: daysAgo(1),
            tender: "CHECK",
          },
        });
        await posting.recomputeAccountCache(tx, utilityId, accountId);
      });

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("40.00");
      expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe(
        daysAgo(5).toISOString().slice(0, 10),
      );

      // 5 days past due, below the tier's 30 — no action.
      const result = await evaluateAll(utilityId);
      expect(result.actionsCreated).toBe(0);
  
    }));
});

/** A plan covering the given debits, in the given state. */
async function planOver(
  entryIds: string[],
  status: "ACTIVE" | "DEFAULTED" | "COMPLETED" | "CANCELLED" = "ACTIVE",
) {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const plan = await prisma.paymentPlan.create({
      data: {
        utilityId,
        accountId,
        status,
        totalBalance: "120.00",
        downPayment: "30.00",
        installmentAmount: "30.00",
        installmentFrequency: "MONTHLY",
        installmentCount: 3,
        startDate: daysAgo(0),
        approvedBy: ACTOR,
        graceDays: 5,
        missedBeforeDefault: 1,
        partialInstallmentCounts: false,
        currentBillCounts: true,
        suppressFeesWhileKept: true,
        assessSuppressedFeesOnDefault: false,
      },
      select: { id: true },
    });
    await prisma.paymentPlanDebit.createMany({
      data: entryIds.map((entryId) => ({ utilityId, planId: plan.id, entryId })),
    });
    return plan;
  });
}

/** Every open debit on the account, oldest first. */
async function openDebitIds(): Promise<string[]> {
  return seedAsPlatform(async () => {
    const rows = await prismaImports.prisma.ledgerEntry.findMany({
      where: { accountId, openAmount: { gt: 0 } },
      orderBy: { dueDate: "asc" },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  });
}

/**
 * The account-level clock, which is the harder half of suppression.
 *
 * `Account.lastDueDate` is AR's and means "the oldest open debit" full
 * stop — reconciliation and the aging query read it, so it is not
 * redefined here. The ladder instead ages from the oldest open debit
 * *not covered by a live plan*, which is what gives the two-bucket
 * behaviour the plan promises: the arrears are held, the new bill is
 * still chased on its own clock.
 */
describe("the account clock, against a payment plan", () => {
  it("files no action when the only overdue debt is covered", () =>
    seedAsPlatform(async () => {
      await openDebit("120.00", 100);
      await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
      await planOver(await openDebitIds());

      const result = await evaluateAll(utilityId);

      expect(result.actionsCreated).toBe(0);
    }));

  it("leaves Account.lastDueDate alone, which AR owns", () =>
    seedAsPlatform(async () => {
      // Suppression must not be implemented by moving this column: the
      // AR reconciliation proves it against the ledger, and a ladder
      // that rewrote it would make that proof fail.
      await openDebit("120.00", 100);
      await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
      await planOver(await openDebitIds());

      await evaluateAll(utilityId);

      const account = await prismaImports.prisma.account.findUniqueOrThrow({
        where: { id: accountId },
      });
      expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe(
        daysAgo(100).toISOString().slice(0, 10),
      );
    }));

  it("ages from the uncovered debt when there is one", () =>
    seedAsPlatform(async () => {
      // The two-bucket model: the plan holds the arrears, the new bill
      // is chased on its own clock. 100 days covered, 40 days not — the
      // action must read 40, not 100.
      await openDebit("120.00", 100);
      await openDebit("40.00", 40);
      await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
      const ids = await openDebitIds();
      await planOver([ids[0]!]);

      const result = await evaluateAll(utilityId);

      expect(result.actionsCreated).toBe(1);
      const action = await prismaImports.prisma.delinquencyAction.findFirstOrThrow({
        where: { accountId },
      });
      expect(action.daysPastDueAtAction).toBe(40);
    }));

  it("sees a defaulted plan's debits again, at their real ages", () =>
    seedAsPlatform(async () => {
      /*
       * The join rows survive the default, so a membership test would
       * hide these forever — and would look correct in both tests
       * above, where the plan is still running. 100 days, not 0 and not
       * "no action".
       */
      await openDebit("120.00", 100);
      await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
      await planOver(await openDebitIds(), "DEFAULTED");

      const result = await evaluateAll(utilityId);

      expect(result.actionsCreated).toBe(1);
      const action = await prismaImports.prisma.delinquencyAction.findFirstOrThrow({
        where: { accountId },
      });
      expect(action.daysPastDueAtAction).toBe(100);
    }));
});
