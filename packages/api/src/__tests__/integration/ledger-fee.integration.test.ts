import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, seedAsPlatform } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
/**
 * Slice 3 — raising a fee (§6.4).
 *
 * This is the first FEE any code in this repo writes, so it is also the
 * first time DEBIT_ALLOCATION_ORDER's fees-first rule is exercised
 * against a real fee rather than an ADJUSTMENT_DEBIT standing in for one.
 *
 * Fee GENERATION is out of scope: nothing here decides when a late fee
 * is due or how much it is (§6.4). This is the entry point slice 6's job
 * and the operator screen will both call.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";
// A second tenant, named rather than inlined: it has to be declared at
// bootPostgres below, because utility_id is a foreign key.
const otherUtilityId = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let posting: typeof import("../../services/ar/posting.service.js");
let payment: typeof import("../../services/ar/payment.service.js");
let fee: typeof import("../../services/ar/fee.service.js");

let accountId: string;
let otherAccountId: string;
let feeReasonId: string;
let writeOffReasonId: string;
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
const assessFee = (...args: Parameters<typeof fee.assessFee>) =>
  runAsTenant(args[0], async () => fee.assessFee(...args));

const recordPayment = (...args: Parameters<typeof payment.recordPayment>) =>
  runAsTenant(args[0], async () => payment.recordPayment(...args));

beforeAll(() =>
  seedAsPlatform(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  posting = await import("../../services/ar/posting.service.js");
  payment = await import("../../services/ar/payment.service.js");
  fee = await import("../../services/ar/fee.service.js");

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.create({
    data: { utilityId, name: "R1", cycleCode: "R01", readDayOfMonth: 1, billDayOfMonth: 15, frequency: "MONTHLY" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "FEE-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  accountId = account.id;
  const other = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "FEE-OTHER",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
    },
  });
  otherAccountId = other.id;

  for (const [code, appliesToType] of [
    ["LATE_FEE", "FEE"],
    ["BAD_DEBT", "WRITE_OFF"],
    ["OPENING_BALANCE", "ADJUSTMENT_DEBIT"],
  ] as const) {
    const r = await prisma.ledgerReasonDef.create({
      data: { utilityId, code, label: code, appliesToType },
    });
    if (appliesToType === "FEE") feeReasonId = r.id;
    else if (appliesToType === "WRITE_OFF") writeOffReasonId = r.id;
    else debitReasonId = r.id;
  }
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
  await prisma.account.updateMany({
    where: { utilityId },
    data: { balance: 0, lastDueDate: null },
  });
}),
);

async function debit(amount: string, dueDate: string, forAccount = accountId): Promise<string> {
  /*
   * Arranging rows, so the authority the fixtures use. Calls under test
   * re-enter their own tenant scope, so they still run as `cis_app`.
   */
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const e = await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId: forAccount,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate: new Date(dueDate),
        effectiveDate: new Date(dueDate),
        reasonId: debitReasonId,
        createdBy: ACTOR,
      },
    });
    await prisma.$transaction((tx) => posting.recomputeAccountCache(tx, utilityId, forAccount));
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

