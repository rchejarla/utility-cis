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
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/*
 * The late notice goes out through the ordinary notification service,
 * which answers null when the tenant has no template for the event.
 * Mocked so "notified once, not five times" is testable without
 * seeding a template — the question here is how many times the sweep
 * asks, not what the template says.
 */
const sendNotification = vi.fn(async () => "notif-1");
vi.mock("../../services/notification.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/notification.service.js")>()),
  sendNotification,
}));

/**
 * Breaking a payment plan.
 *
 * Task 9 of `docs/superpowers/plans/2026-10-28-payment-plans-slice-1.md`.
 *
 * **Late is not missed.** An instalment inside its grace days leaves the
 * plan ACTIVE and suppression intact — defaulting there was the first
 * draft's behaviour and it contradicted the CSR panel, which shows
 * "1 payment behind" as a state a plan can be in.
 *
 * Every term read here comes from the plan row, frozen at agreement. A
 * plan is judged by what the customer agreed to, not by what the
 * settings screen says today.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/payment-plan/lifecycle.js");
let fix: TenantFixture;

function daysOut(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

async function reasonId(code: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code },
      select: { id: true },
    });
    return r.id;
  });
}

/** A debit, open by default, due `dueDaysAgo` ago. */
async function debit(opts: { amount: string; open?: string; dueDaysAgo?: number }) {
  const reason = await reasonId("OPENING_BALANCE");
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        type: "ADJUSTMENT_DEBIT",
        amount: opts.amount,
        openAmount: opts.open ?? opts.amount,
        effectiveDate: daysOut(-(opts.dueDaysAgo ?? 60) - 30),
        dueDate: daysOut(-(opts.dueDaysAgo ?? 60)),
        reasonId: reason,
      },
    }),
  );
}

/**
 * A plan that started `startedDaysAgo` ago over the given debits.
 *
 * Monthly, so `startedDaysAgo` of 40 puts the down payment and the
 * first instalment behind us.
 */
async function plan(opts: {
  entryIds: string[];
  startedDaysAgo: number;
  totalBalance?: string;
  downPayment?: string;
  installmentAmount?: string;
  installmentCount?: number;
  graceDays?: number;
  missedBeforeDefault?: number;
  partialInstallmentCounts?: boolean;
  currentBillCounts?: boolean;
  assessSuppressedFeesOnDefault?: boolean;
}) {
  return seedAsPlatform(async () => {
    const p = await prismaImports.prisma.paymentPlan.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        status: "ACTIVE",
        totalBalance: opts.totalBalance ?? "300.00",
        downPayment: opts.downPayment ?? "75.00",
        installmentAmount: opts.installmentAmount ?? "75.00",
        installmentFrequency: "MONTHLY",
        installmentCount: opts.installmentCount ?? 3,
        startDate: daysOut(-opts.startedDaysAgo),
        approvedBy: ACTOR,
        graceDays: opts.graceDays ?? 5,
        missedBeforeDefault: opts.missedBeforeDefault ?? 1,
        partialInstallmentCounts: opts.partialInstallmentCounts ?? false,
        currentBillCounts: opts.currentBillCounts ?? true,
        suppressFeesWhileKept: true,
        assessSuppressedFeesOnDefault: opts.assessSuppressedFeesOnDefault ?? false,
      },
      select: { id: true },
    });
    await prismaImports.prisma.paymentPlanDebit.createMany({
      data: opts.entryIds.map((entryId) => ({
        utilityId: TENANT_A,
        planId: p.id,
        entryId,
      })),
    });
    return p.id;
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

/** Move a covered debit's open amount, as a payment would. */
async function settle(entryId: string, to: string) {
  await seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.update({
      where: { id: entryId },
      data: { openAmount: to },
    }),
  );
}

async function feeCount(): Promise<number> {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.count({
      where: { utilityId: TENANT_A, type: "FEE" },
    }),
  );
}

const sweep = () => runAsTenant(TENANT_A, async () => svc.sweepPaymentPlans(TENANT_A));

/**
 * Bring `Account.balance` and `lastDueDate` back in step with the
 * ledger.
 *
 * `evaluateAll` still selects accounts on the cached balance before it
 * reads the ledger for the age, so a test that writes debits directly
 * and never recomputes has an account the ladder cannot see. The plan
 * sweep reads the ledger and needs no cache, which is why only the
 * ordering tests below call this.
 */
