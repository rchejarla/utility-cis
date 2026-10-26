import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
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

/*
 * `evaluateAll` sends notices, which enqueue. Mocked so a run leaves
 * nothing behind in the dev Redis that looks like real stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * What a delinquency tier does to the ledger.
 *
 * Task 3 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 *
 * Until now, nothing: `delinquency.service.ts` wrote a
 * `DelinquencyAction` and a notification and no financial entry at all,
 * so the process decided an account was delinquent and produced nothing
 * that appears on a bill or in the balance.
 *
 * Which reason the fee cites is configuration on the tier, because the
 * delinquency logic cannot know it — reason codes are tenant-configurable
 * and there is no code this codebase could hardcode. The operator picks
 * it when configuring the tier, the save path refuses one that is not a
 * usable FEE reason, and `resolveReason` refuses it again at sweep time
 * for the case where it was deactivated after the rule cited it.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let svc: typeof import("../../services/delinquency.service.js");
let fix: TenantFixture;

const evaluateAll = (...args: Parameters<typeof svc.evaluateAll>) =>
  runAsTenant(args[0], async () => svc.evaluateAll(...args));

function makeToken(utilityId: string, actorId = ACTOR) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

/** A UTC-midnight date `n` days back — both date columns here are `@db.Date`. */
function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/** The id of a seeded reason, by code. */
async function reasonId(code: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
      where: { utilityId: TENANT_A, code },
      select: { id: true },
    });
    return r.id;
  });
}

/** A FEE reason of the tenant's own naming, as a second tier would cite. */
async function makeFeeReason(code: string, label: string): Promise<string> {
  return seedAsPlatform(async () => {
    const r = await prismaImports.prisma.ledgerReasonDef.create({
      data: { utilityId: TENANT_A, code, label, appliesToType: "FEE" },
    });
    return r.id;
  });
}

/** A ledger entry already on the account, as prior history. */
async function entryOf(opts: {
  type: "ADJUSTMENT_DEBIT" | "FEE";
  amount: string;
  reasonCode: string;
}) {
  const reason = await reasonId(opts.reasonCode);
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.create({
      data: {
        utilityId: TENANT_A,
        accountId: fix.accountId,
        type: opts.type,
        amount: opts.amount,
        openAmount: opts.amount,
        effectiveDate: daysAgo(40),
        dueDate: daysAgo(30),
        reasonId: reason,
      },
    }),
  );
}

/** Every fee the ladder raised, found the way replacement finds them. */
async function ladderFeeIds(): Promise<string[]> {
  return seedAsPlatform(async () => {
    const links = await prismaImports.prisma.delinquencyActionFee.findMany({
      where: { utilityId: TENANT_A },
      select: { entryId: true },
      orderBy: { createdAt: "asc" },
    });
    return links.map((l) => l.entryId);
  });
}

/** The one fee the ladder raised, for a case that expects exactly one. */
async function ladderFee() {
  const ids = await ladderFeeIds();
  expect(ids).toHaveLength(1);
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.findUniqueOrThrow({ where: { id: ids[0]! } }),
  );
}

async function ruleWithFee(opts: {
  tier?: number;
  daysPastDue?: number;
  feeType?: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  feeAmount: string | null;
  maxFee?: string;
  feeMode?: "ACCUMULATE" | "REPLACE_LOWER_TIERS";
  feeReasonId?: string | null;
}) {
  const charging = opts.feeAmount !== null;
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyRule.create({
      data: {
        utilityId: TENANT_A,
        name: `Tier ${opts.tier ?? 1}`,
        tier: opts.tier ?? 1,
        daysPastDue: opts.daysPastDue ?? 10,
        minBalance: "1.00",
        actionType: "NOTICE_EMAIL",
        autoApply: true,
        isActive: true,
        effectiveDate: daysAgo(365),
        feeType: charging ? (opts.feeType ?? "FLAT_FEE") : null,
        feeAmount: opts.feeAmount,
        maxFee: opts.maxFee ?? null,
        feeMode: opts.feeMode ?? "ACCUMULATE",
        feeReasonId: charging
          ? (opts.feeReasonId ?? (await reasonId("LATE_FEE")))
          : null,
      },
    }),
  );
}

/**
 * Unpaid bills on the account, and the cache recomputed from them.
 *
 * The ladder charges per overdue bill, so a faked `balance` with no
 * debits behind it has nothing to charge. `recomputeAccountCache` is the
 * production path that maintains `balance` and `lastDueDate`, so letting
 * it do the arithmetic is what keeps the fixture honest — the cache and
 * the ledger cannot drift apart in a way the real system never would.
 */
