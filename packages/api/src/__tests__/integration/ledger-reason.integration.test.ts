import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { DEFAULT_REASON_CODES } from "@utility-cis/shared";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 3 — the tenant's reason codes (§4.4).
 *
 * `resolveReason` is the single gate every writing service goes through,
 * so these cases are the only place the `appliesToType` rule, the tenant
 * scope and the retired-code rule are proved. If this is wrong, four
 * services are wrong.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtilityId = "00000000-0000-4000-8000-0000000000bb";
const freshUtilityId = "00000000-0000-4000-8000-0000000000cc";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let reason: typeof import("../../services/ar/reason.service.js");

/**
 * The services this file calls directly, as a route reaches them:
 * acting for the tenant, not merely naming it.
 *
 * Each already takes the tenant as its first argument, and in
 * production that value came from a request or a job whose scope was
 * entered before the call — so the argument and the scope are always
 * the same id. A direct service test has the argument and not the
 * scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` here also overrides the surrounding
 * `seedAsPlatform`, which is what lets fixture rows be arranged
 * across tenants while the call under test stays confined to one.
 */
const listReasons = (...args: Parameters<typeof reason.listReasons>) =>
  runAsTenant(args[0], async () => reason.listReasons(...args));

const seedDefaultReasons = (...args: Parameters<typeof reason.seedDefaultReasons>) =>
  runAsTenant(args[0], async () => reason.seedDefaultReasons(...args));

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtilityId, freshUtilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  reason = await import("../../services/ar/reason.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the tenant and platform pools are
  // ended here. Without it the container stops while connections are
  // live and Postgres reports 57P01 after an otherwise green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerReasonDef.deleteMany({});
}),
);

/**
 * A transaction entered the way a route enters one: inside the tenant's
 * scope.
 *
 * `resolveReason` takes the transaction client first and the tenant
 * second, so the scope cannot ride in on an argument — it has to be
 * around the call, which is the order a request does it in.
 */
const asTenantTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  runAsTenant(utilityId, async () => prismaImports.prisma.$transaction(fn));

async function makeReason(
  code: string,
  appliesToType: string,
  isActive = true,
  forUtility = utilityId,
): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const r = await prisma.ledgerReasonDef.create({
      data: {
        utilityId: forUtility,
        code,
        label: `${code} label`,
        appliesToType: appliesToType as never,
        isActive,
      },
    });
    return r.id;

  });
}