const recompute = () =>
  runAsTenant(TENANT_A, async () => {
    const { recomputeAccountCache } = await import("../../services/ar/posting.service.js");
    return recomputeAccountCache(prismaImports.prisma, TENANT_A, fix.accountId);
  });

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
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
  sendNotification.mockClear();
  await resetDb();
  await truncateTables(
    "payment_plan_debit, payment_plan, delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, user_role, cis_user, role, utility_module, audit_log",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
  });
});

describe("planProgress", () => {
  /*
   * A pure function, so the arithmetic is testable without a database
   * — and so the CSR panel and the sweep cannot disagree about whether
   * a customer is behind. The status enum says ACTIVE either way.
   */
  const terms = {
    totalBalance: "300.00",
    downPayment: "75.00",
    installmentAmount: "75.00",
    installmentCount: 3,
    installmentFrequency: "MONTHLY" as const,
    graceDays: 5,
    missedBeforeDefault: 1,
    partialInstallmentCounts: false,
  };

  it("calls a plan on track when the down payment has arrived and nothing else is due", async () => {
    const p = svc.planProgress(
      { ...terms, startDate: daysOut(-1) },
      "75.00",
      daysOut(0),
    );
    expect(p.onTrack).toBe(true);
    expect(p.late).toBe(0);
    expect(p.missed).toBe(0);
    expect(p.remaining).toBe("225.00");
  });

  it("counts an instalment late the day after its date, and not missed yet", async () => {
    // 31 days in, monthly: the down payment and instalment 1 are due.
    // Only the down payment has been paid.
    const p = svc.planProgress({ ...terms, startDate: daysOut(-31) }, "75.00", daysOut(0));
    expect(p.late).toBe(1);
    expect(p.missed).toBe(0);
    expect(p.onTrack).toBe(false);
  });

  it("counts it missed once grace has expired", async () => {
    // 36 days in: instalment 1 was due at day 30ish and grace is 5.
    const p = svc.planProgress({ ...terms, startDate: daysOut(-40) }, "75.00", daysOut(0));
    expect(p.missed).toBe(1);
  });

  it("treats a part payment as a miss unless the tenant says otherwise", async () => {
    // $30 toward a $75 instalment, with the down payment already paid.
    const short = svc.planProgress({ ...terms, startDate: daysOut(-40) }, "105.00", daysOut(0));
    expect(short.missed).toBe(1);

    const lenient = svc.planProgress(
      { ...terms, partialInstallmentCounts: true, startDate: daysOut(-40) },
      "105.00",
      daysOut(0),
    );
    expect(lenient.missed).toBe(0);
  });

  it("does not call a payment late on the day it falls due", async () => {
    /*
     * Design §7's table: **Due** is "the date has arrived, nothing has
     * happened yet"; **Late** is "the date has passed". A plan starting
     * on the customer's payday was being reported as a payment behind
     * at 03:00 that same morning, and the notice fired before the money
     * could arrive.
     */
    const p = svc.planProgress({ ...terms, startDate: daysOut(0) }, "0.00", daysOut(0));
    expect(p.due).toBe(1);
    expect(p.late).toBe(0);
    expect(p.onTrack).toBe(true);
  });

  it("calls it late the day after", async () => {
    const p = svc.planProgress({ ...terms, startDate: daysOut(-1) }, "0.00", daysOut(0));
    expect(p.late).toBe(1);
  });

  it("reports what is left, which is the figure a CSR reads out", async () => {
    const p = svc.planProgress({ ...terms, startDate: daysOut(-40) }, "150.00", daysOut(0));
    expect(p.remaining).toBe("150.00");
  });
});