async function pastDueBills(bills: Array<{ amount: string; days: number }>) {
  const reason = await reasonId("OPENING_BALANCE");
  await seedAsPlatform(async () => {
    for (const bill of bills) {
      await prismaImports.prisma.ledgerEntry.create({
        data: {
          utilityId: TENANT_A,
          accountId: fix.accountId,
          type: "ADJUSTMENT_DEBIT",
          amount: bill.amount,
          openAmount: bill.amount,
          effectiveDate: daysAgo(bill.days + 30),
          dueDate: daysAgo(bill.days),
          reasonId: reason,
        },
      });
    }
  });
  return recomputeCache();
}

async function recomputeCache() {
  return runAsTenant(TENANT_A, async () => {
    const { recomputeAccountCache } = await import("../../services/ar/posting.service.js");
    return recomputeAccountCache(prismaImports.prisma, TENANT_A, fix.accountId);
  });
}

/** One unpaid bill, the common case. */
async function pastDue(opts: { balance: string; days: number }) {
  return pastDueBills([{ amount: opts.balance, days: opts.days }]);
}

/** What is still owed on fees, across every fee on the account. */
async function openFeeTotal(): Promise<string> {
  return seedAsPlatform(async () => {
    const agg = await prismaImports.prisma.ledgerEntry.aggregate({
      where: { utilityId: TENANT_A, type: "FEE" },
      _sum: { openAmount: true },
    });
    return (agg._sum.openAmount ?? 0).toString();
  });
}

/** The debits a tier may charge on: overdue, open, and not a penalty. */
async function chargeableDebits() {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.findMany({
      where: { utilityId: TENANT_A, type: "ADJUSTMENT_DEBIT" },
      select: { id: true },
      orderBy: { dueDate: "asc" },
    }),
  );
}

async function feeEntries() {
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.findMany({
      where: { utilityId: TENANT_A, type: "FEE" },
      orderBy: { postedAt: "asc" },
    }),
  );
}

async function actions() {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.findMany({
      where: { utilityId: TENANT_A },
      orderBy: { tier: "asc" },
    }),
  );
}

/**
 * Whether the account is still past due at all.
 *
 * Asserted alongside any case that evaluates twice, because
 * `recomputeAccountCache` moves `lastDueDate` to the oldest open
 * debit's due date — and a fee's own due date is 30 days out. A second
 * pass against an account that is no longer past due proves nothing,
 * which is how three cases in this branch came to pass vacuously.
 */
async function stillPastDue(): Promise<boolean> {
  const account = await seedAsPlatform(async () =>
    prismaImports.prisma.account.findUniqueOrThrow({
      where: { id: fix.accountId },
      select: { lastDueDate: true, balance: true },
    }),
  );
  if (!account.lastDueDate || account.balance.lte(0)) return false;
  return account.lastDueDate.getTime() < Date.now();
}

/** Pay the ladder's fee off, which is what clearing an episode means. */
async function settleLadderFee() {
  const [feeId] = await ladderFeeIds();
  return seedAsPlatform(async () => {
    await prismaImports.prisma.ledgerEntry.update({
      where: { id: feeId! },
      data: { openAmount: "0.00" },
    });
  });
}

/** Reverse it instead — an operator deciding it is not owed. */
async function waiveLadderFee() {
  const [feeId] = await ladderFeeIds();
  return runAsTenant(TENANT_A, async () => {
    const { reverseEntry } = await import("../../services/ar/reversal.service.js");
    return reverseEntry(TENANT_A, ACTOR, "Tester", feeId!, {
      memo: "Waived at the counter",
    });
  });
}

/** What Cancel on the actions screen, or `resolveAccount`, leaves behind. */
async function setActionStatus(status: "CANCELLED" | "RESOLVED") {
  return seedAsPlatform(async () =>
    prismaImports.prisma.delinquencyAction.updateMany({
      where: { utilityId: TENANT_A },
      data: { status, resolvedAt: new Date(), resolutionType: "WAIVED" },
    }),
  );
}

