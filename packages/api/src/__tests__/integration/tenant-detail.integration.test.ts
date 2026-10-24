import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { MODULES } from "@utility-cis/shared";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * What a tenant actually holds.
 *
 * The console listed counts with nothing behind them, which is a dead
 * end: "6 roles" raises the question it cannot answer. D6 responsibility
 * 6 is listing tenants, and a list you cannot open is only half of it.
 *
 * The one judgement worth recording is **staff, not users**. Portal
 * customers are `cis_user` rows too, so returning "the tenant's users"
 * would mean a real utility answering with tens of thousands of rows.
 * What a platform operator asks of this screen is whether the tenant can
 * be administered, so it returns the staff — users with no `customer_id`
 * — and counts the portal accounts separately.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");

const TENANT = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const ABSENT = "00000000-0000-4000-8000-0000000000cf";

/**
 * The services this file calls directly, as a route reaches them: acting
 * for the tenant, not merely naming it.
 *
 * Each already receives the tenant — production passed it from a request
 * or a job whose scope had been entered, so the argument and the scope
 * are always the same id. A direct service test has the argument and not
 * the scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` also overrides a surrounding `seedAsPlatform`, which is
 * what lets fixture rows be arranged across tenants while the call under
 * test stays confined to one.
 */
const getUtilityDetail = (...args: Parameters<typeof svc.getUtilityDetail>) =>
  runAsTenant(args[0], async () => svc.getUtilityDetail(...args));

const suspendUtility = (...args: Parameters<typeof svc.suspendUtility>) =>
  runAsTenant(args[0], async () => svc.suspendUtility(...args));

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/provisioning.service.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  for (const id of [TENANT, OTHER]) {
    // `audit_log.utility_id` is ON DELETE RESTRICT too, and provisioning
    // now writes a row, so the same applies to the history it leaves.
    await prisma.auditLog.deleteMany({ where: { utilityId: id } });
    await prisma.userRole.deleteMany({ where: { utilityId: id } });
    await prisma.cisUser.deleteMany({ where: { utilityId: id } });
    // Before the utility: customer.utility_id is ON DELETE RESTRICT, so
    // a leftover customer from the portal-count test blocks the teardown
    // and takes every test after it down with the utility.
    await prisma.customer.deleteMany({ where: { utilityId: id } });
    await prisma.role.deleteMany({ where: { utilityId: id } });
    await prisma.utilityModule.deleteMany({ where: { utilityId: id } });
    await prisma.utility.deleteMany({ where: { id } });
  }
  await svc.provisionTenant({
    utilityId: TENANT,
    name: "City of Detail",
    firstAdmin: { email: "ops@detail.gov", name: "Pat Admin" },
  });
}),
);

describe("getUtilityDetail", () => {
  it("reports the tenant's identity and what it holds", async () => {
    const detail = await getUtilityDetail(TENANT);

    expect(detail).toMatchObject({
      id: TENANT,
      name: "City of Detail",
      status: "ACTIVE",
      moduleCount: MODULES.length,
      roleCount: 6,
    });
  });

  it("lists every enabled module", async () => {
    const detail = await getUtilityDetail(TENANT);

    expect(detail.modules.map((m) => m.moduleKey).sort()).toEqual([...MODULES].sort());
    expect(detail.modules.every((m) => m.isEnabled)).toBe(true);
  });

  it("lists the roles with how many modules each grants", async () => {
    const detail = await getUtilityDetail(TENANT);

    const admin = detail.roles.find((r) => r.name === "System Admin");
    expect(admin).toMatchObject({ isSystem: true, moduleCount: MODULES.length });
    // Read-Only grants fewer, which is the point of showing the number:
    // "6 roles" says nothing about what they can do.
    const readOnly = detail.roles.find((r) => r.name === "Read-Only");
    expect(readOnly!.moduleCount).toBeLessThan(MODULES.length);
  });

  it("lists staff with the role each holds", async () => {
    const detail = await getUtilityDetail(TENANT);

    expect(detail.staff).toHaveLength(1);
    expect(detail.staff[0]).toMatchObject({
      email: "ops@detail.gov",
      name: "Pat Admin",
      isActive: true,
      roleName: "System Admin",
    });
  });

  it("counts portal customers rather than listing them", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // A real tenant has tens of thousands of these. They are cis_user
      // rows, so "the tenant's users" would be an unbounded payload.
      const customer = await prisma.customer.create({
        data: { utilityId: TENANT, customerType: "INDIVIDUAL", firstName: "Jo", lastName: "Public" },
      });
      await prisma.cisUser.create({
        data: {
          utilityId: TENANT,
          email: "jo@example.com",
          name: "Jo Public",
          customerId: customer.id,
        },
      });

      const detail = await getUtilityDetail(TENANT);

      expect(detail.staff).toHaveLength(1);
      expect(detail.staff.map((s) => s.email)).not.toContain("jo@example.com");
      expect(detail.portalUserCount).toBe(1);
  
    }));

  it("shows a staff member with no role rather than hiding them", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // A user with no role cannot do anything, which is exactly what an
      // operator is looking for when a tenant reports it cannot work.
      await prisma.cisUser.create({
        data: { utilityId: TENANT, email: "orphan@detail.gov", name: "No Role" },
      });

      const detail = await getUtilityDetail(TENANT);

      const orphan = detail.staff.find((s) => s.email === "orphan@detail.gov");
      expect(orphan).toMatchObject({ roleName: null });
  
    }));

  it("refuses a tenant that does not exist", async () => {
    await expect(getUtilityDetail(ABSENT)).rejects.toMatchObject({
      code: "UTILITY_NOT_FOUND",
    });
  });

  it("returns nothing belonging to another tenant", async () => {
    const { prisma } = prismaImports;
    await svc.provisionTenant({
      utilityId: OTHER,
      name: "Other Utility",
      firstAdmin: { email: "ops@other.gov", name: "Other Admin" },
    });

    const detail = await getUtilityDetail(TENANT);

    expect(detail.staff.map((s) => s.email)).toEqual(["ops@detail.gov"]);
    expect(detail.roles).toHaveLength(6);
    expect(detail.modules).toHaveLength(MODULES.length);
  });

  it("reports a suspended tenant as suspended", async () => {
    await suspendUtility(TENANT);

    expect((await getUtilityDetail(TENANT)).status).toBe("SUSPENDED");
  });
});
