import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
} from "./_effective-dating-fixtures.js";
import { IndexLoader } from "../../lib/rate-engine-loaders/loaders/index-loader.js";

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
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe("DELETE FROM rate_index");
  await resetDb(prisma);
});

async function seedIndex(
  utilityId: string,
  name: string,
  period: string,
  value: string,
): Promise<void> {
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
}

describe("IndexLoader", () => {
  it("index:<name>:<period> returns a Decimal for an existing row", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedIndex(TENANT_A, "fac", "2026-Q2", "0.00125");

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["index:fac:2026-Q2"]);
    const v = out.get("index:fac:2026-Q2") as Decimal;
    expect(v).toBeInstanceOf(Decimal);
    expect(v.toString()).toBe(new Decimal("0.00125").toString());
  });

  it("missing index row → key absent from result map", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["index:fac:2099-Q4"]);
    expect(out.has("index:fac:2099-Q4")).toBe(false);
  });

  it("isolates by tenant — TENANT_B rows are not visible to TENANT_A", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await makeTenantFixture(prismaImports.prisma, TENANT_B, { suffix: "BBBB" });
    // Seed the same (name, period) into TENANT_B only.
    await seedIndex(TENANT_B, "fac", "2026-Q2", "9.9999");

    const loader = new IndexLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["index:fac:2026-Q2"]);
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
      const out = await loader.load([
        "index:fac:2026-Q2",
        "index:epcc:2026-Q2",
        "index:supply_residential:2026-03",
        "index:fac:2099-Q4", // missing
      ]);

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
