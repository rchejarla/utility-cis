import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * What ends a payment plan, short of breaking it.
 *
 * Task 8 of `docs/superpowers/plans/2026-10-28-payment-plans-slice-1.md`.
 *
 * COMPLETED is derived from the covered debits, not counted from
 * instalments received. The two differ whenever money reaches the debts
 * by another route — a waiver, a write-off, or a customer who simply
 * paid more than the schedule asked — and counting would leave a plan
 * open over debts that no longer exist.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/payment-plan/lifecycle.js");
let fix: TenantFixture;
let fixB: TenantFixture;

function daysOut(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function reasonId(code: string, utilityId = TENANT_A): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId, code },
      select: { id: true },
    });
    return r.id;
  });
}

async function debit(opts: { amount: string; open?: string; utilityId?: string; accountId?: string }) {
  const utilityId = opts.utilityId ?? TENANT_A;
  const reason = await reasonId("OPENING_BALANCE", utilityId);
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId: opts.accountId ?? fix.accountId,
        type: "ADJUSTMENT_DEBIT",
        amount: opts.amount,
        openAmount: opts.open ?? opts.amount,
        effectiveDate: daysOut(-60),
        dueDate: daysOut(-30),
        reasonId: reason,
      },
    }),
  );
}

async function planOver(
  entryIds: string[],
  opts: { status?: "ACTIVE" | "COMPLETED" | "CANCELLED" | "DEFAULTED"; utilityId?: string; accountId?: string } = {},
) {
  const utilityId = opts.utilityId ?? TENANT_A;
  return seedAsPlatform(async () => {
    const plan = await prismaImports.prisma.paymentPlan.create({
      data: {
        utilityId,
        accountId: opts.accountId ?? fix.accountId,
        status: opts.status ?? "ACTIVE",
        totalBalance: "100.00",
        downPayment: "25.00",
        installmentAmount: "25.00",
        installmentFrequency: "MONTHLY",
        installmentCount: 3,
        startDate: daysOut(0),
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
    await prismaImports.prisma.paymentPlanDebit.createMany({
      data: entryIds.map((entryId) => ({ utilityId, planId: plan.id, entryId })),
    });
    return plan.id;
  });
}

async function statusOf(planId: string): Promise<string> {
  const p = await seedAsPlatform(async () =>
    prismaImports.prisma.paymentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { status: true },
    }),
  );
  return p.status;
}

async function settle(entryId: string, to = "0.00") {
  await seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.update({
      where: { id: entryId },
      data: { openAmount: to },
    }),
  );
}

async function ledgerCount(utilityId = TENANT_A): Promise<number> {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.count({ where: { utilityId } }),
  );
}

const sweep = (utilityId = TENANT_A) =>
  runAsTenant(utilityId, async () => svc.sweepPaymentPlans(utilityId));

const cancel = (planId: string, notes?: string) =>
  runAsTenant(TENANT_A, async () =>
    svc.cancelPaymentPlan(TENANT_A, ACTOR, "Tester", planId, notes),
  );

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/payment-plan/lifecycle.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables(
    "payment_plan_debit, payment_plan, delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, user_role, cis_user, role, utility_module, audit_log",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
    await seedDefaultReasons(TENANT_B, ACTOR, "Tester");
  });
});

