import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
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

/**
 * The services this file calls directly, as a route reaches them:
 * acting for the tenant, not merely naming it.
 *
 * Each already takes the tenant as its first argument, and in
 * production that value came from a request or a job whose scope was
 * entered before the call — so the argument and the scope are always
 * the same id. A direct service test has the argument and not the
 * scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` here also overrides the surrounding
 * `seedAsPlatform`, which is what lets fixture rows be arranged
 * across tenants while the call under test stays confined to one.
 */
const generateBillForAccount = (...args: Parameters<typeof billing.generateBillForAccount>) =>
  runAsTenant(args[0], async () => billing.generateBillForAccount(...args));

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  billing = await import("../../services/bill.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
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
}), 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the tenant and platform pools are
  // ended here. Without it the container stops while connections are
  // live and Postgres reports 57P01 after an otherwise green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await prisma.utilityConfig.deleteMany({ where: { utilityId } });
  await prisma.ledgerEntry.deleteMany({});
  await prisma.billSegment.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { autoPostBills: null, balance: 0, lastDueDate: null },
  });
}),
);

/**
 * `resolveAutoPostBills` as a route reaches it.
 *
 * Its tenant is the second argument, after the client it runs on, so the
 * scope is entered around the call rather than passed into it.
 */
const resolveAutoPostBills = (
  ...args: Parameters<typeof posting.resolveAutoPostBills>
) => runAsTenant(args[1], async () => posting.resolveAutoPostBills(...args));

async function setTenant(autoPostBills: boolean) {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.utilityConfig.create({ data: { utilityId, autoPostBills } });

  });
}

async function setAccount(autoPostBills: boolean | null) {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.account.update({ where: { id: accountId }, data: { autoPostBills } });

  });
}

/**
 * One unbilled BillSegment in the period a 2026-05-15 asOfDate derives
 * for a billDay=15 monthly cycle: [2026-04-16, 2026-05-15].
 */
async function makeSegment(total: string) {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
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

  });
}

function generate() {
  return generateBillForAccount(utilityId, ACTOR, "Tester", accountId, {
    asOfDate: new Date("2026-05-15T00:00:00Z"),
  });
}

describe("resolveAutoPostBills", () => {
  it("defaults to true when no tenant config row exists", async () => {
    const { prisma } = prismaImports;
    await expect(resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });

  it("follows the tenant default when the account does not override", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await setTenant(false);
      await expect(resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
      await prisma.utilityConfig.deleteMany({ where: { utilityId } });
      await setTenant(true);
      await expect(resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  
    }));

  // Review Focus: the override must win, including when it is `false`
  it("lets an account override of false beat a tenant default of true", async () => {
    const { prisma } = prismaImports;
    await setTenant(true);
    await setAccount(false);
    await expect(resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(false);
  });

  it("lets an account override of true beat a tenant default of false", async () => {
    const { prisma } = prismaImports;
    await setTenant(false);
    await setAccount(true);
    await expect(resolveAutoPostBills(prisma, utilityId, accountId)).resolves.toBe(true);
  });
});

describe("generateBillForAccount — auto-post wiring", () => {
  it("posts the bill it generated when auto-post resolves true", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
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
  
    }), 60_000);

  it("leaves the generated bill unposted when the account overrides auto-post to false", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
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
  
    }), 60_000);
});

/**
 * The number describes the bill, not the moment it was made.
 *
 * `nextBillNumber` took `new Date()`, so the prefix was the month the
 * run happened in rather than the month the bill is for. A cycle run
 * late — or a window deliberately set forward, which the start dialog
 * allows — produced numbers contradicting their own bill date: a
 * November bill numbered `BILL-202610-4`. The number is immutable once
 * issued, and `billDate` sits one line above the call.
 *
 * The prefix also read local-time accessors in a file where every other
 * date is UTC, so west of Greenwich a bill generated late on the 31st
 * took the next month's prefix.
 */
describe("the bill number", () => {
  it("takes its month from the bill date, not from today", async () => {
    // Its own segment: the suite's fixture is consumed by the tests
    // above, and a bill needs something unbilled to assemble from.
    await makeSegment("25.00");
    const bill = await generate();

    // The bill is for 2026-05; this test runs whenever it runs.
    expect(bill.billDate.toISOString().slice(0, 7)).toBe("2026-05");
    expect(bill.billNumber).toMatch(/^BILL-202605-\d+$/);
  });
});
