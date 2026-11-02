import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";
import { runAsPlatform, runAsTenant } from "../../lib/tenant-context.js";

/**
 * Overlay mode, against real rows (spec 28, OVL-T-1 and OVL-T-4).
 *
 * The overlay offer runs a utility's existing CIS alongside this one:
 * we mirror its data each cycle and shadow-rate its pre-bill register,
 * while **it** keeps billing the customers. Nothing structural stopped
 * us billing them too — an overlay tenant is an ordinary tenant to
 * every route and every dispatcher — so the mode is the thing that
 * makes the offer safe to sell.
 *
 * What is covered here is the part only a database can answer: that the
 * column defaults correctly for every tenant that already exists, that
 * the conversion writes the audit row somebody will later look for, and
 * that the cached guards the authorization pass reads actually change.
 * The ordering of the refusal against suspension, module and permission
 * checks is a unit concern and lives in `overlay-refusal.test.ts`.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");
let rbac: typeof import("../../services/rbac.service.js");

const TENANT = "00000000-0000-4000-8000-0000000000c1";

const ACTOR = {
  id: "00000000-0000-4000-8000-0000000000c9",
  name: "Platform Operator",
  source: "PLATFORM" as const,
};

const provisionTenant = (...args: Parameters<typeof svc.provisionTenant>) =>
  runAsPlatform(async () => svc.provisionTenant(...args));

const setMode = (mode: "FULL" | "OVERLAY") =>
  runAsTenant(TENANT, async () => svc.setUtilityOperatingMode(TENANT, mode, ACTOR));

const listUtilities = () => runAsPlatform(async () => svc.listUtilities());

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
  rbac = await import("../../services/rbac.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.userRole.deleteMany({ where: { utilityId: TENANT } });
    await prisma.cisUser.deleteMany({ where: { utilityId: TENANT } });
    await prisma.role.deleteMany({ where: { utilityId: TENANT } });
    await prisma.utilityModule.deleteMany({ where: { utilityId: TENANT } });
    await prisma.auditLog.deleteMany({ where: { utilityId: TENANT } });
    await prisma.utility.deleteMany({ where: { id: TENANT } });
    await provisionTenant({ utilityId: TENANT, name: "City of Overlay" });
    await rbac.invalidateUtilityStatusCache(TENANT);
  }),
);

describe("the operating mode column", () => {
  it("defaults a newly provisioned tenant to FULL", () =>
    seedAsPlatform(async () => {
      // The backfill for every tenant that already existed is this
      // default: nothing has ever been mirrored, so FULL is the truth.
      const { prisma } = prismaImports;
      const row = await prisma.utility.findUniqueOrThrow({
        where: { id: TENANT },
        select: { operatingMode: true },
      });
      expect(row.operatingMode).toBe("FULL");
    }), 60_000);

  it("is carried on the summary the platform console lists", () =>
    seedAsPlatform(async () => {
      await setMode("OVERLAY");
      const listed = (await listUtilities()).find((u) => u.id === TENANT);
      expect(listed?.operatingMode).toBe("OVERLAY");
    }), 60_000);

  it("is a separate axis from status — a tenant is ACTIVE and OVERLAY at once", () =>
    seedAsPlatform(async () => {
      const after = await setMode("OVERLAY");
      expect(after).toMatchObject({ status: "ACTIVE", operatingMode: "OVERLAY" });
    }), 60_000);
});

describe("the conversion", () => {
  it("writes an audit row naming the direction", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      await setMode("OVERLAY");
      await setMode("FULL");

      /*
       * The event type lives in `metadata.eventType`; `action` is the
       * verb `writeAuditRow` derives from it. Both matter — the verb is
       * what the audit UI groups by, the event type is what names the
       * direction.
       */
      const audits = await prisma.auditLog.findMany({
        where: { utilityId: TENANT, entityType: "Utility" },
        orderBy: { createdAt: "asc" },
        select: { action: true, metadata: true, beforeState: true, afterState: true },
      });
      const eventOf = (a: { metadata: unknown }) =>
        (a.metadata as { eventType?: string } | null)?.eventType;
      const modeEvents = audits.filter((a) =>
        ["utility.set_to_overlay", "utility.converted_to_full"].includes(eventOf(a) ?? ""),
      );
      expect(modeEvents.map(eventOf)).toEqual([
        "utility.set_to_overlay",
        "utility.converted_to_full",
      ]);
      // "When did we start billing these customers" is the question
      // this row exists to answer, so both sides are recorded.
      expect(modeEvents[1]).toMatchObject({
        beforeState: { operatingMode: "OVERLAY" },
        afterState: { operatingMode: "FULL" },
      });
    }), 60_000);

  it("changes what the authorization pass reads, at once", () =>
    seedAsPlatform(async () => {
      /*
       * The load-bearing line in the service. `getUtilityGuards` caches
       * for 300s and the authorization pass consults it on every
       * request, so a conversion that skipped the invalidation would
       * leave every refused capability refused for five minutes after
       * the operator was told it had succeeded.
       */
      await setMode("OVERLAY");
      expect(await rbac.getUtilityGuards(TENANT)).toMatchObject({
        operatingMode: "OVERLAY",
      });

      await setMode("FULL");
      expect(await rbac.getUtilityGuards(TENANT)).toMatchObject({
        operatingMode: "FULL",
      });
    }), 60_000);

  it("is a no-op, with no audit row, when the mode already matches", () =>
    seedAsPlatform(async () => {
      // An operator confirming a state should not get a 409, and should
      // not leave a row saying something changed when nothing did.
      const { prisma } = prismaImports;
      const before = await prisma.auditLog.count({
        where: { utilityId: TENANT, entityType: "Utility" },
      });

      const result = await setMode("FULL");
      expect(result.operatingMode).toBe("FULL");

      expect(
        await prisma.auditLog.count({ where: { utilityId: TENANT, entityType: "Utility" } }),
      ).toBe(before);
    }), 60_000);

  it("refuses a tenant that does not exist", () =>
    seedAsPlatform(async () => {
      const absent = "00000000-0000-4000-8000-0000000000cf";
      await expect(
        runAsTenant(absent, async () =>
          svc.setUtilityOperatingMode(absent, "OVERLAY", ACTOR),
        ),
      ).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });
    }), 60_000);
});
