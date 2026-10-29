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
import { DEFAULT_PLAN_TERMS } from "@utility-cis/shared";

/*
 * Agreeing a plan resolves the account's delinquency actions, and
 * resolving one can enqueue. Mocked so a run leaves nothing behind in
 * the dev Redis that looks like real stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * Agreeing a deferred payment agreement.
 *
 * Task 4 of `docs/superpowers/plans/2026-10-28-payment-plans-slice-1.md`.
 *
 * Nothing here touches the ledger. A plan governs *when* money is
 * chased, not *what* is owed: no entry is posted, no debt is moved and
 * `Account.balance` is untouched — which is what lets every balance
 * query stay ignorant of plans. The tests assert that explicitly,
 * because the tempting implementation (move the arrears onto the plan,
 * as Oracle CC&B does) would pass every other case here.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/payment-plan/create.js");
let fix: TenantFixture;

/** A UTC-midnight date `n` days from today; negative is the past. */
function daysOut(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(daysOut(0));

async function reasonId(code: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code },
      select: { id: true },
    });
    return r.id;
  });
}

/**
 * An open debit on the account.
 *
 * `openAmount` is set apart from `amount` so a part-paid charge can be
 * built without driving the payment path — the distinction the frozen
 * balance turns on.
 */
async function debit(opts: {
  type?: "ADJUSTMENT_DEBIT" | "FEE" | "BILL_CHARGE";
  amount: string;
  open?: string;
  dueDaysAgo?: number;
  /** Null for a BILL_CHARGE, which carries no reason — the bill is why. */
  reasonCode?: string | null;
  accountId?: string;
  billId?: string;
}) {
  const code = opts.reasonCode === undefined ? "OPENING_BALANCE" : opts.reasonCode;
  const reason = code === null ? null : await reasonId(code);
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: opts.accountId ?? fix.accountId,
        type: opts.type ?? "ADJUSTMENT_DEBIT",
        amount: opts.amount,
        openAmount: opts.open ?? opts.amount,
        effectiveDate: daysOut(-(opts.dueDaysAgo ?? 30) - 30),
        dueDate: daysOut(-(opts.dueDaysAgo ?? 30)),
        reasonId: reason,
        billId: opts.billId ?? null,
      },
    }),
  );
}

/**
 * A posted bill, so a `BILL_CHARGE` debit can exist at all.
 *
 * `ledger_entry_bill_charge_has_bill` is a CHECK: a charge of that type
 * must name the bill it came from, which is the invariant the AR tab's
 * Bill column and the plan's covered-debt list both read.
 */
async function bill(opts: { total: string; dueDaysAgo: number }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.bill.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        billingCycleId: fix.billingCycleId,
        billNumber: `BILL-TEST-${Math.floor(Math.random() * 1e6)}`,
        periodStart: daysOut(-(opts.dueDaysAgo + 60)),
        periodEnd: daysOut(-(opts.dueDaysAgo + 30)),
        billDate: daysOut(-(opts.dueDaysAgo + 30)),
        dueDate: daysOut(-opts.dueDaysAgo),
        subtotal: opts.total,
        taxes: "0.00",
        credits: "0.00",
        total: opts.total,
      },
    }),
  );
}

async function setTerms(over: Record<string, unknown>) {
  await seedAsPlatform(async () => {
    await prismaImports.prisma.utilityConfig.update({
      where: { utilityId: TENANT_A },
      data: { settings: { paymentPlans: { ...DEFAULT_PLAN_TERMS, ...over } } },
    });
  });
}

type CreateInput = Parameters<typeof svc.createPaymentPlan>[4];

function create(input: Partial<CreateInput> & { entryIds: string[] }) {
  return runAsTenant(TENANT_A, async () =>
    svc.createPaymentPlan(TENANT_A, ACTOR, "Tester", fix.accountId, {
      installmentCount: 6,
      startDate: today(),
      ...input,
    } as CreateInput),
  );
}

async function planRow(planId: string) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.paymentPlan.findUniqueOrThrow({ where: { id: planId } }),
  );
}

