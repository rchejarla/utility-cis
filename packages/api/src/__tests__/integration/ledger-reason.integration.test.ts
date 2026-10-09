import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DEFAULT_REASON_CODES } from "@utility-cis/shared";
import { bootPostgres } from "./_effective-dating-fixtures.js";

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

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  reason = await import("../../services/ar/reason.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.ledgerReasonDef.deleteMany({});
});

async function makeReason(
  code: string,
  appliesToType: string,
  isActive = true,
  forUtility = utilityId,
): Promise<string> {
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
}

describe("resolveReason", () => {
  it("resolves an active reason of the expected type", async () => {
    const { prisma } = prismaImports;
    const id = await makeReason("LATE_FEE", "FEE");
    const row = await prisma.$transaction((tx) =>
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
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, badDebt, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH", statusCode: 422 });
  });

  it("names both types in the mismatch message, so the operator can tell what to pick", async () => {
    const { prisma } = prismaImports;
    const badDebt = await makeReason("BAD_DEBT", "WRITE_OFF");
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, badDebt, "FEE")),
    ).rejects.toThrow(/BAD_DEBT.*WRITE_OFF.*FEE/);
  });

  // Review Focus: another tenant's reason.
  it("refuses a reason belonging to another tenant", async () => {
    const { prisma } = prismaImports;
    const stray = await makeReason("STRAY", "FEE", true, otherUtilityId);
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, stray, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND", statusCode: 404 });
  });

  // Review Focus: a retired code.
  it("refuses an inactive reason for a new entry", async () => {
    const { prisma } = prismaImports;
    const retired = await makeReason("RETIRED", "FEE", false);
    await expect(
      prisma.$transaction((tx) => reason.resolveReason(tx, utilityId, retired, "FEE")),
    ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
  });

  it("refuses an unknown id", async () => {
    const { prisma } = prismaImports;
    await expect(
      prisma.$transaction((tx) =>
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

    const rows = await reason.listReasons(utilityId);
    expect(rows.map((r) => r.code)).toEqual(["LATE_FEE", "TAP_FEE", "BAD_DEBT"]);
  });

  it("filters by appliesToType when asked", async () => {
    await makeReason("LATE_FEE", "FEE");
    await makeReason("BAD_DEBT", "WRITE_OFF");
    const rows = await reason.listReasons(utilityId, { appliesToType: "WRITE_OFF" });
    expect(rows.map((r) => r.code)).toEqual(["BAD_DEBT"]);
  });

  // A retired code still has entries citing it, so it has to stay readable.
  it("includes inactive ones when asked", async () => {
    await makeReason("LATE_FEE", "FEE");
    await makeReason("RETIRED", "FEE", false);
    const rows = await reason.listReasons(utilityId, { includeInactive: true });
    expect(rows.map((r) => r.code)).toEqual(["LATE_FEE", "RETIRED"]);
    expect(rows.find((r) => r.code === "RETIRED")!.isActive).toBe(false);
  });

  it("never returns another tenant's reasons", async () => {
    await makeReason("MINE", "FEE");
    await makeReason("THEIRS", "FEE", true, otherUtilityId);
    const rows = await reason.listReasons(utilityId);
    expect(rows.map((r) => r.code)).toEqual(["MINE"]);
  });
});

describe("seedDefaultReasons", () => {
  it("creates the full default set for a fresh tenant", async () => {
    const res = await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(res.created).toBe(DEFAULT_REASON_CODES.length);

    const rows = await reason.listReasons(freshUtilityId);
    expect(rows).toHaveLength(DEFAULT_REASON_CODES.length);
    // Every type that requires a reason has at least one to choose from.
    const types = new Set(rows.map((r) => r.appliesToType));
    expect([...types].sort()).toEqual(
      ["ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT", "FEE", "WRITE_OFF"].sort(),
    );
  });

  it("is idempotent — a second call creates nothing and does not throw", async () => {
    await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    const again = await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(again.created).toBe(0);
    expect(await reason.listReasons(freshUtilityId)).toHaveLength(DEFAULT_REASON_CODES.length);
  });

  it("fills in only what is missing, so a grown default list can be applied", async () => {
    await makeReason("LATE_FEE", "FEE", true, freshUtilityId);
    const res = await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect(res.created).toBe(DEFAULT_REASON_CODES.length - 1);
  });

  it("writes an audit row per reason created", async () => {
    const { prisma } = prismaImports;
    await prisma.auditLog.deleteMany({});
    await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerReasonDef", utilityId: freshUtilityId },
    });
    expect(audits).toHaveLength(DEFAULT_REASON_CODES.length);
    expect(audits[0]!.action).toBe("CREATE");
  });

  it("does not disturb another tenant's reasons", async () => {
    await makeReason("MINE", "FEE");
    await reason.seedDefaultReasons(freshUtilityId, ACTOR, "Tester");
    expect((await reason.listReasons(utilityId)).map((r) => r.code)).toEqual(["MINE"]);
  });
});
