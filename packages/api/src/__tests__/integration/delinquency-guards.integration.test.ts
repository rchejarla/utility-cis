import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  seedAsPlatform,
  endAdminPool,
  truncateTables,
  ACTOR,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/*
 * `evaluateAll` sends notices, which enqueue. Mocked so a run leaves
 * nothing behind in the dev Redis that looks like real stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * The two guards the delinquency ladder was missing.
 *
 * Task 1 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 * Both defects are live today and both become money defects as soon as a
 * tier charges a fee, which is why they are fixed before it does.
 *
 * 1. Duplicate actions. The sweep runs on `0 * * * *` with BullMQ
 *    retries behind it, and the only guard is an in-memory `Set` built
 *    before the loop — two worker processes build it separately and
 *    neither sees the other's writes. A database constraint is the only
 *    guard that spans processes.
 *
 * 2. A tier reaching backwards. `DelinquencyRule.effectiveDate` exists
 *    and the matching filter ignores it, so configuring a tier today
 *    fires it against every historically past-due account. It is gated
 *    against `lastDueDate` rather than against today, because the
 *    question is whether the rule was in force when the debt came due.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/delinquency.service.js");
let fix: TenantFixture;

const evaluateAll = (...args: Parameters<typeof svc.evaluateAll>) =>
  runAsTenant(args[0], async () => svc.evaluateAll(...args));

/** A UTC-midnight date `n` days back — both columns here are `@db.Date`. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * A tier that notices and nothing more.
 *
 * `effectiveDate` defaults to a year back so a case that is not about
 * the gate does not trip it; `notificationEventType` is left null so no
 * template is needed and the action lands PENDING.
 */
async function rule(opts: { tier: number; daysPastDue: number; effectiveDate?: Date }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyRule.create({
      data: {
        utilityId: TENANT_A,
        name: `Tier ${opts.tier}`,
        tier: opts.tier,
        daysPastDue: opts.daysPastDue,
        minBalance: "1.00",
        actionType: "NOTICE_EMAIL",
        autoApply: true,
        isActive: true,
        effectiveDate: opts.effectiveDate ?? daysAgo(365),
      },
    }),
  );
}

/**
 * The fixture account, made past due by `days` with `balance` owing.
 *
 * A real open debit, and the cache recomputed from it by the production
 * path. The ladder ages from the oldest open debit no live plan covers,
 * read from `ledger_entry` — so an account whose `balance` and
 * `lastDueDate` were written by hand with nothing behind them is now
 * invisible to the sweep, exactly as an account with no debts should
 * be. `recomputeAccountCache` doing the arithmetic is also what keeps
 * the fixture honest: the cache and the ledger cannot drift apart here
 * in a way the real system never would.
 */
async function pastDue(opts: { balance: string; days: number }) {
  await seedAsPlatform(async () => {
    const reason = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code: "OPENING_BALANCE" },
      select: { id: true },
    });
    await prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        type: "ADJUSTMENT_DEBIT",
        amount: opts.balance,
        openAmount: opts.balance,
        effectiveDate: daysAgo(opts.days + 30),
        dueDate: daysAgo(opts.days),
        reasonId: reason.id,
      },
    });
  });
  return runAsTenant(TENANT_A, async () => {
    const { recomputeAccountCache } = await import("../../services/ar/posting.service.js");
    return recomputeAccountCache(prismaImports.prisma, TENANT_A, fix.accountId);
  });
}

async function countActions(): Promise<number> {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.count({ where: { utilityId: TENANT_A } }),
  );
}

/** What a second worker's write looks like, with the Set out of the way. */
async function insertActionDirectly(opts: { ruleId: string; tier?: number }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        ruleId: opts.ruleId,
        tier: opts.tier ?? 1,
        actionType: "NOTICE_EMAIL",
        status: "PENDING",
        balanceAtAction: "100.00",
        daysPastDueAtAction: 15,
        triggeredBy: "AUTOMATED",
      },
    }),
  );
}

/**
 * Set every action RESOLVED directly rather than through
 * `resolveAccount`, which cancels PENDING rows and promotes only the
 * highest remaining tier. What is under test is the index predicate.
 */
async function resolveActions() {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.updateMany({
      where: { utilityId: TENANT_A },
      data: { status: "RESOLVED", resolvedAt: new Date(), resolutionType: "PAID" },
    }),
  );
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/delinquency.service.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  // payment_plan_debit before ledger_entry: the key is RESTRICT.
  await truncateTables(
    "payment_plan_debit, payment_plan, delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  // `pastDue` writes a real debit now, and an ADJUSTMENT_DEBIT needs a
  // reason (`ledger_entry_reason_required`).
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
  });
});

describe("one live action per tier", () => {
  it("creates one action per rule however many times it is evaluated", async () => {
    await rule({ tier: 1, daysPastDue: 10 });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(1);
  });

  /*
   * Review Focus 1, at the level the `Set` cannot reach. A direct insert
   * is what the second worker's write looks like: it never consulted the
   * first worker's `Set`, so only the database can refuse it.
   */
  it("refuses a second live action for the same account and rule", async () => {
    const r = await rule({ tier: 1, daysPastDue: 10 });
    await pastDue({ balance: "100.00", days: 15 });
    await evaluateAll(TENANT_A);

    await expect(insertActionDirectly({ ruleId: r.id })).rejects.toThrow(/unique/i);
  });

  /*
   * The index has to be partial. A resolved action is history, and
   * history must not stop the account entering the tier again.
   */
  it("lets the account re-enter a tier once the action is resolved", async () => {
    await rule({ tier: 1, daysPastDue: 10 });
    await pastDue({ balance: "100.00", days: 15 });
    await evaluateAll(TENANT_A);

    await resolveActions();
    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(2);
  });
});

describe("a tier does not reach back before it existed", () => {
  /*
   * Review Focus 2. Today this creates an action, which is the bug: the
   * rule was configured five days ago and the debt came due thirty days
   * ago, so the rule was not in force when the account fell behind.
   */
  it("does not fire a tier configured after the debt came due", async () => {
    await pastDue({ balance: "100.00", days: 30 });
    await rule({ tier: 1, daysPastDue: 10, effectiveDate: daysAgo(5) });

    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(0);
  });

  it("fires a tier that was in force when the debt came due", async () => {
    await pastDue({ balance: "100.00", days: 30 });
    await rule({ tier: 1, daysPastDue: 10, effectiveDate: daysAgo(60) });

    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(1);
  });

  it("fires a tier that came into force on the day the debt came due", async () => {
    await pastDue({ balance: "100.00", days: 30 });
    await rule({ tier: 1, daysPastDue: 10, effectiveDate: daysAgo(30) });

    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(1);
  });

  /*
   * The escalation ladder is existing behaviour and the gate must not
   * cost it: fifty days past due, against tiers at 15, 30 and 45, is
   * three actions and not one.
   */
  it("still charges every tier the account has passed", async () => {
    await rule({ tier: 1, daysPastDue: 15 });
    await rule({ tier: 2, daysPastDue: 30 });
    await rule({ tier: 3, daysPastDue: 45 });
    await pastDue({ balance: "100.00", days: 50 });

    await evaluateAll(TENANT_A);

    expect(await countActions()).toBe(3);
  });
});
