import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { PremiseLoader } from "../../lib/rate-engine-loaders/loaders/premise-loader.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 4 task 4 — PremiseLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's single pattern (`premise:attr:<attr_name>`) against real
 * Premise rows. Covers Decimal coercion, boolean / string passthrough,
 * unknown-attr null fallback, and the missing-premise throw.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
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

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb();
});

describe("PremiseLoader", () => {
  it("premise:attr:eru_count returns a Decimal", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
      await prismaImports.prisma.premise.update({
        where: { id: fix.premiseId },
        data: { eruCount: "1.50" },
      });

      const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
      const out = await scoped(TENANT_A, () => loader.load(["premise:attr:eru_count"]));
      const v = out.get("premise:attr:eru_count") as Decimal;
      expect(v).toBeInstanceOf(Decimal);
      expect(v.toString()).toBe(new Decimal("1.5").toString());
  
    }));

  it("premise:attr:has_stormwater_infra returns a boolean", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
      await prismaImports.prisma.premise.update({
        where: { id: fix.premiseId },
        data: { hasStormwaterInfra: true },
      });

      const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
      const out = await scoped(TENANT_A, () => loader.load(["premise:attr:has_stormwater_infra"]));
      expect(out.get("premise:attr:has_stormwater_infra")).toBe(true);
  
    }));

  it("premise:attr:premise_type returns the string value", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await scoped(TENANT_A, () => loader.load([
      "premise:attr:premise_type",
      "premise:attr:city",
      "premise:attr:state",
      "premise:attr:zip",
    ]));
    expect(out.get("premise:attr:premise_type")).toBe("RESIDENTIAL");
    // Fixture seeds city="Testville", state="TS", zip="00000".
    expect(out.get("premise:attr:city")).toBe("Testville");
    expect(out.get("premise:attr:state")).toBe("TS");
    expect(out.get("premise:attr:zip")).toBe("00000");
  });

  it("premise:attr:<unknown> returns null without throwing", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await scoped(TENANT_A, () => loader.load([
      "premise:attr:zip", // valid — forces a query
      "premise:attr:not_a_real_attr",
    ]));
    expect(out.get("premise:attr:zip")).toBe("00000");
    expect(out.get("premise:attr:not_a_real_attr")).toBeNull();
  });

  it("throws when the premise does not exist", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    const missingId = "00000000-0000-4000-8000-deadbeef0001";

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, missingId);
    await expect(scoped(TENANT_A, () => loader.load(["premise:attr:eru_count"]))).rejects.toThrow();
  });
});
