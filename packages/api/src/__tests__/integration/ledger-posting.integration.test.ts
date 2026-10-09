import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * Slice 1 — postBill creates the receivable and moves the cached
 * balance, in one transaction. Covers the Review Focus cases for a
 * zero-total bill and half-cent rounding.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");

let utilityId: string;
let accountId: string;
let billingCycleId: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");

  const { prisma } = prismaImports;
  utilityId = "00000000-0000-4000-8000-0000000000aa";
  const cycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Route 1",
      cycleCode: "R01",
      billDayOfMonth: 15,
      frequency: "MONTHLY",
    },
  });
  billingCycleId = cycle.id;
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "LEDGER-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId,
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
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.bill.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
});

async function makeBill(total: string, dueDate = "2026-06-14"): Promise<string> {
  const { prisma } = prismaImports;
  const bill = await prisma.bill.create({
    data: {
      utilityId,
      accountId,
      billingCycleId,
      periodStart: new Date("2026-04-16"),
      periodEnd: new Date("2026-05-15"),
      billDate: new Date("2026-05-15"),
      dueDate: new Date(dueDate),
      subtotal: total,
      taxes: "0",
      credits: "0",
      total,
      billNumber: `BILL-TEST-${Math.random().toString(36).slice(2, 8)}`,
    },
  });
  return bill.id;
}

describe("postBill", () => {
  it("creates a BILL_CHARGE and moves the cached balance", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("69.6500");

    const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);

    expect(result.amount).toBe("69.65");
    expect(result.skippedZero).toBe(false);

    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    expect(entry.type).toBe("BILL_CHARGE");
    expect(entry.amount.toFixed(2)).toBe("69.65");
    expect(entry.openAmount.toFixed(2)).toBe("69.65");
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("69.65");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-06-14");

    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(bill.postedAt).not.toBeNull();
  });

  it("writes an audit row in the same transaction", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("10.0000");
    const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);
    const audits = await prisma.auditLog.findMany({
      where: { entityType: "LedgerEntry", entityId: result.entryId! },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("CREATE");
  });

  // Review Focus: half-cent boundary
  it("rounds a half-cent total half-up", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("47.3250");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { billId } });
    expect(entry.amount.toFixed(2)).toBe("47.33");
  });

  // Review Focus: zero-total bill
  it("marks a zero-total bill posted without writing an entry", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("0.0000");

    const result = await posting.postBill(utilityId, ACTOR, "Tester", billId);

    expect(result.skippedZero).toBe(true);
    expect(result.entryId).toBeNull();
    expect(await prisma.ledgerEntry.count({ where: { billId } })).toBe(0);

    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(bill.postedAt).not.toBeNull();

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
  });

  it("posts a negative-total bill as ADJUSTMENT_CREDIT", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("-12.5000");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    // A credit carries no billId (type/sign CHECK), so find it by account.
    const entry = await prisma.ledgerEntry.findFirstOrThrow({ where: { accountId } });
    expect(entry.type).toBe("ADJUSTMENT_CREDIT");
    expect(entry.billId).toBeNull();
    expect(entry.dueDate).toBeNull();
    expect(entry.amount.toFixed(2)).toBe("-12.50");
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("-12.50");
  });

  it("refuses an unknown bill", async () => {
    await expect(
      posting.postBill(utilityId, ACTOR, "Tester", "00000000-0000-4000-8000-00000000dead"),
    ).rejects.toMatchObject({ code: "BILL_NOT_FOUND" });
  });

  it("rejects posting the same bill twice", async () => {
    const billId = await makeBill("10.0000");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    await expect(posting.postBill(utilityId, ACTOR, "Tester", billId)).rejects.toMatchObject({
      code: "BILL_ALREADY_POSTED",
    });
  });

  it("nets a debit and a credit through the signed sum", async () => {
    const { prisma } = prismaImports;
    await posting.postBill(utilityId, ACTOR, "Tester", await makeBill("50.0000"));
    await posting.postBill(utilityId, ACTOR, "Tester", await makeBill("-12.5000"));
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("37.50");
  });

  it("waits on the account row lock, then updates balance and lastDueDate", async () => {
    const { prisma } = prismaImports;
    await posting.postBill(utilityId, ACTOR, "Tester", await makeBill("30.0000", "2026-06-14"));
    const billB = await makeBill("20.0000", "2026-05-01");

    // Hold the account row lock in a transaction we control. FOR NO KEY
    // UPDATE, not FOR UPDATE: it still conflicts with postBill's FOR UPDATE
    // and with its final account UPDATE, but not with the FOR KEY SHARE an
    // entry insert takes through the foreign key. Plain FOR UPDATE would
    // block an unlocked poster at the insert, before its SUM, and hide the race.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM account
                            WHERE id = ${accountId}::uuid AND utility_id = ${utilityId}::uuid
                              FOR NO KEY UPDATE`;
        // Write an entry that is uncommitted while we hold the lock. A poster
        // that does not wait for the lock sums without it and then
        // overwrites the cache with a stale total and due date.
        await tx.ledgerEntry.create({
          data: {
            utilityId,
            accountId,
            type: "ADJUSTMENT_DEBIT",
            amount: "5.00",
            openAmount: "5.00",
            dueDate: new Date("2026-04-01"),
            effectiveDate: new Date("2026-04-01"),
            createdBy: ACTOR,
          },
        });
        locked();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    await lockTaken;

    let resolved = false;
    const posting2 = posting.postBill(utilityId, ACTOR, "Tester", billB).then((r) => {
      resolved = true;
      return r;
    });

    // Discriminating assertion: without the account lock this resolves at once.
    await new Promise((r) => setTimeout(r, 1500));
    expect(resolved).toBe(false);

    release();
    await holder;
    const result = await posting2;
    expect(result.balance).toBe("55.00");

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("55.00");
    expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it("clears lastDueDate when no open debit remains", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("10.0000");
    await posting.postBill(utilityId, ACTOR, "Tester", billId);
    await prisma.$executeRaw`UPDATE ledger_entry SET open_amount = 0 WHERE bill_id = ${billId}::uuid`;
    const cache = await prisma.$transaction((tx) =>
      posting.recomputeAccountCache(tx, utilityId, accountId),
    );
    expect(cache.lastDueDate).toBeNull();
    expect(cache.balance).toBe("0.00");
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.lastDueDate).toBeNull();
  });

  it("leaves nothing behind when the caller's transaction rolls back", async () => {
    const { prisma } = prismaImports;
    const billId = await makeBill("10.0000");
    await expect(
      prisma.$transaction(async (tx) => {
        await posting.postBill(utilityId, ACTOR, "Tester", billId, {}, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: billId } });
    expect(bill.postedAt).toBeNull();
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.balance.toFixed(2)).toBe("0.00");
  });
});
