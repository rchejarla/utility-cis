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

/** The fee the ladder raised, found the way Task 5 will find it. */
async function ladderFee() {
  const [action] = await actions();
  expect(action!.feeEntryId).not.toBeNull();
  return seedAsPlatform(async () =>
    prismaImports.prisma.ledgerEntry.findUniqueOrThrow({
      where: { id: action!.feeEntryId! },
    }),
  );
}

async function ruleWithFee(opts: {
  tier?: number;
  daysPastDue?: number;
  feeType?: "FLAT_FEE" | "PERCENT_OF_BALANCE";
  feeAmount: string | null;
  maxFee?: string;
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
        feeReasonId: charging
          ? (opts.feeReasonId ?? (await reasonId("LATE_FEE")))
          : null,
      },
    }),
  );
}

/** The fixture account, made past due by `days` with `balance` owing. */
async function pastDue(opts: { balance: string; days: number }) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.account.update({
      where: { id: fix.accountId },
      data: { balance: opts.balance, lastDueDate: daysAgo(opts.days) },
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
    "delinquency_action, delinquency_rule, ledger_application, ledger_entry, ledger_reason_def, user_role, cis_user, role, utility_module",
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

    const [action] = await actions();
    const [fee] = await feeEntries();
    expect(action!.feeEntryId).toBe(fee!.id);
  });

  it("raises it once however many times the tier is evaluated", async () => {
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);
    await evaluateAll(TENANT_A);

    expect(await feeEntries()).toHaveLength(1);
    expect(await actions()).toHaveLength(1);
  });

  it("raises no fee for a tier that configures none", async () => {
    await ruleWithFee({ feeAmount: null });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect(await actions()).toHaveLength(1);
    expect(await feeEntries()).toHaveLength(0);
  });

  it("raises the fee against the balance the account actually owes", async () => {
    // The fee is a new debit, so it raises the balance by its own amount
    // — the cache has to agree with the ledger or the next tier reads a
    // stale number.
    await ruleWithFee({ feeAmount: "25.00" });
    await pastDue({ balance: "100.00", days: 15 });

    await evaluateAll(TENANT_A);

    const account = await seedAsPlatform(async () =>
      prismaImports.prisma.account.findUniqueOrThrow({
        where: { id: fix.accountId },
        select: { balance: true },
      }),
    );
    expect(account.balance.toString()).toBe("25");
  });
});

/**
 * Task 4: a tier that charges a percentage.
 *
 * The base is what the account owes in *principal*. Including earlier
 * penalties charges 1.5% of tier 1's own fee; excluding every `FEE`
 * would stop a late fee applying to an unpaid tap fee, which is money
 * owed for work actually done. `LedgerReasonDef.isPenalty` is the only
 * thing that separates them, and it cannot be a list of codes.
 */
describe("a delinquency tier that charges a percentage", () => {
  it("charges the rate against what the account owes", async () => {
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "200.00", reasonCode: "OPENING_BALANCE" });
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0150" });
    await pastDue({ balance: "200.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("3");
  });

  it("caps a percentage fee at maxFee", async () => {
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "200.00", reasonCode: "OPENING_BALANCE" });
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000", maxFee: "5.00" });
    await pastDue({ balance: "200.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("5");
  });

  /*
   * Review Focus 4, and the whole reason `isPenalty` exists. $100 of
   * opening balance plus a $40 unpaid tap fee is $140 of principal; a
   * $10 late fee already raised is not. 10% of 140 is 14, not 15.
   */
  it("excludes a prior penalty from the base but not an ordinary fee", async () => {
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "100.00", reasonCode: "OPENING_BALANCE" });
    await entryOf({ type: "FEE", amount: "40.00", reasonCode: "TAP_FEE" });
    await entryOf({ type: "FEE", amount: "10.00", reasonCode: "LATE_FEE" });
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000" });
    await pastDue({ balance: "150.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("14");
  });

  it("rounds a percentage fee to cents, half up", async () => {
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "100.00", reasonCode: "OPENING_BALANCE" });
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
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "1.00", reasonCode: "OPENING_BALANCE" });
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.0001" });
    await pastDue({ balance: "1.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect(await actions()).toHaveLength(1);
    expect(await feeEntries()).toHaveLength(0);
  });

  /*
   * An open credit the ladder has not yet applied is money the customer
   * has already handed over. Charging a percentage on it would charge
   * them for debt they have paid.
   */
  it("counts an open credit against the base", async () => {
    await entryOf({ type: "ADJUSTMENT_DEBIT", amount: "200.00", reasonCode: "OPENING_BALANCE" });
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerEntry.create({
        data: {
          utilityId: TENANT_A,
          accountId: fix.accountId,
          type: "PAYMENT",
          amount: "-50.00",
          openAmount: "-50.00",
          effectiveDate: daysAgo(20),
          tender: "CASH",
        },
      }),
    );
    await ruleWithFee({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.1000" });
    await pastDue({ balance: "150.00", days: 15 });

    await evaluateAll(TENANT_A);

    expect((await ladderFee()).amount.toString()).toBe("15");
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
  it("writes neither the action nor the fee if the reason stopped being usable", async () => {
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

    expect(await actions()).toHaveLength(0);
    expect(await feeEntries()).toHaveLength(0);
  });
});
