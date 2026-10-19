import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MODULES } from "@utility-cis/shared";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Turning a utility's modules on and off.
 *
 * D6 responsibility 2, and only half of it existed: provisioning writes
 * `is_enabled: true` for every module and nothing ever wrote false, so a
 * utility's module set was decided once and never again.
 *
 * The half that matters most here is the cache. `getTenantModules`
 * holds its answer for 600 seconds, and it is what the authorization
 * middleware checks on every request — so a disable that does not
 * invalidate it is a disable that takes ten minutes to mean anything.
 * These tests assert through `getTenantModules` rather than against the
 * row for exactly that reason.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");
let rbac: typeof import("../../services/rbac.service.js");

const TENANT = "00000000-0000-4000-8000-0000000000e1";

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
  rbac = await import("../../services/rbac.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.userRole.deleteMany({ where: { utilityId: TENANT } });
  await prisma.cisUser.deleteMany({ where: { utilityId: TENANT } });
  await prisma.role.deleteMany({ where: { utilityId: TENANT } });
  await prisma.utilityModule.deleteMany({ where: { utilityId: TENANT } });
  await prisma.utility.deleteMany({ where: { id: TENANT } });
  await svc.provisionTenant({ utilityId: TENANT, name: "City of Modules" });
  await rbac.invalidateTenantModulesCache(TENANT);
});

describe("setUtilityModule", () => {
  it("disables a module", async () => {
    const result = await svc.setUtilityModule(TENANT, "containers", false);

    expect(result).toMatchObject({ moduleKey: "containers", isEnabled: false });
  });

  it("takes effect at once rather than when the cache expires", async () => {
    // The read the authorization middleware actually does. A 600s TTL
    // means a disable without invalidation is inert for ten minutes.
    expect(await rbac.getTenantModules(TENANT)).toContain("containers");

    await svc.setUtilityModule(TENANT, "containers", false);

    expect(await rbac.getTenantModules(TENANT)).not.toContain("containers");
  });

  it("re-enables, and that takes effect at once too", async () => {
    await svc.setUtilityModule(TENANT, "containers", false);
    await svc.setUtilityModule(TENANT, "containers", true);

    expect(await rbac.getTenantModules(TENANT)).toContain("containers");
  });

  it("leaves every other module alone", async () => {
    await svc.setUtilityModule(TENANT, "containers", false);

    const enabled = await rbac.getTenantModules(TENANT);
    expect(enabled).toHaveLength(MODULES.length - 1);
  });

  it("is idempotent", async () => {
    await svc.setUtilityModule(TENANT, "containers", false);

    expect((await svc.setUtilityModule(TENANT, "containers", false)).isEnabled).toBe(false);
  });

  it("creates the row when a module postdates the utility", async () => {
    const { prisma } = prismaImports;
    // A module added to MODULES after this utility was provisioned has
    // no row at all, so enabling it has to insert rather than update.
    await prisma.utilityModule.deleteMany({ where: { utilityId: TENANT, moduleKey: "containers" } });

    await svc.setUtilityModule(TENANT, "containers", true);

    expect(await rbac.getTenantModules(TENANT)).toContain("containers");
  });

  it("refuses a module the code does not have", async () => {
    // Otherwise the console can write a row for a module no route reads,
    // which looks enabled and does nothing.
    await expect(svc.setUtilityModule(TENANT, "not_a_module", true)).rejects.toMatchObject({
      code: "UNKNOWN_MODULE",
    });
  });

  it("refuses a utility that does not exist", async () => {
    await expect(
      svc.setUtilityModule("00000000-0000-4000-8000-0000000000ef", "containers", false),
    ).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });
  });

  it("allows disabling everything, because the operator can undo it", async () => {
    // No guard here, deliberately, unlike the last platform operator: a
    // utility with no modules is unusable but every module is one click
    // from coming back, and the operator doing the clicking is not
    // locked out of anything.
    for (const key of MODULES) await svc.setUtilityModule(TENANT, key, false);

    expect(await rbac.getTenantModules(TENANT)).toEqual([]);
  });

  it("reports the change in the utility's detail", async () => {
    await svc.setUtilityModule(TENANT, "containers", false);

    const detail = await svc.getUtilityDetail(TENANT);
    const containers = detail.modules.find((m) => m.moduleKey === "containers");
    expect(containers).toMatchObject({ isEnabled: false });
    // The count is of modules the utility has rows for, enabled or not;
    // the detail page shows the disabled ones struck through rather than
    // hiding them, so an operator can see what was turned off.
    expect(detail.modules).toHaveLength(MODULES.length);
  });
});
