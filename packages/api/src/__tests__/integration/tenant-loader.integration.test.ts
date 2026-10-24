import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, resetDb, makeTenantFixture, TENANT_A } from "./_effective-dating-fixtures.js";
import { TenantLoader } from "../../lib/rate-engine-loaders/loaders/tenant-loader.js";

/**
 * Slice 4 task 4 — TenantLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's two declared patterns against real `utility_setting` rows:
 *   - tenant:drought_stage          (number stored in JSON column)
 *   - tenant:flags:<flag_name>      (boolean stored in JSON column,
 *                                    keyed by `flags.<name>`)
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  // RLS-OPT-OUT: this suite still connects as the migration owner.
  // It calls services directly rather than through a route, so there is
  // no middleware to enter a tenant scope and each test would need its
  // own `runAsTenant` — see `bill-list.integration.test.ts` for the
  // shape that conversion takes. Counted by
  // `src/__tests__/app/rls-suite-coverage.test.ts`, which only lets the
  // number go down.
  process.env.DATABASE_URL = booted.dbUrl;
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
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  // utility_setting isn't in resetDb's truncate list (post-dates it);
  // wipe it explicitly so each test starts from a known state.
  await prisma.$executeRawUnsafe("DELETE FROM utility_setting");
  await resetDb();
});

async function seedSetting(utilityId: string, name: string, value: unknown): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.utilitySetting.create({
    data: { utilityId, name, value: value as object },
  });
}

describe("TenantLoader", () => {
  it("tenant:drought_stage returns the stored stage when the row exists", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedSetting(TENANT_A, "drought_stage", 2);

    const loader = new TenantLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["tenant:drought_stage"]);
    expect(out.get("tenant:drought_stage")).toBe(2);
  });

  it("tenant:drought_stage falls back to 0 when no row is seeded", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new TenantLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["tenant:drought_stage"]);
    expect(out.get("tenant:drought_stage")).toBe(0);
  });

  it("tenant:flags:<name> returns true when flags.<name> is true", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedSetting(TENANT_A, "flags.autopay", true);

    const loader = new TenantLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["tenant:flags:autopay"]);
    expect(out.get("tenant:flags:autopay")).toBe(true);
  });

  it("tenant:flags:<name> returns false when no row is seeded", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);

    const loader = new TenantLoader(prismaImports.prisma, TENANT_A);
    const out = await loader.load(["tenant:flags:missing"]);
    expect(out.get("tenant:flags:missing")).toBe(false);
  });

  it("batches multiple keys into a single utility_setting query", async () => {
    await makeTenantFixture(prismaImports.prisma, TENANT_A);
    await seedSetting(TENANT_A, "drought_stage", 3);
    await seedSetting(TENANT_A, "flags.autopay", true);
    await seedSetting(TENANT_A, "flags.paperless_default", false);

    const original = prismaImports.prisma.utilitySetting.findMany.bind(
      prismaImports.prisma.utilitySetting,
    );
    const spy = vi
      .spyOn(prismaImports.prisma.utilitySetting, "findMany")
      .mockImplementation((args) => original(args) as ReturnType<typeof original>);
    try {
      const loader = new TenantLoader(prismaImports.prisma, TENANT_A);
      const out = await loader.load([
        "tenant:drought_stage",
        "tenant:flags:autopay",
        "tenant:flags:paperless_default",
        "tenant:flags:missing",
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(out.get("tenant:drought_stage")).toBe(3);
      expect(out.get("tenant:flags:autopay")).toBe(true);
      expect(out.get("tenant:flags:paperless_default")).toBe(false);
      expect(out.get("tenant:flags:missing")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
