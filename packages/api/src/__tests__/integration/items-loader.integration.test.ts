import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { ItemsLoader } from "../../lib/rate-engine-loaders/loaders/items-loader.js";

/**
 * Slice 4 task 6 — ItemsLoader integration tests.
 *
 * Exercises `items:<sp_id>:<item_type>` against real Container rows.
 * The loader fetches the SA's active containers once and filters per
 * key, so multi-key loads share a single DB hit. Inactive containers
 * are excluded.
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
  await prisma.$executeRawUnsafe("DELETE FROM container");
  await resetDb(prisma);
});

interface ItemsFixture {
  fix: TenantFixture;
  saId: string;
}

async function makeItemsFixture(): Promise<ItemsFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: "SA-ITEMS-1",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  return { fix, saId: sa.id };
}

interface MakeContainerOpts {
  utilityId: string;
  premiseId: string;
  saId: string;
  containerType:
    | "CART_GARBAGE"
    | "CART_RECYCLING"
    | "CART_ORGANICS"
    | "CART_YARD_WASTE"
    | "DUMPSTER"
    | "ROLL_OFF";
  itemType: string;
  size?: string;
  frequency?: string;
  sizeGallons: number;
  status?: "ACTIVE" | "SUSPENDED" | "RETURNED" | "LOST" | "DAMAGED";
}

async function makeContainer(opts: MakeContainerOpts): Promise<string> {
  const { prisma } = prismaImports;
  const c = await prisma.container.create({
    data: {
      utilityId: opts.utilityId,
      premiseId: opts.premiseId,
      serviceAgreementId: opts.saId,
      containerType: opts.containerType,
      sizeGallons: opts.sizeGallons,
      itemType: opts.itemType,
      size: opts.size ?? null,
      frequency: opts.frequency ?? null,
      status: opts.status ?? "ACTIVE",
      deliveryDate: new Date("2026-01-01"),
    },
  });
  return c.id;
}

describe("ItemsLoader", () => {
  it("filters containers by item_type for a single key", async () => {
    const { fix, saId } = await makeItemsFixture();
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      size: "96gal",
      frequency: "weekly",
      sizeGallons: 96,
    });
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_RECYCLING",
      itemType: "recycling_cart",
      size: "64gal",
      frequency: "weekly",
      sizeGallons: 64,
    });

    const loader = new ItemsLoader(prismaImports.prisma, TENANT_A, saId);
    const key = "items:sp-1:garbage_cart";
    const out = await loader.load([key]);
    const containers = out.get(key) as Array<{ itemType: string; size: string | null }>;
    expect(containers).toHaveLength(1);
    expect(containers[0]!.itemType).toBe("garbage_cart");
    expect(containers[0]!.size).toBe("96gal");
  });

  it("filters multiple keys with different item_types in one load call", async () => {
    const { fix, saId } = await makeItemsFixture();
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      sizeGallons: 96,
    });
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_RECYCLING",
      itemType: "recycling_cart",
      sizeGallons: 64,
    });
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_ORGANICS",
      itemType: "organics_cart",
      sizeGallons: 32,
    });

    const loader = new ItemsLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([
      "items:sp-1:garbage_cart",
      "items:sp-1:recycling_cart",
      "items:sp-1:organics_cart",
    ]);
    expect((out.get("items:sp-1:garbage_cart") as unknown[]).length).toBe(1);
    expect((out.get("items:sp-1:recycling_cart") as unknown[]).length).toBe(1);
    expect((out.get("items:sp-1:organics_cart") as unknown[]).length).toBe(1);
    expect(
      (out.get("items:sp-1:garbage_cart") as Array<{ sizeGallons: number }>)[0]!
        .sizeGallons,
    ).toBe(96);
  });

  it("returns an empty array when no container matches the item_type", async () => {
    const { fix, saId } = await makeItemsFixture();
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      sizeGallons: 96,
    });

    const loader = new ItemsLoader(prismaImports.prisma, TENANT_A, saId);
    const key = "items:sp-1:organics_cart";
    const out = await loader.load([key]);
    expect(out.get(key)).toEqual([]);
  });

  it("excludes inactive containers", async () => {
    const { fix, saId } = await makeItemsFixture();
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      sizeGallons: 96,
      status: "ACTIVE",
    });
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      sizeGallons: 64,
      status: "RETURNED",
    });
    await makeContainer({
      utilityId: fix.utilityId,
      premiseId: fix.premiseId,
      saId,
      containerType: "CART_GARBAGE",
      itemType: "garbage_cart",
      sizeGallons: 32,
      status: "DAMAGED",
    });

    const loader = new ItemsLoader(prismaImports.prisma, TENANT_A, saId);
    const key = "items:sp-1:garbage_cart";
    const out = await loader.load([key]);
    const containers = out.get(key) as Array<{ sizeGallons: number }>;
    expect(containers).toHaveLength(1);
    expect(containers[0]!.sizeGallons).toBe(96);
  });
});