/** A rule body the create route accepts, with the fee fields overridable. */
function ruleBody(over: Record<string, unknown> = {}) {
  return {
    name: "Tier 1 — first notice",
    tier: 1,
    daysPastDue: 15,
    minBalance: 1,
    actionType: "NOTICE_EMAIL",
    ...over,
  };
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
  svc = await import("../../services/delinquency.service.js");
}, 240_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  await truncateTables(
    "delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, service_request, service_request_counter, service_request_type_def, user_role, cis_user, role, utility_module",
  );
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  await seedAsPlatform(async () => {
    const { seedDefaultReasons } = await import("../../services/ar/reason.service.js");
    await seedDefaultReasons(TENANT_A, ACTOR, "Tester");
    await prismaImports.prisma.utilityModule.create({
      data: { utilityId: TENANT_A, moduleKey: "delinquency" },
    });
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  });
});

describe("a delinquency tier that charges a flat fee", () => {
  it("raises the fee the tier configures, citing the tier's reason", async () => {
    const late = await reasonId("LATE_FEE");
    await ruleWithFee({ feeAmount: "25.00", feeReasonId: late });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    const fees = await feeEntries();
    expect(fees).toHaveLength(1);
    expect(fees[0]!.amount.toString()).toBe("25");
    expect(fees[0]!.openAmount.toString()).toBe("25");
    expect(fees[0]!.reasonId).toBe(late);
  });

  /*
   * The reason is configuration, not a constant. A utility may book a
   * first-notice charge and a final-notice charge to different reasons,
   * and neither is a code this codebase knows.
   */
  it("lets two tiers cite different reasons", async () => {
    const first = await reasonId("LATE_FEE");
    const second = await makeFeeReason("FINAL_NOTICE", "Final notice charge");
    await ruleWithFee({ tier: 1, daysPastDue: 15, feeAmount: "10.00", feeReasonId: first });
    await ruleWithFee({ tier: 2, daysPastDue: 30, feeAmount: "20.00", feeReasonId: second });
    await pastDue({ balance: "100.00", days: 35 });

    await evaluateAll(TENANT_A);

    const cited = (await feeEntries()).map((f) => f.reasonId).sort();
    expect(cited).toEqual([first, second].sort());
  });

  /*
   * Task 5 walks this link to find the fees the ladder itself raised,
   * which is what keeps a bounced-payment fee out of its reach. Nothing
   * else depends on it.
   */
  it("links the fee to the action that raised it", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    const [fee] = await feeEntries();
    expect(await ladderFeeIds()).toEqual([fee!.id]);
  });

  /*
   * The open charge matters. Without a real past-due debit in the
   * ledger, `recomputeAccountCache` sets `lastDueDate` from the only
   * open entry there is — the fee it just raised, due in 30 days — and
   * the second pass then stops at `daysPastDue <= 0` without evaluating
   * anything. This case passed for weeks on that accident, proving
   * nothing about the guard it is named after.
   */
  it("raises it once however many times the tier is evaluated", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);

    expect(await stillPastDue()).toBe(true);
    expect(await feeEntries()).toHaveLength(1);
    expect(await actions()).toHaveLength(1);
  });

  /*
   * The index that stops a duplicate is partial on PENDING and
   * COMPLETED, because a resolved action is history and must not lock an
   * account out of its own ladder next time. That is right for a notice
   * and wrong for money: a CSR pressing Cancel leaves the account past
   * due with no live action, and the next hourly tick charges it again.
   */
  it("does not charge the tier again after its action is cancelled", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });
    await evaluateAll(TENANT_A);

    await setActionStatus("CANCELLED");
    await evaluateAll(TENANT_A);

    expect(await stillPastDue()).toBe(true);
    expect(await feeEntries()).toHaveLength(1);
  });

  /*
   * `resolveAccount` cancels every PENDING action and resolves the
   * highest, which is what granting a payment plan does. An account 50
   * days past due against three charging tiers would otherwise be
   * re-charged all three on the next tick, and again on every later
   * resolve.
   */
  it("does not charge the tier again after the account is resolved", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });
    await evaluateAll(TENANT_A);

    await setActionStatus("RESOLVED");
    await evaluateAll(TENANT_A);

    expect(await feeEntries()).toHaveLength(1);
  });

  /*
   * And the other way: the gate is the current delinquency episode, not
   * "ever". A customer who clears their balance and falls behind again
   * on a later bill is charged again, or a utility collects one late fee
   * per account per lifetime.
   */
  it("does not charge the same bill again once its fee has been paid", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 60 });
    await evaluateAll(TENANT_A);
    await setActionStatus("RESOLVED");
    await settleLadderFee();

    await evaluateAll(TENANT_A);

    // The bill is still unpaid and still past the tier, but this tier
    // is done with it. Charging it again every month is what the higher
    // tiers are for.
    expect(await feeEntries()).toHaveLength(1);
  });

  /*
   * A waived fee is somebody deciding the customer does not owe it. An
   * hourly sweep that charged it straight back would overrule them.
   */
  it("does not charge the same bill again after its fee was waived", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 60 });
    await evaluateAll(TENANT_A);
    await waiveLadderFee();
    await setActionStatus("CANCELLED");

    await evaluateAll(TENANT_A);

    expect(await feeEntries()).toHaveLength(1);
  });

  it("raises the balance by the fee it charged", async () => {
    // The fee is a new debit, so the cache has to agree with the ledger
    // or the next tier reads a stale number: $100 of bill plus $25 of
    // fee is $125 owed.
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    const account = await seedAsPlatform(async () =>
      prismaImports.prisma.account.findUniqueOrThrow({
        where: { id: fix.accountId },
        select: { balance: true },
      }),
    );
    expect(account.balance.toString()).toBe("125");
  });
});

