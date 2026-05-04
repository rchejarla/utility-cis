import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, resetDb, makeTenantFixture, TENANT_A } from "./_effective-dating-fixtures.js";
import { AccountLoader } from "../../lib/rate-engine-loaders/loaders/account-loader.js";

/**
 * Slice 4 task 2 — AccountLoader integration tests.
 *
 * Boots a Postgres container, applies migrations, and exercises the
 * loader's two patterns against real rows: `account:class` (resolved
 * via the SA → rate_service_class join) and `account:flag:*` (mix of
 * dedicated bool columns and JSONB custom_fields fall-through).
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
  accountId: string;
  serviceClassId: string;
}

/**
 * Build one SA with optional rate_service_class assignment and
 * optional account-level overrides on top of the shared tenant
 * fixture. Returns the IDs the test will load against.
 */
async function makeSaFixture(opts: {
  attachServiceClass: boolean;
  serviceClassCode?: string;
  accountOverrides?: {
    paperlessBilling?: boolean;
    budgetBilling?: boolean;
    isProtected?: boolean;
    depositWaived?: boolean;
    customFields?: Record<string, unknown>;
  };
  agreementNumber?: string;
}): Promise<SaFixture> {
  const { prisma } = prismaImports;
  const fix = await makeTenantFixture(prisma, TENANT_A);

  // Apply any account overrides — the fixture creates the row with
  // defaults; tests want to flip specific columns. Prisma's JSON
  // field input typing is invariant w.r.t. `Record<string, unknown>`,
  // so we narrow at the assignment site.
  if (opts.accountOverrides) {
    const { customFields, ...rest } = opts.accountOverrides;
    await prisma.account.update({
      where: { id: fix.accountId },
      data: {
        ...rest,
        ...(customFields !== undefined ? { customFields: customFields as object } : {}),
      },
    });
  }

  let serviceClassId = "";
  if (opts.attachServiceClass) {
    const cls = await prisma.rateServiceClass.create({
      data: {
        utilityId: fix.utilityId,
        commodityId: fix.commodityId,
        code: opts.serviceClassCode ?? "single_family",
        label: "Single Family",
      },
    });
    serviceClassId = cls.id;
  }

  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fix.utilityId,
      agreementNumber: opts.agreementNumber ?? "SA-LOADER-1",
      accountId: fix.accountId,
      commodityId: fix.commodityId,
      billingCycleId: fix.billingCycleId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
      rateServiceClassId: opts.attachServiceClass ? serviceClassId : null,
    },
  });

  return { saId: sa.id, accountId: fix.accountId, serviceClassId };
}

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb(prisma);
  // resetDb truncates the core tables; rate_service_class isn't in
  // its list (it post-dates the helper). Wipe it explicitly so each
  // test starts from a known empty state.
  await prisma.$executeRawUnsafe("DELETE FROM rate_service_class");
});

describe("AccountLoader", () => {
  it("account:class returns the rateServiceClass code when the SA has one", async () => {
    const { saId } = await makeSaFixture({
      attachServiceClass: true,
      serviceClassCode: "multi_family",
    });

    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load(["account:class"]);
    expect(out.get("account:class")).toBe("multi_family");
  });

  it("account:class returns null when the SA has no rateServiceClassId", async () => {
    const { saId } = await makeSaFixture({ attachServiceClass: false });

    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load(["account:class"]);
    expect(out.get("account:class")).toBeNull();
  });

  it("account:flag:paperless_billing returns true when the column is true", async () => {
    const { saId } = await makeSaFixture({
      attachServiceClass: false,
      accountOverrides: { paperlessBilling: true },
    });

    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load(["account:flag:paperless_billing"]);
    expect(out.get("account:flag:paperless_billing")).toBe(true);
  });

  it("account:flag:paperless_billing returns false when the column is false", async () => {
    const { saId } = await makeSaFixture({
      attachServiceClass: false,
      accountOverrides: { paperlessBilling: false },
    });

    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load(["account:flag:paperless_billing"]);
    expect(out.get("account:flag:paperless_billing")).toBe(false);
  });

  it("account:flag:<unknown> falls through to custom_fields", async () => {
    const { saId } = await makeSaFixture({
      attachServiceClass: false,
      accountOverrides: { customFields: { autopay: true, snowflake: 0 } },
    });

    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
    const out = await loader.load([
      "account:flag:autopay",
      "account:flag:snowflake",
      "account:flag:missing",
    ]);
    // truthy
    expect(out.get("account:flag:autopay")).toBe(true);
    // falsy primitive in JSON still maps to false
    expect(out.get("account:flag:snowflake")).toBe(false);
    // unknown key is undefined → false
    expect(out.get("account:flag:missing")).toBe(false);
  });

  it("batches multiple keys into a single SA query", async () => {
    const { saId } = await makeSaFixture({
      attachServiceClass: true,
      serviceClassCode: "commercial",
      accountOverrides: {
        paperlessBilling: true,
        budgetBilling: false,
        customFields: { autopay: true },
      },
    });

    // Wrap a passthrough so we can count calls without breaking the
    // real query result. `vi.spyOn` alone replaces the implementation
    // with a stub returning `undefined`.
    const original = prismaImports.prisma.serviceAgreement.findUniqueOrThrow.bind(
      prismaImports.prisma.serviceAgreement,
    );
    const spy = vi
      .spyOn(prismaImports.prisma.serviceAgreement, "findUniqueOrThrow")
      .mockImplementation((args) => original(args) as ReturnType<typeof original>);
    try {
      const loader = new AccountLoader(prismaImports.prisma, TENANT_A, saId);
      const out = await loader.load([
        "account:class",
        "account:flag:paperless_billing",
        "account:flag:budget_billing",
        "account:flag:autopay",
      ]);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(out.get("account:class")).toBe("commercial");
      expect(out.get("account:flag:paperless_billing")).toBe(true);
      expect(out.get("account:flag:budget_billing")).toBe(false);
      expect(out.get("account:flag:autopay")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("throws when the SA does not exist", async () => {
    const missingId = "00000000-0000-4000-8000-deadbeef0001";
    const loader = new AccountLoader(prismaImports.prisma, TENANT_A, missingId);
    await expect(loader.load(["account:class"])).rejects.toThrow();
  });
});
