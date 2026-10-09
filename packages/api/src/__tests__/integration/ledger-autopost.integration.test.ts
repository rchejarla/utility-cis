import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — auto-post resolution. Tenant default, overridable per
 * account, default on. Covers the Review Focus case where the account
 * override is false while the tenant default is true.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");

const utilityId = "00000000-0000-4000-8000-0000000000aa";
let accountId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "AUTOPOST-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.deleteMany({ where: { utilityId } });
  await prisma.account.update({ where: { id: accountId }, data: { autoPostBills: null } });
});

async function setTenant(autoPostBills: boolean) {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({ data: { utilityId, autoPostBills } });
}

async function setAccount(autoPostBills: boolean | null) {
  const { prisma } = prismaImports;
  await prisma.account.update({ where: { id: accountId }, data: { autoPostBills } });
}

describe("resolveAutoPostBills", () => {
  it("defaults to true when no tenant config row exists", async () => {
    const { prisma } = prismaImports;
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });

  it("follows the tenant default when the account does not override", async () => {
    const { prisma } = prismaImports;
    await setTenant(false);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
    await prisma.tenantConfig.deleteMany({ where: { utilityId } });
    await setTenant(true);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });

  // Review Focus: the override must win, including when it is `false`
  it("lets an account override of false beat a tenant default of true", async () => {
    const { prisma } = prismaImports;
    await setTenant(true);
    await setAccount(false);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
  });

  it("lets an account override of true beat a tenant default of false", async () => {
    const { prisma } = prismaImports;
    await setTenant(false);
    await setAccount(true);
    await expect(posting.resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });
});
