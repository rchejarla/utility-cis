import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
} from "./_effective-dating-fixtures.js";

/**
 * A tenant is a row.
 *
 * Before this, `utility_id` was an uncontrolled UUID repeated across 61
 * tables: no name, no status, no created-at, and nothing distinguishing
 * a new tenant from a typo. Tenants could not be listed except by
 * `SELECT DISTINCT utility_id` over an arbitrary table. The platform
 * actor in the tenancy design note presupposes tenants as objects, so
 * the entity comes before provisioning and before the actor.
 *
 * `resetDb` deliberately does not truncate `utility`: fixtures upsert
 * their own row, so a file that calls `makeTenantFixture` per test does
 * not fight the clear-down.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb(prismaImports.prisma);
});

describe("the Utility entity", () => {
  it("gives a fixture tenant a utility row", async () => {
    const { prisma } = prismaImports;
    const fix = await makeTenantFixture(prisma, TENANT_A);

    const utility = await prisma.utility.findUniqueOrThrow({ where: { id: TENANT_A } });
    expect(utility.status).toBe("ACTIVE");
    expect(utility.name).toContain("00aa");
    expect(fix.utilityId).toBe(TENANT_A);
  });

  it("creates a second utility without colliding with the first", async () => {
    const { prisma } = prismaImports;
    await makeTenantFixture(prisma, TENANT_A);
    await makeTenantFixture(prisma, TENANT_B);

    // Counted by id rather than globally: `utility` survives resetDb, so
    // a global count would depend on what ran before this test.
    const count = await prisma.utility.count({
      where: { id: { in: [TENANT_A, TENANT_B] } },
    });
    expect(count).toBe(2);
  });
});
