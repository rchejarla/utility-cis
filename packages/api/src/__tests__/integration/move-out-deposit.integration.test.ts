import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, makeTenantFixture, type TenantFixture, seedAsPlatform, endAdminPool } from "./_effective-dating-fixtures.js";

import { runAsTenant } from "../../lib/tenant-context.js";
import type { Prisma } from "@utility-cis/shared/src/generated/prisma";
/**
 * Move-out, and the deposit it used to strand.
 *
 * `refundDeposit` has been on the move-out payload and on the move-out
 * form since the workflow shipped, and nothing read it: an operator
 * ticked the box, the account closed, and the deposit stayed on the
 * ledger with no next bill to absorb it and no path to pay it out. This
 * is the test that the box now moves money.
 *
 * Why here rather than only in refund.integration.test.ts: the refund
 * service is covered there in isolation. What has to hold at this level
 * is that the deposit return happens inside the move-out's OWN
 * transaction — so a move-out that fails cannot leave a cheque recorded
 * against an account that was never closed — and that what the account
 * still owes is reported rather than silently left behind.
 */

const ACTOR = "00000000-0000-4000-8000-aaaa00000001";
const utilityId = "00000000-0000-4000-8000-0000000000aa";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let workflows: typeof import("../../services/workflows.service.js");
let deposit: typeof import("../../services/ar/deposit.service.js");
let posting: typeof import("../../services/ar/posting.service.js");
let fx: TenantFixture;
let debitReasonId: string;

/**
 * The services this file calls directly, as a route reaches them: acting
 * for the tenant, not merely naming it.
 *
 * Each already receives the tenant — production passed it from a request
 * or a job whose scope had been entered, so the argument and the scope
 * are always the same id. A direct service test has the argument and not
 * the scope, and under `cis_app` a tenant table read with no scope raises
 * rather than returning the wrong rows.
 *
 * `runAsTenant` also overrides a surrounding `seedAsPlatform`, which is
 * what lets fixture rows be arranged across tenants while the call under
 * test stays confined to one.
 */
const recordDeposit = (...args: Parameters<typeof deposit.recordDeposit>) =>
  runAsTenant(args[0], async () => deposit.recordDeposit(...args));

const moveOut = (...args: Parameters<typeof workflows.moveOut>) =>
  runAsTenant(args[0], async () => workflows.moveOut(...args));

/**
 * A transaction entered the way a route enters one: inside the tenant's
 * scope.
 *
 * A service taking `(tx, utilityId, …)` cannot receive the scope as an
 * argument, so it has to be around the call — which is the order a
 * request does it in.
 */
const asTenantTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  runAsTenant(utilityId, async () => prismaImports.prisma.$transaction(fn));

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  workflows = await import("../../services/workflows.service.js");
  deposit = await import("../../services/ar/deposit.service.js");
  posting = await import("../../services/ar/posting.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  // `$disconnect` does not dispose a pool the application owns —
  // that is the driver-adapter contract — so the tenant and
  // platform pools are ended here. Without it the container stops
  // while connections are live and Postgres reports 57P01.
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop();
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  const { resetDb } = await import("./_effective-dating-fixtures.js");
  await resetDb();
  fx = await makeTenantFixture(prisma, utilityId);

  // Upserted, not created: `resetDb` truncates `account` with CASCADE,
  // which takes `ledger_entry` with it, but `ledger_reason_def` hangs off
  // `utility_id` alone and survives — so a second `create` collides on
  // (utility_id, code).
  const reason = await prisma.ledgerReasonDef.upsert({
    where: { utilityId_code: { utilityId, code: "MISC_DEBIT" } },
    update: {},
    create: { utilityId, code: "MISC_DEBIT", label: "Misc charge", appliesToType: "ADJUSTMENT_DEBIT" },
  });
  debitReasonId = reason.id;

  // One active agreement with a service point at the premise, which is
  // what moveOut requires to have anything to close.
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      agreementNumber: "SA-MO-1",
      accountId: fx.accountId,
      commodityId: fx.commodityId,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  await prisma.servicePoint.create({
    data: {
      utilityId,
      serviceAgreementId: sa.id,
      premiseId: fx.premiseId,
      startDate: new Date("2026-01-01"),
    },
  });
}),
);

async function owe(amount: string): Promise<void> {

  /*

   * Arranging rows, so the authority the fixtures use. Calls under

   * test re-enter their own tenant scope.

   */

  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.ledgerEntry.create({
      data: {
        utilityId,
        accountId: fx.accountId,
        type: "ADJUSTMENT_DEBIT",
        amount,
        openAmount: amount,
        dueDate: new Date("2026-06-14"),
        effectiveDate: new Date("2026-06-14"),
        reasonId: debitReasonId,
        createdBy: ACTOR,
      },
    });
    await asTenantTx((tx) => posting.recomputeAccountCache(tx, utilityId, fx.accountId));


  });

}

function moveOutInput(over: Record<string, unknown> = {}) {
  return {
    accountId: fx.accountId,
    premiseId: fx.premiseId,
    moveOutDate: "2026-06-30",
    finalMeterReadings: [],
    closeAccount: true,
    refundDeposit: false,
    ...over,
  } as Parameters<typeof workflows.moveOut>[3];
}