async function ledgerCount(): Promise<number> {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.count({ where: { utilityId: TENANT_A } }),
  );
}

async function accountBalance(): Promise<string> {
  const a = await seedAsPlatform(async () =>
    prismaImports.prisma.account.findUniqueOrThrow({
      where: { id: fix.accountId },
      select: { balance: true },
    }),
  );
  return a.balance.toString();
}

/** A live tier-1 action, as the ladder would have filed it. */
async function liveAction() {
  const rule = await seedAsPlatform(async () =>
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
      },
    }),
  );
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        ruleId: rule.id,
        tier: 1,
        actionType: "NOTICE_EMAIL",
        status: "PENDING",
        triggeredBy: "SWEEP",
        balanceAtAction: "468.17",
        daysPastDueAtAction: 30,
      },
    }),
  );
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/payment-plan/create.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  // payment_plan_debit before ledger_entry: the key is RESTRICT, so the
  // child has to go first.
  await truncateTables(
    "payment_plan_debit, payment_plan, delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, user_role, cis_user, role, utility_module",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
  });
});

describe("createPaymentPlan", () => {
  it("freezes the balance from what is still open, not the face value", async () => {
    // A $100 charge with $40 paid contributes $60.
    const partPaid = await debit({ amount: "100.00", open: "60.00" });
    const result = await create({ entryIds: [partPaid.id], installmentCount: 3 });

    expect(result.totalBalance).toBe("60.00");
  });

  it("writes no ledger entry and does not move the balance", async () => {
    // The whole premise: a plan changes when money is chased, not what
    // is owed. Moving the debt onto the plan would pass every other
    // test in this file.
    const d = await debit({ amount: "400.00" });
    const { recomputeAccountCache } = await import("../../services/ar/posting.service.js");
    await runAsTenant(TENANT_A, async () =>
      recomputeAccountCache(prismaImports.prisma, TENANT_A, fix.accountId),
    );
    const before = await accountBalance();
    const entriesBefore = await ledgerCount();

    await create({ entryIds: [d.id], installmentCount: 4 });

    expect(await ledgerCount()).toBe(entriesBefore);
    expect(await accountBalance()).toBe(before);
  });

  it("builds a schedule that sums to the balance exactly, odd cents first", async () => {
    // The design's own worked example: 412.80 + 55.37 + 25.00 + 10.00,
    // 25% down, six monthly. 503.17 - 125.79 = 377.38, which does not
    // divide by six, so the first instalment carries the extra 4c and
    // the customer's last payment is the round one.
    const ids = [
      (await debit({ amount: "412.80" })).id,
      (await debit({ amount: "55.37" })).id,
      (await debit({ amount: "25.00", type: "FEE", reasonCode: "LATE_FEE" })).id,
      (await debit({ amount: "10.00", type: "FEE", reasonCode: "LATE_FEE" })).id,
    ];

    const result = await create({ entryIds: ids, installmentCount: 6 });

    expect(result.totalBalance).toBe("503.17");
    expect(result.downPayment).toBe("125.79");
    expect(result.installmentAmount).toBe("62.89");
    expect(result.schedule.map((s) => s.amount)).toEqual([
      "125.79",
      "62.93",
      "62.89",
      "62.89",
      "62.89",
      "62.89",
      "62.89",
    ]);

    const total = result.schedule.reduce((sum, s) => sum + Number(s.amount), 0);
    expect(total.toFixed(2)).toBe("503.17");
  });

  it("dates the down payment on the start date and spaces the rest monthly", async () => {
    // The 15th of next month, computed rather than written down: a
    // literal date here would pass today and start failing the day it
    // went past. The bound has to be raised to reach it at all.
    await setTerms({ maxStartDateDays: 365 });
    const start = new Date(
      Date.UTC(daysOut(0).getUTCFullYear(), daysOut(0).getUTCMonth() + 1, 15),
    );
    const d = await debit({ amount: "600.00" });
    const result = await create({
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(start),
      downPayment: "150.00",
    });

    const dates = result.schedule.map((s) => s.dueDate);
    expect(dates[0]).toBe(iso(start));
    // The 15th stays the 15th, and each instalment is one month on.
    expect(dates.every((d) => d.endsWith("-15"))).toBe(true);
    expect(dates).toHaveLength(4);
    const months = dates.map((d) => Number(d.slice(5, 7)));
    for (let i = 1; i < months.length; i++) {
      expect((months[i]! - months[i - 1]! + 12) % 12).toBe(1);
    }
  });

  it("clamps a month-end start date rather than slipping into the next month", async () => {
    // A plan starting on the 31st pays on the 30th in a 30-day month,
    // which is what every schedule a customer has ever been handed
    // does. Date arithmetic that rolls over would move it to the 1st
    // and quietly shift every later instalment with it.
    await setTerms({ maxStartDateDays: 365 });
    const d = await debit({ amount: "900.00" });
    const result = await create({
      entryIds: [d.id],
      installmentCount: 3,
      startDate: "2027-01-31",
      downPayment: "300.00",
    });

    expect(result.schedule.map((s) => s.dueDate)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
  });

  it("copies the tenant's terms onto the plan, so a later edit cannot re-term it", async () => {
    await setTerms({ graceDays: 2, missedInstallmentsBeforeDefault: 3 });
    const d = await debit({ amount: "300.00" });
    const result = await create({ entryIds: [d.id], installmentCount: 3 });

    const row = await planRow(result.planId);
    expect(row.graceDays).toBe(2);
    expect(row.missedBeforeDefault).toBe(3);

    // Change the policy; the running plan keeps what was agreed.
    await setTerms({ graceDays: 30, missedInstallmentsBeforeDefault: 1 });
    const after = await planRow(result.planId);
    expect(after.graceDays).toBe(2);
    expect(after.missedBeforeDefault).toBe(3);
  });

  it("defaults the down payment from the tenant's percentage", async () => {
    await setTerms({ downPaymentPercent: 10 });
    const d = await debit({ amount: "500.00" });
    const result = await create({ entryIds: [d.id], installmentCount: 5 });

    expect(result.downPayment).toBe("50.00");
  });

  it("accepts an explicit down payment below the policy figure", async () => {
    // "Lower it if the customer cannot manage it" — the percentage is a
    // proposal, not a floor.
    const d = await debit({ amount: "500.00" });
    const result = await create({
      entryIds: [d.id],
      installmentCount: 5,
      downPayment: "20.00",
    });

    expect(result.downPayment).toBe("20.00");
  });

  it("refuses a down payment that covers the whole balance", async () => {
    // Nothing would be left to pay by instalments, and
    // installment_amount > 0 is a CHECK constraint — better a named
    // refusal than a 23514.
    const d = await debit({ amount: "500.00" });
    await expect(
      create({ entryIds: [d.id], installmentCount: 5, downPayment: "500.00" }),
    ).rejects.toMatchObject({ code: "DOWN_PAYMENT_LEAVES_NOTHING" });
  });

  it("refuses an instalment count outside the tenant's terms, naming the bound", async () => {
    const d = await debit({ amount: "300.00" });
    await expect(create({ entryIds: [d.id], installmentCount: 2 })).rejects.toMatchObject({
      code: "INSTALLMENTS_BELOW_MINIMUM",
    });
    await expect(create({ entryIds: [d.id], installmentCount: 13 })).rejects.toMatchObject({
      code: "INSTALLMENTS_ABOVE_MAXIMUM",
    });
  });

  it("refuses a debit that already belongs to a LIVE plan", async () => {
    // Named rather than left to a constraint: a P2002 tells a CSR
    // nothing about which debt is the problem.
    const d = await debit({ amount: "300.00" });
    const second = await debit({ amount: "100.00" });
    await create({ entryIds: [d.id], installmentCount: 3 });

    await expect(
      create({ entryIds: [d.id, second.id], installmentCount: 3 }),
    ).rejects.toMatchObject({ code: "PLAN_ALREADY_ACTIVE" });
  });

  it("lets a cancelled plan's debts into a new plan", async () => {
    /*
     * The dead end this test exists for. The join rows persist as
     * history, so a check that asked only "is this debit in the join
     * table" locked every covered debt out of every future plan — while
     * the service's own refusal told the CSR to "cancel it before
     * agreeing another", which was the one action that made agreeing
     * another impossible. A mistyped instalment count was unrecoverable
     * short of a database edit.
     */
    const d = await debit({ amount: "300.00" });
    const first = await create({ entryIds: [d.id], installmentCount: 3 });
    await cancel(first.planId);

    const second = await create({ entryIds: [d.id], installmentCount: 6 });

    expect(second.planId).not.toBe(first.planId);
    expect(second.coveredEntryIds).toEqual([d.id]);
  });

  it("lets a defaulted plan's debts into a second plan, which the terms allow", async () => {
    // Montana leaves it to the utility; Iowa *requires* offering one
    // after two consecutive payments under the first. Neither permits a
    // flat refusal in code.
    const d = await debit({ amount: "300.00" });
    const first = await create({ entryIds: [d.id], installmentCount: 3 });
    await markDefaulted(first.planId);

    const second = await create({ entryIds: [d.id], installmentCount: 6 });

    expect(second.planId).not.toBe(first.planId);
  });

  it("refuses a second plan after a default when the tenant forbids it", async () => {
    // `allowSecondPlanAfterDefault` had a control on the terms screen
    // and no reader: an operator could untick it and nothing changed.
    await setTerms({ allowSecondPlanAfterDefault: false });
    const d = await debit({ amount: "300.00" });
    const first = await create({ entryIds: [d.id], installmentCount: 3 });
    await markDefaulted(first.planId);

    await expect(create({ entryIds: [d.id], installmentCount: 6 })).rejects.toMatchObject({
      code: "SECOND_PLAN_NOT_ALLOWED",
    });
  });

  it("allows a plan after a COMPLETED one even when a second-after-default is forbidden", async () => {
    // The term is about breaking a plan, not about having had one.
    await setTerms({ allowSecondPlanAfterDefault: false });
    const d = await debit({ amount: "300.00" });
    const first = await create({ entryIds: [d.id], installmentCount: 3 });
    await markCompleted(first.planId);

    const second = await create({ entryIds: [d.id], installmentCount: 6 });

    expect(second.planId).not.toBe(first.planId);
  });

  it("refuses a plan over a debit covered by a live plan on the same account", async () => {
    // Belt and braces under the one-live-plan-per-account rule: with
    // uniqueness relaxed to live plans only, the service is what keeps
    // a debit out of two at once.
    const d = await debit({ amount: "300.00" });
    const result = await create({ entryIds: [d.id], installmentCount: 3 });
    expect(result.planId).toBeTruthy();
    await expect(create({ entryIds: [d.id], installmentCount: 3 })).rejects.toMatchObject({
      code: "PLAN_ALREADY_ACTIVE",
    });
  });

  it("refuses a plan over no open debits", async () => {
    await expect(create({ entryIds: [] })).rejects.toMatchObject({
      code: "NOTHING_TO_COVER",
    });
  });

  it("refuses a plan whose debits are all already settled", async () => {
    // A plan with nothing to collect is not a plan; it would be created
    // and complete on the very next sweep.
    const settled = await debit({ amount: "100.00", open: "0.00" });
    await expect(
      create({ entryIds: [settled.id], installmentCount: 3 }),
    ).rejects.toMatchObject({ code: "NOTHING_TO_COVER" });
  });

  it("refuses a debit belonging to another account", async () => {
    // Otherwise one customer's plan could suppress another's arrears.
    const other = await seedAsPlatform(async () =>
      prismaImports.prisma.account.create({
        data: {
          utilityId: TENANT_A,
          accountNumber: "OTHER-1",
          customerId: null,
          billingCycleId: fix.billingCycleId,
          accountType: "RESIDENTIAL",
          status: "ACTIVE",
        },
      }),
    );
    const theirs = await debit({ amount: "200.00", accountId: other.id });

    await expect(
      create({ entryIds: [theirs.id], installmentCount: 3 }),
    ).rejects.toMatchObject({ code: "ENTRY_NOT_ON_ACCOUNT" });
  });

  it("refuses a second active plan on one account", async () => {
    // Nothing in the schema stops two plans existing; the service must.
    const a = await debit({ amount: "300.00" });
    const b = await debit({ amount: "200.00" });
    await create({ entryIds: [a.id], installmentCount: 3 });

    await expect(create({ entryIds: [b.id], installmentCount: 3 })).rejects.toMatchObject({
      code: "PLAN_ALREADY_ACTIVE",
    });
  });

  it("refuses a start date in the past", async () => {
    const d = await debit({ amount: "300.00" });
    await expect(
      create({ entryIds: [d.id], installmentCount: 3, startDate: iso(daysOut(-1)) }),
    ).rejects.toMatchObject({ code: "START_DATE_IN_PAST" });
  });

  it("refuses a start date further out than the tenant allows", async () => {
    const d = await debit({ amount: "300.00" });
    await expect(
      create({ entryIds: [d.id], installmentCount: 3, startDate: iso(daysOut(30)) }),
    ).rejects.toMatchObject({ code: "START_DATE_TOO_FAR" });
  });

  it("allows a later start date when the tenant has raised the bound", async () => {
    await setTerms({ maxStartDateDays: 45 });
    const d = await debit({ amount: "300.00" });
    const result = await create({
      entryIds: [d.id],
      installmentCount: 3,
      startDate: iso(daysOut(30)),
    });
    expect(result.planId).toBeTruthy();
  });

  it("resolves the account's live delinquency actions", async () => {
    // Otherwise the account stays in the shut-off queue with a plan on
    // it, which is exactly what the button did before.
    await liveAction();
    const d = await debit({ amount: "468.17" });

    const result = await create({ entryIds: [d.id], installmentCount: 6 });

    expect(result.actionsResolved).toBeGreaterThan(0);
    const live = await seedAsPlatform(async () =>
      prismaImports.prisma.delinquencyAction.count({
        where: { utilityId: TENANT_A, status: { in: ["PENDING", "COMPLETED"] } },
      }),
    );
    expect(live).toBe(0);
  });

  it("covers debits of every kind, not only bill charges", async () => {
    // What a real account looks like: a bill charge, a fee and an
    // adjustment that came from no bill at all.
    const ids = [
      (
        await debit({
          amount: "55.37",
          type: "BILL_CHARGE",
          reasonCode: null,
          billId: (await bill({ total: "55.37", dueDaysAgo: 44 })).id,
        })
      ).id,
      (await debit({ amount: "25.00", type: "FEE", reasonCode: "LATE_FEE" })).id,
      (await debit({ amount: "412.80", type: "ADJUSTMENT_DEBIT" })).id,
    ];

    const result = await create({ entryIds: ids, installmentCount: 6 });

    expect(result.totalBalance).toBe("493.17");
    expect(result.coveredEntryIds.sort()).toEqual([...ids].sort());
  });

  it("records who agreed it", async () => {
    const d = await debit({ amount: "300.00" });
    const result = await create({ entryIds: [d.id], installmentCount: 3 });
    expect((await planRow(result.planId)).approvedBy).toBe(ACTOR);
  });
});

async function setStatus(planId: string, status: "CANCELLED" | "DEFAULTED" | "COMPLETED") {
  await seedAsPlatform(async () =>
    prismaImports.prisma.paymentPlan.update({
      where: { id: planId },
      data: { status, statusChangedAt: new Date() },
    }),
  );
}

const cancel = (planId: string) => setStatus(planId, "CANCELLED");
const markDefaulted = (planId: string) => setStatus(planId, "DEFAULTED");
const markCompleted = (planId: string) => setStatus(planId, "COMPLETED");
