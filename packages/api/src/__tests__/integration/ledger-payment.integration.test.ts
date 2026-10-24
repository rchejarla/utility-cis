import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 2 — recording money received (§6.2).
 *
 * The request carries a positive amount; the entry is negative. These
 * tests pin that in both directions, because a sign error here posts
 * money received as money owed and the balance still looks plausible.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");

let accountId: string;
let debitReasonId: string;

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
const recordPayment = (...args: Parameters<typeof payment.recordPayment>) =>
  runAsTenant(args[0], async () => payment.recordPayment(...args));

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "PAY-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;

  // Slice 3's ledger_entry_reason_required: an ADJUSTMENT_DEBIT must cite
  // a reason, so the fixtures need one.
  const reason = await prisma.ledgerReasonDef.create({
    data: {
      utilityId,
      code: "PAY-FIXTURE",
      label: "Payment suite fixture",
      appliesToType: "ADJUSTMENT_DEBIT",
    },
  });
  debitReasonId = reason.id;
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
  await prisma.ledgerApplication.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.account.update({
    where: { id: accountId },
    data: { balance: 0, lastDueDate: null },
  });
}),
);

async function debit(amount: string, dueDate: string): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const e = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate: new Date(dueDate),
        effectiveDate: new Date(dueDate),
        reasonId: debitReasonId,
        createdBy: ACTOR,
      },
    });
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, accountId));
    return e.id;

  });
}

async function openOf(id: string): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const e = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id } });
    return e.openAmount.toFixed(2);

  });
}

describe("recordPayment", () => {
  it("writes a negative PAYMENT and reduces the balance", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await debit("100.00", "2026-06-14");

      const res = await recordPayment(utilityId, ACTOR, "Tester", accountId, {
        amount: "40.00",
        tender: "CHECK",
      });

      expect(res.amount).toBe("-40.00");
      expect(res.balance).toBe("60.00");
      expect(res.applied).toHaveLength(1);
      expect(res.unapplied).toBe("0.00");

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.paymentId } });
      expect(entry.type).toBe("PAYMENT");
      expect(entry.amount.toFixed(2)).toBe("-40.00");
      expect(entry.tender).toBe("CHECK");
      // Only a debit ages.
      expect(entry.dueDate).toBeNull();

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("60.00");
  
    }));

  // Review Focus: overpayment becomes a credit balance, no special case.
  it("leaves the remainder open and the balance negative when it overpays", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const d = await debit("30.00", "2026-06-14");

      const res = await recordPayment(utilityId, ACTOR, "Tester", accountId, {
        amount: "50.00",
        tender: "CARD",
      });

      expect(res.unapplied).toBe("20.00");
      expect(res.balance).toBe("-20.00");
      expect(await openOf(d)).toBe("0.00");
      expect(await openOf(res.paymentId)).toBe("-20.00");

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("-20.00");
      // Nothing is open on the debit side, so nothing ages.
      expect(account.lastDueDate).toBeNull();
  
    }));

  it("records a payment on an account that owes nothing", async () => {
    const res = await recordPayment(utilityId, ACTOR, "Tester", accountId, {
      amount: "25.00",
      tender: "CASH",
    });
    expect(res.applied).toEqual([]);
    expect(res.unapplied).toBe("25.00");
    expect(res.balance).toBe("-25.00");
  });

  it("carries receivedAt, externalRef and memo onto the entry", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await recordPayment(utilityId, ACTOR, "Tester", accountId, {
        amount: "15.00",
        tender: "LOCKBOX",
        receivedAt: "2026-06-01",
        externalRef: "BATCH-77",
        memo: "lockbox batch 77",
      });
      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.paymentId } });
      expect(entry.effectiveDate.toISOString().slice(0, 10)).toBe("2026-06-01");
      expect(entry.externalRef).toBe("BATCH-77");
      expect(entry.memo).toBe("lockbox batch 77");
  
    }));

  it("writes one audit row for the payment", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await recordPayment(utilityId, ACTOR, "Tester", accountId, {
        amount: "10.00",
        tender: "ACH",
      });
      const audits = await prisma.auditLog.findMany({
        where: { entityType: "LedgerEntry", entityId: res.paymentId },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("CREATE");
  
    }));

  it("refuses an unknown account", async () => {
    await expect(
      recordPayment(
        utilityId,
        ACTOR,
        "Tester",
        "00000000-0000-4000-8000-00000000dead",
        { amount: "10.00", tender: "CASH" },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("refuses an account belonging to another tenant and writes nothing", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await expect(
        recordPayment(
          "00000000-0000-4000-8000-0000000000bb",
          ACTOR,
          "Tester",
          accountId,
          { amount: "10.00", tender: "CASH" },
        ),
      ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
      expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
  
    }));

  it("leaves nothing behind when the caller's transaction rolls back", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await expect(
        prisma.$transaction(async (tx) => {
          await recordPayment(
            utilityId,
            ACTOR,
            "Tester",
            accountId,
            { amount: "10.00", tender: "CASH" },
            tx,
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("0.00");
  
    }));

  it("serializes two concurrent payments on one account", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await debit("100.00", "2026-06-14");

      await Promise.all([
        recordPayment(utilityId, ACTOR, "T", accountId, { amount: "30.00", tender: "CASH" }),
        recordPayment(utilityId, ACTOR, "T", accountId, { amount: "20.00", tender: "CASH" }),
      ]);

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("50.00");

      // The cache agrees with the ledger, which is the invariant a lost
      // update would break even when both payments landed.
      const sum = await prisma.$queryRaw<{ s: string }[]>`
        SELECT COALESCE(SUM(open_amount),0)::text AS s FROM ledger_entry
         WHERE utility_id = ${utilityId}::uuid AND account_id = ${accountId}::uuid`;
      expect(Number(sum[0]!.s)).toBe(50);

      // And neither payment over-applied: total applications equal 50.
      const apps = await prisma.ledgerApplication.findMany({ where: { utilityId } });
      expect(apps.reduce((t, a) => t + Number(a.amount), 0)).toBe(50);
  
    }), 60_000);
});
