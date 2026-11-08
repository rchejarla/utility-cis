import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runAsTenant } from "../../lib/tenant-context.js";
import { bootPostgres, ensurePrincipal, seedAsPlatform, endAdminPool } from "./_effective-dating-fixtures.js";

/**
 * The final bill, at account closure (Req 134).
 *
 * **Nothing produced one.** Move-out stopped the service, end-dated the
 * agreement and set the account `CLOSED` — and the days between the
 * last regular bill and the final read were billed by nothing. A cycle
 * run could not pick them up either: `BILLABLE_ACCOUNT_STATUSES` is
 * `["ACTIVE"]`, so a closed account is never in a run again. Money for
 * service that was taken, walking out the door at every move-out.
 *
 * **Not the run's job**, which is the shape the billing-run design
 * settled on 2026-10-14 and Req 134 states outright — "final bill
 * generation at account closure *independent of billing cycle*". A
 * different trigger, a part-period, and a different eligibility rule.
 * So this reuses the two services a run uses and is not a run.
 *
 * Runs against the real seed rather than the shared fixture, for the
 * reason `billing-run.integration.test.ts` gives: rating needs
 * published schedules and assignments, and the seed has them.
 */

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/*
 * A posted bill renders a PDF, which ends in a call to apptor-connect's
 * files plane. Stubbed because it is this file's side effect, never its
 * subject — the plane has its own contract test and
 * `bill-document.integration.test.ts` owns generation.
 */
const put = vi.fn(async () => undefined);
vi.mock("../../lib/apptor-connect/files-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/apptor-connect/files-client.js")>()),
  putObject: (...args: unknown[]) => put(...(args as [])),
}));