describe("resolveReason", () => {
  it("resolves an active reason of the expected type", async () => {
    const { prisma } = prismaImports;
    const id = await makeReason("LATE_FEE", "FEE");
    const row = await asTenantTx((tx) =>
      reason.resolveReason(tx, utilityId, id, "FEE"),
    );
    expect(row.code).toBe("LATE_FEE");
    expect(row.appliesToType).toBe("FEE");
  });

  // Review Focus: a BAD_DEBT reason cited on a fee.
  it("refuses a reason whose appliesToType disagrees", async () => {
    const { prisma } = prismaImports;
    const badDebt = await makeReason("BAD_DEBT", "WRITE_OFF");
    await expect(
      asTenantTx((tx) => reason.resolveReason(tx, utilityId, badDebt, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH", statusCode: 422 });
  });

  it("names both types in the mismatch message, so the operator can tell what to pick", async () => {
    const { prisma } = prismaImports;
    const badDebt = await makeReason("BAD_DEBT", "WRITE_OFF");
    await expect(
      asTenantTx((tx) => reason.resolveReason(tx, utilityId, badDebt, "FEE")),
    ).rejects.toThrow(/BAD_DEBT.*WRITE_OFF.*FEE/);
  });

  // Review Focus: another tenant's reason.
  it("refuses a reason belonging to another tenant", async () => {
    const { prisma } = prismaImports;
    const stray = await makeReason("STRAY", "FEE", true, otherUtilityId);
    await expect(
      asTenantTx((tx) => reason.resolveReason(tx, utilityId, stray, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND", statusCode: 404 });
  });

  // Review Focus: a retired code.
  it("refuses an inactive reason for a new entry", async () => {
    const { prisma } = prismaImports;
    const retired = await makeReason("RETIRED", "FEE", false);
    await expect(
      asTenantTx((tx) => reason.resolveReason(tx, utilityId, retired, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
  });

  it("refuses an unknown id", async () => {
    const { prisma } = prismaImports;
    await expect(
      asTenantTx((tx) =>
        reason.resolveReason(tx, utilityId, "00000000-0000-4000-8000-00000000dead", "FEE"),
      ),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
  });
});

describe("listReasons", () => {
  it("returns active reasons only, grouped by type then code", async () => {
    await makeReason("TAP_FEE", "FEE");
    await makeReason("LATE_FEE", "FEE");
    await makeReason("RETIRED", "FEE", false);
    await makeReason("BAD_DEBT", "WRITE_OFF");

    const rows = await listReasons(utilityId);
    expect(rows.map((r) => r.code)).toEqual(["LATE_FEE", "TAP_FEE", "BAD_DEBT"]);
  });

  it("filters by appliesToType when asked", async () => {
    await makeReason("LATE_FEE", "FEE");
    await makeReason("BAD_DEBT", "WRITE_OFF");
    const rows = await listReasons(utilityId, { appliesToType: "WRITE_OFF" });
    expect(rows.map((r) => r.code)).toEqual(["BAD_DEBT"]);
  });

  // A retired code still has entries citing it, so it has to stay readable.
  it("includes inactive ones when asked", async () => {
    await makeReason("LATE_FEE", "FEE");
    await makeReason("RETIRED", "FEE", false);
    const rows = await listReasons(utilityId, { includeInactive: true });
    expect(rows.map((r) => r.code)).toEqual(["LATE_FEE", "RETIRED"]);
    expect(rows.find((r) => r.code === "RETIRED")!.isActive).toBe(false);
  });

  it("never returns another tenant's reasons", async () => {
    await makeReason("MINE", "FEE");
    await makeReason("THEIRS", "FEE", true, otherUtilityId);
    const rows = await listReasons(utilityId);
    expect(rows.map((r) => r.code)).toEqual(["MINE"]);
  });
});

describe("seedDefaultReasons", () => {
  it("creates the full default set for a fresh tenant", async () => {
    const res = await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(res.created).toBe(DEFAULT_REASON_CODES.length);

    const rows = await listReasons(freshUtilityId);
    expect(rows).toHaveLength(DEFAULT_REASON_CODES.length);
    // Every type that requires a reason has at least one to choose from.
    const types = new Set(rows.map((r) => r.appliesToType));
    expect([...types].sort()).toEqual(
      ["ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT", "FEE", "WRITE_OFF"].sort(),
    );
  });

  it("is idempotent — a second call creates nothing and does not throw", async () => {
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    const again = await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(again.created).toBe(0);
    expect(await listReasons(freshUtilityId)).toHaveLength(DEFAULT_REASON_CODES.length);
  });

  it("fills in only what is missing, so a grown default list can be applied", async () => {
    await makeReason("LATE_FEE", "FEE", true, freshUtilityId);
    const res = await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(res.created).toBe(DEFAULT_REASON_CODES.length - 1);
  });

  it("writes an audit row per reason created", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await prisma.auditLog.deleteMany({});
      await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
      const audits = await prisma.auditLog.findMany({
        where: { entityType: "LedgerReasonDef", utilityId: freshUtilityId },
      });
      expect(audits).toHaveLength(DEFAULT_REASON_CODES.length);
      expect(audits[0]!.action).toBe("CREATE");
  
    }));

  it("does not disturb another tenant's reasons", async () => {
    await makeReason("MINE", "FEE");
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect((await listReasons(utilityId)).map((r) => r.code)).toEqual(["MINE"]);
  });
});

/**
 * Which reasons are penalties.
 *
 * Task 2 of `docs/superpowers/plans/2026-10-25-collections-wiring.md`.
 * A percentage late fee has to be charged on principal, or tier 2
 * charges 1.5% of tier 1's own fee. Nothing already on the entry
 * answers "is this a penalty": all five seeded fee reasons are `FEE`,
 * and the code cannot be asked, because reasons are tenant-configurable
 * and a utility's own "Late charge" would be missed. So the nature of
 * the reason becomes a property of the reason, set by whoever defines
 * it.
 */
describe("a reason knows whether it is a penalty", () => {
  async function flagsFor(codes: string[]): Promise<Record<string, boolean>> {
    return seedAsPlatform(async () => {
      const rows = await prismaImports.prisma.ledgerReasonDef.findMany({
        where: { utilityId: freshUtilityId, code: { in: codes } },
        select: { code: true, isPenalty: true },
      });
      return Object.fromEntries(rows.map((r) => [r.code, r.isPenalty]));
    });
  }

  it("marks the two default reasons that are penalties, and no others", async () => {
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");

    const marked = await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.findMany({
        where: { utilityId: freshUtilityId, isPenalty: true },
        select: { code: true },
        orderBy: { code: "asc" },
      }),
    );
    expect(marked.map((r) => r.code)).toEqual(["LATE_FEE", "NSF_FEE"]);
  });

  /*
   * The distinction that makes the flag worth having. An unpaid tap fee
   * is money owed for work done, so a late fee applies to it; a late
   * fee is not, so a later late fee must not compound on it. Excluding
   * every `FEE` from the base would lose the first case.
   */
  it("leaves a fee charged for work done counting as principal", async () => {
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");

    expect(await flagsFor(["TAP_FEE", "METER_TEST_FEE", "RECONNECT_FEE"])).toEqual({
      TAP_FEE: false,
      METER_TEST_FEE: false,
      RECONNECT_FEE: false,
    });
  });

  /*
   * Default false, so a reason nobody has classified keeps counting as
   * principal. That direction under-charges rather than over-charges,
   * which is the right way for this to be wrong.
   */
  it("treats a reason nobody classified as principal", async () => {
    const id = await makeReason("TAMPER_CHARGE", "FEE", true, freshUtilityId);

    const row = await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.findUniqueOrThrow({
        where: { id },
        select: { isPenalty: true },
      }),
    );
    expect(row.isPenalty).toBe(false);
  });

  /*
   * The case the seeder's `continue` would have hidden, and the only one
   * that matters in practice: every tenant already holds these rows, so
   * a seeder that skips codes it has would never set the flag anywhere
   * it is needed.
   */
  it("sets the flag on a tenant that already has the reason", async () => {
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.updateMany({
        where: { utilityId: freshUtilityId, code: "LATE_FEE" },
        data: { isPenalty: false },
      }),
    );

    const again = await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");

    expect(again.created).toBe(0);
    expect(again.penaltiesMarked).toBe(1);
    expect(await flagsFor(["LATE_FEE"])).toEqual({ LATE_FEE: true });
  });

  it("marks nothing on a second pass that has nothing to mark", async () => {
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    const again = await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(again.penaltiesMarked).toBe(0);
  });

  it("does not reach another tenant's reason of the same code", async () => {
    await makeReason("LATE_FEE", "FEE", true, utilityId);
    await seedDefaultReasons(freshUtilityId, ACTOR, "Tester");

    const mine = await seedAsPlatform(async () =>
      prismaImports.prisma.ledgerReasonDef.findFirstOrThrow({
        where: { utilityId, code: "LATE_FEE" },
        select: { isPenalty: true },
      }),
    );
    expect(mine.isPenalty).toBe(false);
  });
});