/**
 * A tier that charges a percentage — of the bill it is punishing.
 *
 * The rate applies to one overdue bill's own open amount. It used to sum
 * an account-wide base, which charged 1.5% of money the customer had not
 * yet been asked to pay; per-bill makes the base the bill, and
 * `isPenalty` moves from deciding what the base excludes to deciding
 * which bills may be charged on at all.
 */
describe("a delinquency tier that charges a percentage", () => {
  it("charges the rate against the bill", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0150" });
    await pastDue({ balance: "200.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("3");
  });

  it("caps a percentage fee at maxFee, per bill", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000", maxFee: "5.00" });
    await pastDueBills([{ amount: "200.00", days: 20 }, { amount: "300.00", days: 16 }]);

    await evaluateAll(TENANT_A);

    // Each bill is capped on its own: 5 and 5, not one cap of 5 across
    // both.
    expect(await openFeeTotal()).toBe("10");
  });

  it("rounds a percentage fee to cents, half up", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0333" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("3.33");
  });

  /*
   * The tier still happened — the account passed it and the notice is
   * owed — there was simply nothing to charge. An action with no fee is
   * the honest record of that.
   */
  it("raises nothing when the computed fee rounds to zero", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0001" });
    await pastDue({ balance: "1.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect(await actions()).toHaveLength(1);
    expect(await feeEntries()).toHaveLength(0);
  });

  /*
   * A part-paid bill is charged on what is left of it. The money the
   * customer handed over is debt they no longer have, and a percentage
   * of it would charge them for a debt they have paid. Allocation keeps
   * the bill's own `open_amount`, so this falls out of using it.
   */
  it("charges a part-paid bill on what is left", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000" });
    await pastDue({ balance: "200.00", days: 15 });
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerEntry.updateMany({
        where: { utilityId: TENANT_A, type: "ADJUSTMENT_DEBIT" },
        data: { openAmount: "150.00" },
      }),
    );
    await recomputeCache();

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("15");
  });
});

/**
 * One ladder per unpaid bill.
 *
 * The account-level clock was the defect: `daysPastDue` comes from the
 * oldest open debit, so a bill posted last week was charged a late fee
 * because an older one had reached 40 days — and 1.5% was taken against
 * the whole balance including money the customer had not yet been asked
 * to pay. Each bill now passes the tiers on its own clock and pays its
 * own penalty.
 */