describe("moveOut — returning the deposit", () => {
  it("returns the deposit when asked, and records how it left", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await recordDeposit(utilityId, ACTOR, "T", fx.accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      const res = await moveOut(
        utilityId,
        ACTOR,
        "T",
        moveOutInput({ refundDeposit: true, depositTender: "CHECK" }),
      );

      expect(res.depositReturn).toMatchObject({ refunded: "500.00", stillOwed: "0.00" });
      const refund = await prisma.ledgerEntry.findFirstOrThrow({
        where: { utilityId, type: "REFUND" },
      });
      // A debit, positive, discharging the deposit credit it paid out.
      expect(refund.amount.toFixed(2)).toBe("500.00");
      expect(refund.openAmount.toFixed(2)).toBe("0.00");
      expect(refund.tender).toBe("CHECK");
      // Dated the day the customer moved out, not the day the row was written.
      expect(refund.effectiveDate.toISOString().slice(0, 10)).toBe("2026-06-30");

      const acct = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.depositAmount.toFixed(2)).toBe("0.00");
      expect(acct.status).toBe("CLOSED");
  
    }));

  it("leaves the deposit alone when not asked", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await recordDeposit(utilityId, ACTOR, "T", fx.accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      const res = await moveOut(utilityId, ACTOR, "T", moveOutInput());

      expect(res.depositReturn).toBeNull();
      expect(await prisma.ledgerEntry.count({ where: { utilityId, type: "REFUND" } })).toBe(0);
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      // Closed, holding $500 with no path to pay it out — which is exactly
      // the state this feature exists to stop being the only option.
      expect(acct.status).toBe("CLOSED");
      expect(acct.depositAmount.toFixed(2)).toBe("500.00");
  
    }));

  /**
   * Asked for, nothing held. Reported as a zero rather than passed over
   * in silence: an operator who ticked the box is expecting a cheque,
   * and "Move-out complete" would let them keep expecting it.
   */
  it("says nothing was returned when no deposit was held", async () => {
    const res = await moveOut(
      utilityId,
      ACTOR,
      "T",
      moveOutInput({ refundDeposit: true }),
    );
    expect(res.depositReturn).toMatchObject({ refunded: "0.00", entryId: null });
  });

  /**
   * The deposit is returned in full and the arrears are reported, not
   * netted. Applying a deposit against a final bill is a policy decision
   * nobody has made here, and the deposit pool is excluded from
   * allocation precisely so it cannot happen by accident.
   */
  it("returns the full deposit and reports what the account still owes", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await owe("169.25");
      await recordDeposit(utilityId, ACTOR, "T", fx.accountId, {
        amount: "500.00",
        tender: "CHECK",
      });

      const res = await moveOut(
        utilityId,
        ACTOR,
        "T",
        moveOutInput({ closeAccount: true, refundDeposit: true, depositTender: "CHECK" }),
      );

      expect(res.depositReturn).toMatchObject({ refunded: "500.00", stillOwed: "169.25" });
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      // The debt survives the deposit being handed back.
      expect(acct.balance.toFixed(2)).toBe("169.25");
      expect(acct.depositAmount.toFixed(2)).toBe("0.00");
  
    }));

  /**
   * One transaction. A move-out that cannot complete must not leave a
   * refund recorded — the cheque would be in the ledger against an
   * account that was never closed.
   */
  it("records no refund when the move-out itself fails", () =>
    seedAsPlatform(async () => {      /* Fixture rows and read-backs under the fixture authority; the
       * scoped wrappers re-enter their own tenant scope. */
      const { prisma } = prismaImports;
      await recordDeposit(utilityId, ACTOR, "T", fx.accountId, {
        amount: "500.00",
        tender: "CHECK",
      });
      // A second active agreement elsewhere makes closeAccount throw
      // ACCOUNT_HAS_OTHER_AGREEMENTS, after the deposit return would
      // already have run.
      const other = await prisma.serviceAgreement.create({
        data: {
          utilityId,
          agreementNumber: "SA-MO-2",
          accountId: fx.accountId,
          commodityId: fx.commodityId,
          startDate: new Date("2026-02-01"),
          status: "ACTIVE",
        },
      });
      const otherPremise = await prisma.premise.create({
        data: {
          utilityId,
          addressLine1: "2 Other St",
          city: "Bozeman",
          state: "MT",
          zip: "59715",
          premiseType: "RESIDENTIAL",
        },
      });
      await prisma.servicePoint.create({
        data: {
          utilityId,
          serviceAgreementId: other.id,
          premiseId: otherPremise.id,
          startDate: new Date("2026-02-01"),
        },
      });

      await expect(
        moveOut(
          utilityId,
          ACTOR,
          "T",
          moveOutInput({ closeAccount: true, refundDeposit: true, depositTender: "CHECK" }),
        ),
      ).rejects.toMatchObject({ code: "ACCOUNT_HAS_OTHER_AGREEMENTS" });

      // Nothing paid out, nothing closed.
      expect(await prisma.ledgerEntry.count({ where: { utilityId, type: "REFUND" } })).toBe(0);
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } });
      expect(acct.status).toBe("ACTIVE");
      expect(acct.depositAmount.toFixed(2)).toBe("500.00");
  
    }));
});
