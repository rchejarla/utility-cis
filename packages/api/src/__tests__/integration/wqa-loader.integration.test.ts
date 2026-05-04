import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Decimal } from "decimal.js";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
} from "./_effective-dating-fixtures.js";
import { WqaLoader } from "../../lib/rate-engine-loaders/loaders/wqa-loader.js";

/**
 * Slice 4 task 5 — WqaLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's two declared patterns against real `wqa_value` rows:
 *   - wqa:current:<sa_id>   override-or-computed
 *   - wqa:override:<sa_id>  override-only (null when absent)
 *
 * Tests cover override-wins semantics, missing-row error vs null,
 * and latest-waterYear selection.
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

interface SaFixture {
  saId: string;
}

async function makeSa(agreementNumber = "SA-WQA-1"): Promise<SaFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);

  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber,
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });

  return { saId: sa.id };
}

interface SeedRowOpts {
  saId: string;
  waterYear: number;
  computedAvg: string;
  overrideValue?: string;
}

async function seedWqaRow(opts: SeedRowOpts): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.wqaValue.create({
    data: {
      utilityId: TENANT_A,
      serviceAgreementId: opts.saId,
      waterYear: opts.waterYear,
      computedAt: new Date("2026-04-01T00:00:00Z"),
      sourceWindowStart: new Date(`${opts.waterYear}-12-01`),
      sourceWindowEnd: new Date(`${opts.waterYear + 1}-03-01`),
      computedAvg: opts.computedAvg,
      overrideValue: opts.overrideValue ?? null,
    },
  });
}

beforeEach(async () => {
  const { prisma } = prismaImports;
  // wqa_value isn't in resetDb's truncate list (post-dates it); wipe
  // it explicitly before resetDb cascades the rest.
  await prisma.$executeRawUnsafe("DELETE FROM wqa_value");
  await resetDb(prisma);
});

describe("WqaLoader", () => {
  it("wqa:current returns computedAvg when no override is set", async () => {
    const { saId } = await makeSa();
    await seedWqaRow({ saId, waterYear: 2025, computedAvg: "12.3400" });

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([`wqa:current:${saId}`]);

    const v = out.get(`wqa:current:${saId}`);
    expect(v).toBeInstanceOf(Decimal);
    expect((v as Decimal).toString()).toBe("12.34");
  });

  it("wqa:current returns overrideValue when override is set", async () => {
    const { saId } = await makeSa();
    await seedWqaRow({
      saId,
      waterYear: 2025,
      computedAvg: "12.3400",
      overrideValue: "9.5000",
    });

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([`wqa:current:${saId}`]);

    const v = out.get(`wqa:current:${saId}`);
    expect(v).toBeInstanceOf(Decimal);
    expect((v as Decimal).toString()).toBe("9.5");
  });

  it("wqa:override returns null when no override is set", async () => {
    const { saId } = await makeSa();
    await seedWqaRow({ saId, waterYear: 2025, computedAvg: "12.3400" });

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([`wqa:override:${saId}`]);

    expect(out.get(`wqa:override:${saId}`)).toBeNull();
  });

  it("wqa:override returns Decimal when override is set", async () => {
    const { saId } = await makeSa();
    await seedWqaRow({
      saId,
      waterYear: 2025,
      computedAvg: "12.3400",
      overrideValue: "9.5000",
    });

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([`wqa:override:${saId}`]);

    const v = out.get(`wqa:override:${saId}`);
    expect(v).toBeInstanceOf(Decimal);
    expect((v as Decimal).toString()).toBe("9.5");
  });

  it("wqa:current throws when no WqaValue row exists for the SA", async () => {
    const { saId } = await makeSa();
    // No seedWqaRow — the row is intentionally missing.

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    await expect(loader.load([`wqa:current:${saId}`])).rejects.toThrow(
      /No WqaValue stored/,
    );
  });

  it("wqa:override returns null when no WqaValue row exists for the SA", async () => {
    const { saId } = await makeSa();
    // No seedWqaRow.

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([`wqa:override:${saId}`]);
    expect(out.get(`wqa:override:${saId}`)).toBeNull();
  });

  it("uses the latest waterYear row when multiple are stored", async () => {
    const { saId } = await makeSa();
    await seedWqaRow({ saId, waterYear: 2023, computedAvg: "5.0000" });
    await seedWqaRow({ saId, waterYear: 2024, computedAvg: "7.0000" });
    await seedWqaRow({ saId, waterYear: 2025, computedAvg: "12.3400" });

    const loader = new WqaLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([
      `wqa:current:${saId}`,
      `wqa:override:${saId}`,
    ]);

    const cur = out.get(`wqa:current:${saId}`);
    expect(cur).toBeInstanceOf(Decimal);
    expect((cur as Decimal).toString()).toBe("12.34");
    expect(out.get(`wqa:override:${saId}`)).toBeNull();
  });
});