const BILL_PRODUCTION_SETTINGS = {
  billDocuments: { storageIntegration: "cis-bills" },
  issuer: {
    utilityName: "City of Testville Utilities",
    utilityLegalName: "City of Testville, Montana",
    remittanceAddressLine1: "PO Box 1230",
    remittanceCity: "Testville",
    remittanceState: "MT",
    remittancePostalCode: "59771",
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let workflows: typeof import("../../services/workflows.service.js");
let utilityId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

const moveOut = (...args: Parameters<typeof workflows.moveOut>) =>
  runAsTenant(args[0], async () => workflows.moveOut(...args));

beforeAll(() =>
  seedAsPlatform(async () => {
    const booted = await bootPostgres();
    pgContainer = booted.container;

    const TSX_BIN =
      process.platform === "win32"
        ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
        : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
    execSync(`"${TSX_BIN}" prisma/seed.ts`, {
      cwd: SHARED_DIR,
      env: { ...process.env, DATABASE_URL: booted.dbUrl },
      stdio: "pipe",
    });

    prismaImports = await import("../../lib/prisma.js");
    workflows = await import("../../services/workflows.service.js");

    const { prisma } = prismaImports;
    const cycle = await prisma.billingCycle.findFirstOrThrow({ where: { cycleCode: "R01" } });
    utilityId = cycle.utilityId;
    await ensurePrincipal(prisma, utilityId);

    /*
     * Backdate the accounts, or nothing here can be billed.
     *
     * The seed creates them today and `computeBillPeriod` clamps a
     * window's start to `account.createdAt`, so an account created on
     * the 8th asked for a period ending in September got the window
     * `2026-11-08 – 2026-09-10` — start after end, no charges found,
     * and a final bill that reported "nothing to bill" for an account
     * with a month of unbilled service. Defensible behaviour (an
     * account cannot be billed for a period predating it) and the same
     * trap `billing-run.integration.test.ts` writes down.
     */
    await prisma.$executeRawUnsafe(
      "UPDATE account SET created_at = $1::timestamptz WHERE utility_id = $2::uuid",
      new Date("2025-01-01T00:00:00Z").toISOString(),
      utilityId,
    );

    // Somewhere for a posted bill's PDF to go, and somebody to address
    // it to — the same two tenant-level prerequisites the billing-run
    // suite sets up, for the same reason.
    await prisma.utilityConfig.upsert({
      where: { utilityId },
      update: { settings: BILL_PRODUCTION_SETTINGS },
      create: { utilityId, settings: BILL_PRODUCTION_SETTINGS },
    });
    const accounts = await prisma.account.findMany({
      where: { utilityId },
      select: { id: true, customerId: true },
    });
    for (const account of accounts) {
      if (!account.customerId) {
        const customer = await prisma.customer.create({
          data: { utilityId, customerType: "INDIVIDUAL", firstName: "Ada", lastName: "Lovelace" },
        });
        await prisma.account.update({ where: { id: account.id }, data: { customerId: customer.id } });
      }
      await prisma.billingAddress.create({
        data: {
          utilityId,
          accountId: account.id,
          addressLine1: "1 Test Way",
          city: "Testville",
          state: "MT",
          zip: "59771",
        },
      });
    }
  }), 300_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

/**
 * One closable service, with an unbilled read and its own account.
 *
 * Picked from the seed rather than built: a final bill has to *rate*,
 * and a hand-made tariff that does not is a test of nothing. The
 * account must hold exactly this one agreement, since move-out refuses
 * to close an account that has others.
 */
async function closableService(): Promise<{
  accountId: string;
  premiseId: string;
  saId: string;
  readDate: Date;
}> {
  const { prisma } = prismaImports;
  const candidates = await prisma.serviceAgreement.findMany({
    where: {
      utilityId,
      status: "ACTIVE",
      endDate: null,
      account: { status: "ACTIVE" },
      meterReads: { some: { billedAt: null } },
      servicePoints: { some: { endDate: null } },
    },
    select: {
      id: true,
      accountId: true,
      account: { select: { _count: { select: { serviceAgreements: true } } } },
      servicePoints: {
        where: { endDate: null },
        take: 1,
        select: { premiseId: true },
      },
      meterReads: {
        where: { billedAt: null },
        orderBy: [{ readDate: "desc" }],
        take: 1,
        select: { readDate: true },
      },
    },
  });
  const sa = candidates.find(
    (c) => c.account._count.serviceAgreements === 1 && c.servicePoints.length > 0,
  );
  if (!sa) throw new Error("Seed has no single-agreement active account with an unbilled read");
  return {
    accountId: sa.accountId,
    premiseId: sa.servicePoints[0]!.premiseId,
    saId: sa.id,
    readDate: sa.meterReads[0]!.readDate,
  };
}

/** The move-out payload, dated on the final read so the period closes there. */
function moveOutInput(
  over: { accountId: string; premiseId: string; moveOutDate: string } & Record<string, unknown>,
) {
  return {
    finalMeterReadings: [],
    closeAccount: true,
    refundDeposit: false,
    ...over,
  } as Parameters<typeof workflows.moveOut>[3];
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await prisma.$executeRawUnsafe("DELETE FROM ledger_application");
    await prisma.$executeRawUnsafe("DELETE FROM ledger_entry");
    await prisma.$executeRawUnsafe("DELETE FROM bill_document");
    await prisma.$executeRawUnsafe("DELETE FROM bill_segment_line");
    await prisma.$executeRawUnsafe("DELETE FROM bill_segment");
    await prisma.$executeRawUnsafe("DELETE FROM bill");
    await prisma.$executeRawUnsafe("UPDATE meter_read SET billed_at = NULL");
    await prisma.$executeRawUnsafe("UPDATE account SET balance = 0");

    /*
     * Re-open what the last test closed.
     *
     * Each case here closes a service, and the seed holds few accounts
     * with exactly one agreement — so without this the second test
     * finds no candidate and the third reports a missing fixture
     * instead of a result. Everything the move-out cascade touches, in
     * reverse order.
     */
    await prisma.$executeRawUnsafe("UPDATE service_point_meter SET removed_date = NULL");
    await prisma.$executeRawUnsafe(
      "UPDATE service_point SET status = 'ACTIVE', end_date = NULL WHERE end_date IS NOT NULL",
    );
    await prisma.$executeRawUnsafe(
      "UPDATE service_agreement SET status = 'ACTIVE', end_date = NULL WHERE status IN ('FINAL','CLOSED')",
    );
    await prisma.$executeRawUnsafe(
      "UPDATE account SET status = 'ACTIVE', closed_at = NULL WHERE status IN ('FINAL','CLOSED')",
    );
  }),
);

describe("closing an account", () => {
  it("bills the days since the last bill, up to the final read", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const svc = await closableService();

      const res = await moveOut(
        utilityId,
        ACTOR_ID,
        "Tester",
        moveOutInput({ ...svc, moveOutDate: isoDay(svc.readDate) }),
      );

      // The bill, reported back rather than left for somebody to find:
      // an operator closing an account is owed the number. `error`
      // first, so a failure says why instead of only "null".
      expect(res.finalBill).toMatchObject({ error: null });
      expect(res.finalBill?.billId).toBeTruthy();
      expect(Number(res.finalBill?.total)).toBeGreaterThan(0);

      const bill = await prisma.bill.findFirstOrThrow({
        where: { utilityId, accountId: svc.accountId },
      });
      // Ends at the final read, which is the day service stopped.
      expect(isoDay(bill.periodEnd)).toBe(isoDay(svc.readDate));

      // The lifecycle completes: the bill is out, so the account closes.
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: svc.accountId } });
      expect(acct.status).toBe("CLOSED");
    }), 120_000);

  /*
   * An account with nothing left to bill still closes. `FINAL` means
   * "final bill being prepared" (spec 04), so parking an account there
   * when there is no bill to prepare would leave an operator a chore
   * with nothing to do.
   */
  it("closes without a bill when there is nothing left to bill", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const svc = await closableService();
      // Every read already billed: no period to resolve.
      await prisma.$executeRawUnsafe(
        "UPDATE meter_read SET billed_at = now() WHERE service_agreement_id = $1::uuid",
        svc.saId,
      );

      const res = await moveOut(
        utilityId,
        ACTOR_ID,
        "Tester",
        moveOutInput({ ...svc, moveOutDate: isoDay(svc.readDate) }),
      );

      expect(res.finalBill).toEqual({ billId: null, total: null, error: null });
      expect(await prisma.bill.count({ where: { utilityId, accountId: svc.accountId } })).toBe(0);
      const acct = await prisma.account.findUniqueOrThrow({ where: { id: svc.accountId } });
      expect(acct.status).toBe("CLOSED");
    }), 120_000);

  /*
   * A rating fault must not roll back the move-out. The service really
   * has stopped — that is a physical fact somebody has already acted on
   * — and a move-out that failed because a tariff was left unpublished
   * would send the operator back to re-enter it.
   *
   * So the service closes, the account waits at `FINAL`, and the reason
   * is reported. This is the one case where `FINAL` means what spec 04
   * says it means.
   */
  it("stops the service and holds the account at FINAL when the bill cannot be produced", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const svc = await closableService();
      const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
        where: { utilityId, serviceAgreementId: svc.saId },
      });
      const schedule = await prisma.rateSchedule.findUniqueOrThrow({
        where: { id: assignment.rateScheduleId },
        select: { id: true, publishedAt: true },
      });
      await prisma.rateSchedule.update({
        where: { id: schedule.id },
        data: { publishedAt: null },
      });

      try {
        const res = await moveOut(
          utilityId,
          ACTOR_ID,
          "Tester",
          moveOutInput({ ...svc, moveOutDate: isoDay(svc.readDate) }),
        );

        expect(res.finalBill?.billId).toBeNull();
        expect(res.finalBill?.error).toMatch(/unpublished rate schedule/i);

        // The service is stopped regardless.
        const sa = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: svc.saId } });
        expect(sa.status).toBe("FINAL");
        expect(sa.endDate).not.toBeNull();

        const acct = await prisma.account.findUniqueOrThrow({ where: { id: svc.accountId } });
        expect(acct.status).toBe("FINAL");
      } finally {
        // `beforeEach` re-opens the service; the schedule is this test's
        // own doing and nothing else would put it back.
        await prisma.rateSchedule.update({
          where: { id: schedule.id },
          data: { publishedAt: schedule.publishedAt },
        });
      }
    }), 120_000);
});