describe("a ladder per overdue bill", () => {
  it("charges each bill that has passed the tier, and no others", async () => {
    await ruleWithFee({ feeAmount: "10.00", daysPastDue: 15 });
    await pastDueBills([
      { amount: "100.00", days: 45 },
      { amount: "200.00", days: 20 },
      { amount: "300.00", days: 5 },
    ]);

    await evaluateAll(TENANT_A);

    // Two qualifying bills, two charges. The five-day-old bill is not
    // late yet and pays nothing.
    const fees = await feeEntries();
    expect(fees).toHaveLength(2);
    expect(fees.map((f) => f.amount.toString())).toEqual(["10", "10"]);
    expect(await openFeeTotal()).toBe("20");
  });

  it("names the bill each fee punishes", async () => {
    await ruleWithFee({ feeAmount: "10.00", daysPastDue: 15 });
    await pastDueBills([{ amount: "100.00", days: 45 }, { amount: "200.00", days: 20 }]);

    await evaluateAll(TENANT_A);

    const debits = await chargeableDebits();
    const fees = await feeEntries();
    expect(fees.map((f) => f.assessedOnId).sort()).toEqual(debits.map((d) => d.id).sort());
  });

  it("charges a percentage against the bill, not the account", async () => {
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0150", daysPastDue: 15 });
    await pastDueBills([
      { amount: "100.00", days: 45 },
      // Not yet late, and so not part of anything charged.
      { amount: "900.00", days: 5 },
    ]);

    await evaluateAll(TENANT_A);

    const fees = await feeEntries();
    expect(fees).toHaveLength(1);
    // 1.5% of 100, not of 1000.
    expect(fees[0]!.amount.toString()).toBe("1.5");
  });

  it("charges a bill when it becomes late, though the tier already fired", async () => {
    await ruleWithFee({ feeAmount: "10.00", daysPastDue: 15 });
    await pastDueBills([{ amount: "100.00", days: 45 }]);
    await evaluateAll(TENANT_A);
    expect(await feeEntries()).toHaveLength(1);

    // A second bill crosses the threshold a fortnight later. The tier's
    // action is already live, so a per-account gate would never charge
    // it — the account would get one late fee and the second bill none.
    await pastDueBills([{ amount: "200.00", days: 16 }]);
    await evaluateAll(TENANT_A);

    expect(await feeEntries()).toHaveLength(2);
  });

  it("charges one bill once, however many times it is swept", async () => {
    await ruleWithFee({ feeAmount: "10.00", daysPastDue: 15 });
    await pastDueBills([{ amount: "100.00", days: 45 }]);

    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);

    expect(await feeEntries()).toHaveLength(1);
  });

  /*
   * `isPenalty` still does the work it was added for, now by deciding
   * which debits may be charged on rather than what a base sums. An
   * unpaid tap fee is money owed for work done and a late fee applies to
   * it; an unpaid late fee is not, and charging one on it compounds.
   */
  it("charges an overdue ordinary fee but never an overdue penalty", async () => {
    await entryOf({ type: "FEE", amount: "40.00", reasonCode: "TAP_FEE" });
    await entryOf({ type: "FEE", amount: "10.00", reasonCode: "LATE_FEE" });
    await ruleWithFee({ feeAmount: "5.00", daysPastDue: 15 });
    await recomputeCache();

    await evaluateAll(TENANT_A);

    // One new fee, for the tap fee. The late fee is left alone.
    const raised = await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerEntry.findMany({
        where: { utilityId: TENANT_A, type: "FEE", assessedOnId: { not: null } },
        select: { amount: true },
      }),
    );
    expect(raised).toHaveLength(1);
    expect(raised[0]!.amount.toString()).toBe("5");
  });

  /*
   * Replacement is per bill too: the $25 supersedes the $10 raised on
   * *that* bill, and leaves the other bill's $10 standing.
   */
  it("replaces only the fees raised on the same bill", async () => {
    await ruleWithFee({ tier: 1, daysPastDue: 15, feeAmount: "10.00" });
    await pastDueBills([{ amount: "100.00", days: 35 }, { amount: "200.00", days: 20 }]);
    await evaluateAll(TENANT_A);
    expect(await openFeeTotal()).toBe("20");

    await ruleWithFee({ tier: 2, daysPastDue: 30, feeAmount: "25.00", feeMode: "REPLACE_LOWER_TIERS" });
    await evaluateAll(TENANT_A);

    // The 35-day bill: $10 reversed, $25 raised. The 20-day bill keeps
    // its $10 and is charged nothing more.
    expect(await openFeeTotal()).toBe("35");
  });
});