describe("sweepPaymentPlans — defaulting", () => {
  it("leaves a plan active while an instalment is late but inside grace", async () => {
    // Late by a day with graceDays 5. Suppression holds, and that is
    // the state the CSR panel calls "1 payment behind".
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 31 });
    await settle(d.id, "225.00"); // the down payment arrived

    const result = await sweep();

    expect(result.defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("reports how many instalments are late, which the status cannot", async () => {
    const d = await debit({ amount: "300.00" });
    await plan({ entryIds: [d.id], startedDaysAgo: 31 });
    await settle(d.id, "225.00");

    const result = await sweep();

    expect(result.late).toEqual([{ planId: expect.any(String), lateInstallments: 1 }]);
  });

  it("notifies once when an instalment goes late, not on every sweep", async () => {
    // Nobody is defaulted silently, and nobody is told five times.
    const d = await debit({ amount: "300.00" });
    await plan({ entryIds: [d.id], startedDaysAgo: 31, graceDays: 20 });
    await settle(d.id, "225.00");

    expect((await sweep()).notified).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);

    expect((await sweep()).notified).toBe(0);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies again when a second instalment goes late", async () => {
    // Once per instalment, not once per plan: a customer two payments
    // behind has been told twice, which is what the record should say.
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 31, graceDays: 400 });
    await settle(d.id, "225.00");
    expect((await sweep()).notified).toBe(1);

    await seedAsPlatform(async () =>
      prismaImports.prisma.paymentPlan.update({
        where: { id: planId },
        data: { startDate: daysOut(-62) },
      }),
    );

    expect((await sweep()).notified).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("misses an instalment once grace expires, and defaults at the threshold", async () => {
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 40, graceDays: 5 });
    await settle(d.id, "225.00");

    const result = await sweep();

    expect(result.defaulted).toBe(1);
    expect(await statusOf(planId)).toBe("DEFAULTED");
  });

  it("waits for the threshold when the tenant allows more than one miss", async () => {
    const d = await debit({ amount: "300.00" });
    const planId = await plan({
      entryIds: [d.id],
      startedDaysAgo: 40,
      graceDays: 5,
      missedBeforeDefault: 2,
    });
    await settle(d.id, "225.00");

    expect((await sweep()).defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("treats a part payment as a miss unless the tenant says otherwise", async () => {
    // $30 against a $75 instalment, down payment already paid.
    const d = await debit({ amount: "300.00" });
    const strict = await plan({ entryIds: [d.id], startedDaysAgo: 40 });
    await settle(d.id, "195.00");

    expect((await sweep()).defaulted).toBe(1);
    expect(await statusOf(strict)).toBe("DEFAULTED");
  });

  it("defaults a plan when a bill outside it goes unpaid past its due date", async () => {
    /*
     * The hole the first draft had: paying every instalment while never
     * paying a new bill kept the plan, and its suppression, alive. The
     * plan here is perfectly kept.
     */
    const covered = await debit({ amount: "300.00" });
    await debit({ amount: "40.00", dueDaysAgo: 3 });
    const planId = await plan({ entryIds: [covered.id], startedDaysAgo: 1 });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(1);
    expect(await statusOf(planId)).toBe("DEFAULTED");
  });

  it("does not default on an uncovered bill due today", async () => {
    /*
     * The sweep runs at 03:00. A customer whose bill falls due today
     * and who posts a cheque that afternoon was being defaulted that
     * morning — and because the plan sweep runs before the ladder, the
     * same tick then charged every tier the released arrears qualified
     * for. The design says "unpaid **past** its due date", and the
     * Illinois rule it cites allows until the second day after.
     */
    const covered = await debit({ amount: "300.00" });
    await debit({ amount: "40.00", dueDaysAgo: 0 });
    const planId = await plan({ entryIds: [covered.id], startedDaysAgo: 1 });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("defaults on an uncovered bill once a day has passed", async () => {
    const covered = await debit({ amount: "300.00" });
    await debit({ amount: "40.00", dueDaysAgo: 1 });
    const planId = await plan({ entryIds: [covered.id], startedDaysAgo: 1 });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(1);
    expect(await statusOf(planId)).toBe("DEFAULTED");
  });

  it("does not default on an uncovered bill that is not yet due", async () => {
    const covered = await debit({ amount: "300.00" });
    await debit({ amount: "40.00", dueDaysAgo: -7 });
    const planId = await plan({ entryIds: [covered.id], startedDaysAgo: 1 });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("does not default a plan on an account with nothing uncovered", async () => {
    // "No uncovered debt" is not "an unpaid current bill". The second
    // test has nothing to look at and must not therefore fire.
    const covered = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [covered.id], startedDaysAgo: 1 });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("ignores an uncovered bill when the tenant's rule does not look at it", async () => {
    const covered = await debit({ amount: "300.00" });
    await debit({ amount: "40.00", dueDaysAgo: 3 });
    const planId = await plan({
      entryIds: [covered.id],
      startedDaysAgo: 1,
      currentBillCounts: false,
    });
    await settle(covered.id, "225.00");

    expect((await sweep()).defaulted).toBe(0);
    expect(await statusOf(planId)).toBe("ACTIVE");
  });

  it("leaves already-charged fees alone on default by default", async () => {
    // assessSuppressedFeesOnDefault is false unless a tenant says so,
    // and the true path is slice 2's — it needs the skipped fees
    // recorded when they were skipped.
    const d = await debit({ amount: "300.00" });
    await plan({ entryIds: [d.id], startedDaysAgo: 40 });
    await settle(d.id, "225.00");
    const before = await feeCount();

    expect((await sweep()).defaulted).toBe(1);

    expect(await feeCount()).toBe(before);
  });

  it("completes rather than defaults when the debts are gone", async () => {
    // A plan cannot be both satisfied and broken, and the answer must
    // not depend on which test ran first. Settled late still completes.
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 400 });
    await settle(d.id, "0.00");

    const result = await sweep();

    expect(result).toMatchObject({ completed: 1, defaulted: 0 });
    expect(await statusOf(planId)).toBe("COMPLETED");
  });

  it("does not record a notice the tenant has no template for", async () => {
    /*
     * `sendNotification` answers null when no template exists, and the
     * watermark used to advance anyway — recording that the customer
     * had been told when nothing was sent, then defaulting them days
     * later. "Nobody is defaulted silently" is why the Late state and
     * the watermark exist at all.
     */
    sendNotification.mockResolvedValueOnce(null as never);
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 31, graceDays: 20 });
    await settle(d.id, "225.00");

    expect((await sweep()).notified).toBe(0);
    const row = await seedAsPlatform(async () =>
      prismaImports.prisma.paymentPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { lateNoticeInstallment: true },
      }),
    );
    // Still unasked, so the next sweep asks again.
    expect(row.lateNoticeInstallment).toBeNull();
  });

  it("records a completion in the audit log, as it does a default", async () => {
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 40 });
    await settle(d.id, "0.00");

    expect((await sweep()).completed).toBe(1);

    const rows = await seedAsPlatform(async () =>
      prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityType: "PaymentPlan", entityId: planId },
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it("records the default in the audit log", async () => {
    const d = await debit({ amount: "300.00" });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 40 });
    await settle(d.id, "225.00");

    await sweep();

    const rows = await seedAsPlatform(async () =>
      prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityType: "PaymentPlan", entityId: planId },
      }),
    );
    expect(rows).toHaveLength(1);
  });
});

