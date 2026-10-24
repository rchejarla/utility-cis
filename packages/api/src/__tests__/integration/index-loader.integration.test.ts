import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { IndexLoader } from "../../lib/rate-engine-loaders/loaders/index-loader.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 4 task 4 — IndexLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's single declared pattern (`index:<name>:<period>`) against
 * real `rate_index` rows.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

/**
 * The loader run the way a route runs it: inside the tenant's scope.
 *
 * A loader takes the client and the tenant in its constructor, so the
 * scope cannot ride in on an argument to `load()` — it has to be around
 * the call. `runAsTenant` here overrides the surrounding
 * `seedAsPlatform`, so the fixtures stay free to arrange rows while the
 * read under test is confined to one tenant.
 */
const scoped = <T>(tenant: string, fn: () => Promise<T>): Promise<T> =>
  runAsTenant(tenant, fn);

beforeEach(() =>
  seedAsPlatform(async () => {    /* Fixture rows and read-backs under the fixture authority; the
     * scoped wrappers re-enter their own tenant scope. */
    const { prisma } = prismaImports;
    await prisma.$executeRawUnsafe("DELETE FROM rate_index");
    await resetDb();

  }));

async function seedIndex(
  utilityId: string,
  name: string,
  period: string,
  value: string,
): Promise<void> {

  /*

   * Arranging rows, so the authority the fixtures use. Calls under

   * test re-enter their own tenant scope.

   */

  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.rateIndex.create({
      data: {
        utilityId,
        name,
        period,
        value,
        effectiveDate: new Date("2026-01-01"),
      },
    });


  });

}

describe("IndexLoader", () => {
  it("index:<name>:<period> returns a Decimal for an existing row", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedIndex(TENANT_A, "fac", "2026-Q2", "0.00125");

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await scoped(TENANT_A, () => loader.load(["index:fac:2026-Q2"]));
    const v = out.get("index:fac:2026-Q2") as Decimal;
    expect(v).toBeInstanceOf(Decimal);
    expect(v.toString()).toBe(new Decimal("0.00125").toString());
  });

  it("missing index row → key absent from result map", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await scoped(TENANT_A, () => loader.load(["index:fac:2099-Q4"]));
    expect(out.has("index:fac:2099-Q4")).toBe(false);
  });

  it("isolates by tenant — TENANT_B rows are not visible to TENANT_A", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await makeTenantFixture(prismaImports.prisma, TENANT_B, { suffix: "BBBB" });
    // Seed the same (name, period) into TENANT_B only.
    await seedIndex(TENANT_B, "fac", "2026-Q2", "9.9999");

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await scoped(TENANT_A, () => loader.load(["index:fac:2026-Q2"]));
    expect(out.has("index:fac:2026-Q2")).toBe(false);
  });

  it("batches multiple (name, period) combos into one OR query", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedIndex(TENANT_A, "fac", "2026-Q2", "0.00125");
    await seedIndex(TENANT_A, "epcc", "2026-Q2", "1.5000");
    await seedIndex(TENANT_A, "supply_residential", "2026-03", "2.7500");

    const original = prismaImports.prisma.rateIndex.findMany.bind(
      prismaImports.prisma.rateIndex,
    );
    const spy = vi
      .spyOn(prismaImports.prisma.rateIndex, "findMany")
      .mockImplementation((args) => original(args) as ReturnType<typeof original>);
    try {
      const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
      const out = await scoped(TENANT_A, () => loader.load([
        "index:fac:2026-Q2",
        "index:epcc:2026-Q2",
        "index:supply_residential:2026-03",
        "index:fac:2099-Q4", // missing
      ]));

      expect(spy).toHaveBeenCalledTimes(1);
      expect((out.get("index:fac:2026-Q2") as Decimal).toString()).toBe("0.00125");
      expect((out.get("index:epcc:2026-Q2") as Decimal).toString()).toBe("1.5");
      expect((out.get("index:supply_residential:2026-03") as Decimal).toString()).toBe("2.75");
      expect(out.has("index:fac:2099-Q4")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
