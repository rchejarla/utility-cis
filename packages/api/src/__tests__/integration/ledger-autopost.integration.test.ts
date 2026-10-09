import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — auto-post resolution. Tenant default, overridable per
 * account, default on. Covers the Review Focus case where the account
 * override is false while the tenant default is true.
 *
 * The second describe block covers the wiring rather than the
 * resolution: it goes through `generateBillForAccount`, the real caller,
 * so that deleting or inverting the auto-post block in bill.service.ts
 * fails a test. Calling `postBill` directly would not catch that.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let billing: typeof import("../../services/bill.service.js");

const utilityId = "00000000-0000-4000-8000-0000000000aa";
let accountId: string;
let serviceAgreementId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  billing = await import("../../services/bill.service.js");

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

  // Enough graph for generateBillForAccount to have something to bill:
  // one service agreement to hang unbilled BillSegments off. No rate
  // schedule or meter read — the segment amount is written by hand, so
  // the rate engine is not in the picture.
  const commodity = await prisma.commodity.create({
    data: { utilityId, code: "WATER", name: "Potable Water", displayOrder: 1 },
  });
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      agreementNumber: "AUTOPOST-SA-1",
      accountId,
      commodityId: commodity.id,
      startDate: new Date("2025-01-01"),
      status: "ACTIVE",
    },
  });
  serviceAgreementId = sa.id;

  // computeBillPeriod clamps periodStart to account.createdAt, which
  // defaults to now — that would push the period past the segment and
  // yield NO_SEGMENTS_TO_BILL.
  await prisma.$executeRawUnsafe(
    "UPDATE account SET created_at = '2025-01-01T00:00:00Z'::timestamptz WHERE id = $1::uuid",
    accountId,
  );
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.deleteMany({ where: { utilityId } });
  await prisma.ledgerEntry.deleteMany({});
  await prisma.billSegment.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { autoPostBills: null, balance: 0, lastDueDate: null },
  });
});

async function setTenant(autoPostBills: boolean) {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({ data: { utilityId, autoPostBills } });
}

async function setAccount(autoPostBills: boolean | null) {
  const { prisma } = prismaImports;
  await prisma.account.update({ where: { id: accountId }, data: { autoPostBills } });
}

/**
 * One unbilled BillSegment in the period a 2026-05-15 asOfDate derives
 * for a billDay=15 monthly cycle: [2026-04-16, 2026-05-15].
 */
async function makeSegment(total: string) {
  const { prisma } = prismaImports;
  await prisma.billSegment.create({
    data: {
      utilityId,
      serviceAgreementId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      minimumFloorApplied: false,
      segmentNumber: `SEG-AP-${Math.random().toString(36).slice(2, 10)}`,
    },
  });
}

function generate() {
  return billing.generateBillForAccount(utilityId, ACTOR, "Tester", accountId, {
    asOfDate: new Date("2026-05-15T00:00:00Z"),
  });
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

describe("generateBillForAccount — auto-post wiring", () => {
  it("posts the bill it generated when auto-post resolves true", async () => {
    const { prisma } = prismaImports;
    await setTenant(true);
    await makeSegment("64.0000");

    const bill = await generate();
    expect(bill.total).toBe("64.0000");

    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId: bill.id } });
    expect(entry.type).toBe("BILL_CHARGE");
    expect(entry.amount.toFixed(2)).toBe("64.00");
    expect(entry.openAmount.toFixed(2)).toBe("64.00");
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");

    const dbBill = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(dbBill.postedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("64.00");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");
  }, 60_000);

  it("leaves the generated bill unposted when the account overrides auto-post to false", async () => {
    const { prisma } = prismaImports;
    await setTenant(true);
    await setAccount(false);
    await makeSegment("64.0000");

    const bill = await generate();

    const dbBill = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(dbBill.postedAt).toBeNull();
    expect(await prisma.ledgerEntry.count({ where: { utilityId, accountId } })).toBe(0);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
    expect(account.lastDueDate).toBeNull();
  }, 60_000);
});
