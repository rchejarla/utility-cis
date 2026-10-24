import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Suspending a tenant, and reactivating it.
 *
 * D6 responsibility 5, and the enum that has meant nothing since it
 * landed: `UtilityStatus.SUSPENDED` existed, was settable by nobody, and
 * was read by nothing — the last branch review flagged it as honoured
 * nowhere.
 *
 * Suspension is a lifecycle operation, so it belongs to the platform
 * actor: a tenant cannot be trusted to suspend itself, and no tenant
 * permission should be able to. The enforcement half — a suspended
 * tenant's users being refused — is in the authorization middleware, and
 * is covered in `platform-authorization.test.ts`, because what matters
 * there is the order of the checks rather than the database.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/provisioning.service.js");

const TENANT = "00000000-0000-4000-8000-0000000000b1";
const ABSENT = "00000000-0000-4000-8000-0000000000bf";

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
const reactivateUtility = (...args: Parameters<typeof svc.reactivateUtility>) =>
  runAsTenant(args[0], async () => svc.reactivateUtility(...args));

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
  await prisma.userRole.deleteMany({ where: { utilityId: TENANT } });
  await prisma.cisUser.deleteMany({ where: { utilityId: TENANT } });
  await prisma.role.deleteMany({ where: { utilityId: TENANT } });
  await prisma.utilityModule.deleteMany({ where: { utilityId: TENANT } });
  await prisma.utility.deleteMany({ where: { id: TENANT } });
  await svc.provisionTenant({ utilityId: TENANT, name: "City of Suspendable" });
}),
);

describe("suspendUtility and reactivateUtility", () => {
  it("suspends, and reports the status back", async () => {
    const result = await suspendUtility(TENANT);

    expect(result).toMatchObject({ id: TENANT, status: "SUSPENDED" });
  });

  it("reactivates", async () => {
    await suspendUtility(TENANT);

    expect(await reactivateUtility(TENANT)).toMatchObject({ status: "ACTIVE" });
  });

  it("is idempotent in both directions", async () => {
    // An operator clicking twice, or a script re-running, must not be an
    // error — the same reasoning as provisioning's no-op.
    await suspendUtility(TENANT);
    expect((await suspendUtility(TENANT)).status).toBe("SUSPENDED");
    await reactivateUtility(TENANT);
    expect((await reactivateUtility(TENANT)).status).toBe("ACTIVE");
  });

  it("refuses a utility that does not exist", async () => {
    // Not a silent no-op: an operator who mistypes an id has suspended
    // nothing and needs to be told, rather than reading success.
    await expect(suspendUtility(ABSENT)).rejects.toMatchObject({
      code: "UTILITY_NOT_FOUND",
    });
  });

  it("leaves the tenant's own rows alone", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      // Suspension is reversible and purge is a different, deferred
      // capability (D6). Nothing is deleted.
      await suspendUtility(TENANT);

      expect(await prisma.role.count({ where: { utilityId: TENANT } })).toBe(6);
      expect(await prisma.utilityModule.count({ where: { utilityId: TENANT } })).toBeGreaterThan(0);
  
    }));

  it("shows the status in the tenant list", async () => {
    await suspendUtility(TENANT);

    const listed = (await svc.listUtilities()).find((u) => u.id === TENANT);
    expect(listed).toMatchObject({ status: "SUSPENDED" });
  });

  it("refuses to provision over a suspended tenant under a different name", async () => {
    // Re-provisioning is how the seed re-runs, and a suspended tenant is
    // still a tenant — the rename refusal must not weaken because the
    // status changed.
    await suspendUtility(TENANT);

    await expect(
      svc.provisionTenant({ utilityId: TENANT, name: "Something Else" }),
    ).rejects.toMatchObject({ code: "UTILITY_NAME_MISMATCH" });
  });
});
