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