describe("configuring the fee", () => {
  /*
   * Review Focus 3. `resolveReason` refuses a non-FEE reason, but at
   * sweep time — so without this the error lands on a worker at 03:00,
   * after other accounts in the tenant have already been noticed,
   * rather than on the operator who typed it.
   */
  it("refuses to save a tier citing a reason that is not a fee reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({
        feeType: "FLAT_FEE",
        feeAmount: "25.00",
        feeReasonId: await reasonId("OPENING_BALANCE"),
      }),
    });

    expect(res.statusCode, res.body).toBe(422);
    expect(JSON.parse(res.body).error.code).toBe("REASON_TYPE_MISMATCH");
    expect(await seedAsPlatform(async () =>
      prismaImports.prisma.delinquencyRule.count({ where: { utilityId: TENANT_A } }),
    )).toBe(0);
  });

  it("refuses a reason that has been retired", async () => {
    const retired = await makeFeeReason("RETIRED_FEE", "Retired charge");
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.update({
        where: { id: retired },
        data: { isActive: false },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({ feeType: "FLAT_FEE", feeAmount: "25.00", feeReasonId: retired }),
    });

    expect(res.statusCode, res.body).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("REASON_NOT_FOUND");
  });

  it("saves a tier citing a usable fee reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({
        feeType: "FLAT_FEE",
        feeAmount: "25.00",
        feeReasonId: await reasonId("LATE_FEE"),
      }),
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).feeAmount).toBe("25");
  });

  /*
   * An amount with no reason is a charge nobody can explain; a reason
   * with no amount is dead configuration. Refused as a group rather
   * than left to the database's CHECK, so the operator gets a 400.
   */
  it("refuses a fee amount with no reason behind it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({ feeType: "FLAT_FEE", feeAmount: "25.00" }),
    });

    expect(res.statusCode, res.body).toBe(400);
  });

  it("refuses a cap on a flat fee, which means nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({
        feeType: "FLAT_FEE",
        feeAmount: "25.00",
        maxFee: "5.00",
        feeReasonId: await reasonId("LATE_FEE"),
      }),
    });

    expect(res.statusCode, res.body).toBe(400);
  });

  /*
   * Through the route, not by calling the validator. The sweep that
   * uses this code skips an action it cannot route rather than failing
   * the tenant's pass, so an unknown code typed here would otherwise go
   * unnoticed until somebody asked why no crew had been sent.
   */
  it("refuses to save a tier naming a work order type the tenant does not have", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({ serviceRequestTypeCode: "NO_SUCH_TYPE" }),
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("SERVICE_REQUEST_TYPE_UNKNOWN");
  });

  it("refuses the same on an update", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody(),
    });
    const id = JSON.parse(created.body).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/delinquency-rules/${id}`,
      headers: headers(),
      payload: { reconnectRequestTypeCode: "NO_SUCH_TYPE" },
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("SERVICE_REQUEST_TYPE_UNKNOWN");
  });

  it("accepts a type the tenant does have, on create and on update", async () => {
    await seedAsPlatform(async () =>
      prismaImports.prisma.serviceRequestTypeDef.createMany({
        data: [{ code: "SHUT_OFF", label: "Shut off for non-payment" }],
        skipDuplicates: true,
      }),
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody({ serviceRequestTypeCode: "SHUT_OFF" }),
    });
    expect(created.statusCode, created.body).toBe(201);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/delinquency-rules/${JSON.parse(created.body).id}`,
      headers: headers(),
      payload: { reconnectRequestTypeCode: "SHUT_OFF" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
  });

  it("saves a tier that charges nothing, as every tier does today", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/delinquency-rules",
      headers: headers(),
      payload: ruleBody(),
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(JSON.parse(res.body).feeType).toBeNull();
  });
});

describe("the sweep's own backstop", () => {
  /*
   * The reason was usable when the rule was saved and was deactivated
   * afterwards. Better a sweep that fails and can be re-run than an
   * account marked delinquent with no charge, or charged with nobody
   * told — which is why the action and the fee share one transaction.
   */
  /*
   * The action and the fee are no longer one transaction, and cannot be:
   * a bill crosses a tier's threshold long after that tier's action was
   * filed, so charging has to run as its own pass. What survives is that
   * the *money* is atomic — the charging pass commits per account or not
   * at all — and that the failure is loud. The account is marked
   * delinquent and uncharged, and every sweep raises until somebody
   * fixes the reason, which is the outcome worth having over a silent
   * skip.
   */
  it("raises loudly and charges nothing if the reason stopped being usable", async () => {
    const late = await reasonId("LATE_FEE");
    await ruleWithFee({ feeAmount: "25.00", feeReasonId: late });
    await pastDue({ balance: "100.00", days: 15 });
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.update({
        where: { id: late },
        data: { isActive: false },
      }),
    );

    await expect(evaluateAll(TENANT_A)).rejects.toThrow();

    expect(await actions()).toHaveLength(1);
    expect(await feeEntries()).toHaveLength(0);
    expect(await ladderFeeIds()).toEqual([]);
  });
});