describe("sweepPaymentPlans — completion", () => {
  it("completes a plan once every covered debit is settled", async () => {
    const a = await debit({ amount: "60.00" });
    const b = await debit({ amount: "40.00" });
    const planId = await planOver([a.id, b.id]);

    expect(await sweep()).toMatchObject({ completed: 0 });
    expect(await statusOf(planId)).toBe("ACTIVE");

    await settle(a.id);
    // One of two settled is not satisfied.
    expect(await sweep()).toMatchObject({ completed: 0 });

    await settle(b.id);
    expect(await sweep()).toMatchObject({ completed: 1 });
    expect(await statusOf(planId)).toBe("COMPLETED");
  });

  it("completes a plan whose debts were waived rather than paid", async () => {
    // A waiver or write-off takes a covered debit to zero without a
    // payment. The plan is satisfied — the debt is gone — and the sweep
    // must not wait for money that will never arrive. Counting
    // instalments received would hold this plan open forever.
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id]);

    await settle(a.id);

    expect(await sweep()).toMatchObject({ completed: 1 });
    expect(await statusOf(planId)).toBe("COMPLETED");
  });

  it("is idempotent — a second sweep completes nothing twice", async () => {
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id]);
    await settle(a.id);

    expect(await sweep()).toMatchObject({ completed: 1 });
    expect(await sweep()).toMatchObject({ completed: 0 });
    expect(await statusOf(planId)).toBe("COMPLETED");
  });

  it("leaves a plan alone while a part-paid debit still owes something", async () => {
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id]);
    await settle(a.id, "0.01");

    expect(await sweep()).toMatchObject({ completed: 0 });
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("does not reopen a cancelled or defaulted plan whose debts later clear", async () => {
    // Only ACTIVE plans are candidates. A plan someone ended stays
    // ended, however its debts are eventually settled.
    const a = await debit({ amount: "100.00" });
    const cancelled = await planOver([a.id], { status: "CANCELLED" });
    const b = await debit({ amount: "50.00" });
    const defaulted = await planOver([b.id], { status: "DEFAULTED" });
    await settle(a.id);
    await settle(b.id);

    expect(await sweep()).toMatchObject({ completed: 0 });
    expect(await statusOf(cancelled)).toBe("CANCELLED");
    expect(await statusOf(defaulted)).toBe("DEFAULTED");
  });

  it("writes nothing to the ledger", async () => {
    const a = await debit({ amount: "100.00" });
    await planOver([a.id]);
    await settle(a.id);
    const before = await ledgerCount();

    await sweep();

    expect(await ledgerCount()).toBe(before);
  });

  it("does not reach another tenant's plans", async () => {
    // The sweep runs per tenant on a worker. One tenant's pass closing
    // another's plans would be invisible until a customer was chased
    // for arrears the utility had agreed to wait for.
    const theirs = await debit({
      amount: "100.00",
      utilityId: TENANT_B,
      accountId: fixB.accountId,
    });
    const theirPlan = await planOver([theirs.id], {
      utilityId: TENANT_B,
      accountId: fixB.accountId,
    });
    await settle(theirs.id);

    expect(await sweep(TENANT_A)).toMatchObject({ completed: 0 });
    expect(await statusOf(theirPlan)).toBe("ACTIVE");
  });
});

describe("cancelPaymentPlan", () => {
  it("stops suppression without touching the ledger", async () => {
    // A cancelled plan covers nothing; no entry is written, reversed or
    // moved. The debts return to the ladder exactly as they were.
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id]);
    const before = await ledgerCount();

    const result = await cancel(planId, "Customer asked to stop");

    expect(result.status).toBe("CANCELLED");
    expect(await statusOf(planId)).toBe("CANCELLED");
    expect(await ledgerCount()).toBe(before);

    // The join rows survive: they are the record of what was agreed.
    const links = await seedAsPlatform(async () =>
      prismaImports.prisma.paymentPlanDebit.count({ where: { utilityId: TENANT_A, planId } }),
    );
    expect(links).toBe(1);
  });

  it("is a no-op on a plan that has already ended", async () => {
    // The caller is a CSR who may have two tabs open; refusing would be
    // a 422 about nothing.
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id], { status: "DEFAULTED" });

    const result = await cancel(planId);

    expect(result).toEqual({ status: "DEFAULTED", alreadyEnded: true });
    expect(await statusOf(planId)).toBe("DEFAULTED");
  });

  it("refuses a plan that does not exist, as a 404", async () => {
    await expect(cancel("00000000-0000-4000-8000-00000000dead")).rejects.toMatchObject({
      code: "PLAN_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("records who cancelled it", async () => {
    const a = await debit({ amount: "100.00" });
    const planId = await planOver([a.id]);

    await cancel(planId, "Customer asked to stop");

    const rows = await seedAsPlatform(async () =>
      prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityType: "PaymentPlan", entityId: planId },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(ACTOR);
  });
});