describe("assessFee", () => {
  it("raises a positive FEE citing its reason, on its own due date", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "25.00",
        reasonId: feeReasonId,
        dueDate: "2026-07-14",
      });

      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.feeId } });
      expect(entry.type).toBe("FEE");
      expect(entry.amount.toFixed(2)).toBe("25.00");
      expect(entry.openAmount.toFixed(2)).toBe("25.00");
      expect(entry.reasonId).toBe(feeReasonId);
      expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-07-14");
      expect(res.amount).toBe("25.00");
      expect(res.balance).toBe("25.00");

      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("25.00");
      // A fee is a debit, so it ages.
      expect(account.lastDueDate?.toISOString().slice(0, 10)).toBe("2026-07-14");
  
    }));

  // Review Focus: a tap fee is assessed on nothing, and that is the norm.
  it("raises a fee with no assessedOnId", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "500.00",
        reasonId: feeReasonId,
      });
      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.feeId } });
      expect(entry.assessedOnId).toBeNull();
  
    }));

  it("records the debit a late fee was assessed on", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const unpaid = await debit("100.00", "2026-06-14");
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "10.00",
        reasonId: feeReasonId,
        assessedOnId: unpaid,
      });
      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.feeId } });
      expect(entry.assessedOnId).toBe(unpaid);
  
    }));

  it("defaults dueDate to 30 days after the effective date", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "25.00",
        reasonId: feeReasonId,
        effectiveDate: "2026-06-01",
      });
      const entry = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: res.feeId } });
      expect(entry.effectiveDate.toISOString().slice(0, 10)).toBe("2026-06-01");
      expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-07-01");
  
    }));

  // Review Focus: the reason has to match the type being written.
  it("refuses a reason that is not a FEE reason", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      await expect(
        assessFee(utilityId, ACTOR, "T", accountId, {
          amount: "25.00",
          reasonId: writeOffReasonId,
        }),
      ).rejects.toMatchObject({ code: "REASON_TYPE_MISMATCH", statusCode: 422 });
      expect(await prismaImports.prisma.ledgerEntry.count()).toBe(0);
  
    }));

  it("absorbs an open credit, like any new debit", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const credit = await prisma.ledgerEntry.create({
        data: {
          utilityId,
          accountId,
          type: "PAYMENT",
          amount: "-10.00",
          openAmount: "-10.00",
          effectiveDate: new Date("2026-05-01"),
          tender: "CHECK",
          createdBy: ACTOR,
        },
      });
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "25.00",
        reasonId: feeReasonId,
        dueDate: "2026-07-14",
      });
      expect(res.applied).toHaveLength(1);
      expect(res.applied[0]!.amount).toBe("10.00");
      expect(await openOf(res.feeId)).toBe("15.00");
      expect(await openOf(credit.id)).toBe("0.00");
      expect(res.balance).toBe("15.00");
  
    }));

  // The headline of this task: a real FEE row, and the fees-first rule.
  it("is paid before an older charge, because class beats date", async () => {
    const older = await debit("100.00", "2026-01-01");
    const raised = await assessFee(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      reasonId: feeReasonId,
      dueDate: "2026-12-31",
    });

    await recordPayment(utilityId, ACTOR, "T", accountId, {
      amount: "25.00",
      tender: "CASH",
    });

    expect(await openOf(raised.feeId)).toBe("0.00");
    expect(await openOf(older)).toBe("100.00");
  });

  it("refuses an assessedOnId belonging to another account", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const strayDebit = await debit("50.00", "2026-06-14", otherAccountId);
      await expect(
        assessFee(utilityId, ACTOR, "T", accountId, {
          amount: "10.00",
          reasonId: feeReasonId,
          assessedOnId: strayDebit,
        }),
      ).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
      expect(
        await prismaImports.prisma.ledgerEntry.count({ where: { accountId, type: "FEE" } }),
      ).toBe(0);
  
    }));

  it("refuses an unknown account", async () => {
    await expect(
      assessFee(utilityId, ACTOR, "T", "00000000-0000-4000-8000-00000000dead", {
        amount: "10.00",
        reasonId: feeReasonId,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("refuses a reason belonging to another tenant", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const stray = await prisma.ledgerReasonDef.create({
        data: {
          utilityId: otherUtilityId,
          code: "STRAY_FEE",
          label: "Stray",
          appliesToType: "FEE",
        },
      });
      try {
        await expect(
          assessFee(utilityId, ACTOR, "T", accountId, {
            amount: "10.00",
            reasonId: stray.id,
          }),
        ).rejects.toMatchObject({ code: "REASON_NOT_FOUND" });
      } finally {
        await prisma.ledgerReasonDef.delete({ where: { id: stray.id } });
      }
  
    }));

  it("writes one audit row", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      const res = await assessFee(utilityId, ACTOR, "T", accountId, {
        amount: "25.00",
        reasonId: feeReasonId,
      });
      const audits = await prisma.auditLog.findMany({
        where: { entityType: "LedgerEntry", entityId: res.feeId },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.action).toBe("CREATE");
  
    }));

  it("leaves nothing behind when the caller's transaction rolls back", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority. The
       * scoped service wrappers below re-enter their own tenant scope,
       * so the calls under test still run as `cis_app`. */
      const { prisma } = prismaImports;
      await expect(
        prisma.$transaction(async (tx) => {
          await assessFee(
            utilityId,
            ACTOR,
            "T",
            accountId,
            { amount: "25.00", reasonId: feeReasonId },
            tx,
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await prisma.ledgerEntry.count({ where: { accountId } })).toBe(0);
      const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      expect(account.balance.toFixed(2)).toBe("0.00");
  
    }));
});