/**
 * The order of the nightly passes, which is the part with consequences.
 *
 * A plan that defaults tonight must be chaseable tonight: the ladder's
 * suppression reads plan state, so running it before the plan sweep
 * leaves a defaulted plan's debts untouched for a further day. The
 * order lives in `runDelinquencyPasses` rather than inlined in the
 * worker's job handler precisely so this can be asserted without
 * standing up BullMQ and Redis.
 */
describe("runDelinquencyPasses", () => {
  it("charges a plan that defaults on this tick, on this tick", async () => {
    const passes = await import("../../services/delinquency-passes.js");

    // A tier that charges, and a plan about to break on a missed
    // instalment.
    const late = await reasonId("LATE_FEE");
    await seedAsPlatform(async () =>
      prismaImports.prisma.delinquencyRule.create({
        data: {
          utilityId: TENANT_A,
          name: "Tier 1",
          tier: 1,
          daysPastDue: 10,
          minBalance: "1.00",
          actionType: "NOTICE_EMAIL",
          autoApply: true,
          isActive: true,
          effectiveDate: daysOut(-365),
          feeType: "FLAT_FEE",
          feeAmount: "25.00",
          feeReasonId: late,
          feeMode: "ACCUMULATE",
        },
      }),
    );
    const d = await debit({ amount: "300.00", dueDaysAgo: 90 });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 40, graceDays: 5 });
    await settle(d.id, "225.00");
    await recompute();

    // Suppressed before the run: the plan is still ACTIVE.
    expect(await feeCount()).toBe(0);

    await runAsTenant(TENANT_A, async () => passes.runDelinquencyPasses(TENANT_A));

    expect(await statusOf(planId)).toBe("DEFAULTED");
    // The same tick charged it. Reverse the two passes and this is 0.
    expect(await feeCount()).toBe(1);
  });

  it("stops suppressing a completed plan in the same tick", async () => {
    const passes = await import("../../services/delinquency-passes.js");
    const d = await debit({ amount: "300.00", dueDaysAgo: 90 });
    const planId = await plan({ entryIds: [d.id], startedDaysAgo: 40 });
    await settle(d.id, "0.00");
    await recompute();

    const result = await runAsTenant(TENANT_A, async () =>
      passes.runDelinquencyPasses(TENANT_A),
    );

    expect(result.plans.completed).toBe(1);
    expect(await statusOf(planId)).toBe("COMPLETED");
    // Nothing is owed, so nothing is charged — the point is that the
    // ladder saw the completion rather than a live plan.
    expect(await feeCount()).toBe(0);
  });
});
