import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
} from "./_effective-dating-fixtures.js";
import { PremiseLoader } from "../../lib/rate-engine-loaders/loaders/premise-loader.js";

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
  await resetDb(prisma);
});

describe("PremiseLoader", () => {
  it("premise:attr:eru_count returns a Decimal", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await prismaImports.prisma.premise.update({
      where: { id: fix.premiseId },
      data: { eruCount: "1.50" },
    });

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await loader.load(["premise:attr:eru_count"]);
    const v = out.get("premise:attr:eru_count") as Decimal;
    expect(v).toBeInstanceOf(Decimal);
    expect(v.toString()).toBe(new Decimal("1.5").toString());
  });

  it("premise:attr:has_stormwater_infra returns a boolean", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await prismaImports.prisma.premise.update({
      where: { id: fix.premiseId },
      data: { hasStormwaterInfra: true },
    });

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await loader.load(["premise:attr:has_stormwater_infra"]);
    expect(out.get("premise:attr:has_stormwater_infra")).toBe(true);
  });

  it("premise:attr:premise_type returns the string value", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await loader.load([
      "premise:attr:premise_type",
      "premise:attr:city",
      "premise:attr:state",
      "premise:attr:zip",
    ]);
    expect(out.get("premise:attr:premise_type")).toBe("RESIDENTIAL");
    // Fixture seeds city="Testville", state="TS", zip="00000".
    expect(out.get("premise:attr:city")).toBe("Testville");
    expect(out.get("premise:attr:state")).toBe("TS");
    expect(out.get("premise:attr:zip")).toBe("00000");
  });

  it("premise:attr:<unknown> returns null without throwing", async () => {
    const fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, fix.premiseId);
    const out = await loader.load([
      "premise:attr:zip", // valid — forces a query
      "premise:attr:not_a_real_attr",
    ]);
    expect(out.get("premise:attr:zip")).toBe("00000");
    expect(out.get("premise:attr:not_a_real_attr")).toBeNull();
  });

  it("throws when the premise does not exist", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    const missingId = "00000000-0000-4000-8000-deadbeef0001";

    const loader = new PremiseLoader(prismaImports.prisma, TENANT_A, missingId);
    await expect(loader.load(["premise:attr:eru_count"])).rejects.toThrow();
  });
});
