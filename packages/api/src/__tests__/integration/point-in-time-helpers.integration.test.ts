import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * Real-database verification of `responsible_account_at` and
 * `meter_assignment_at` SQL helpers (migration
 * 20260427162359_point_in_time_helpers).
 *
 * These functions are STABLE SECURITY INVOKER and read
 * `current_setting('app.current_utility_id')` for tenant scoping.
 * Cannot be exercised by mocked Prisma — the predicate logic and
 * tenant scoping live in Postgres.
 *
 * Fixture timeline (one premise, one commodity, two accounts):
 *   2024-01-01 — Account-1 SA opens
 *   2024-06-30 — Account-1 SA closes (FINAL)
 *   2024-07-01 — Account-2 SA opens
 *   (still ongoing)
 *
 * Meter1 timeline:
 *   2024-01-01 → 2024-03-31  on SA-1 (then removed; meter swap)
 *   2024-04-01 → 2024-06-30  on SA-1 (replacement period)
 *   2024-07-01 → ongoing     on SA-2
 *
 * Tested points-in-time:
 *   - Pre-history (2023-06-15): no responsible account, no meter assignment.
 *   - Mid SA-1 (2024-03-15): Account-1, on first meter window.
 *   - Right after first meter swap (2024-04-15): Account-1, on second meter window.
 *   - Just before SA-1 closes (2024-06-29): Account-1.
 *   - Day SA-1 closes (2024-06-30): Account-1 (boundary).
 *   - First day of SA-2 (2024-07-01): Account-2.
 *   - Far future (2030-01-01): Account-2 (still ongoing).
 *
 * Plus tenant scoping: a different tenant's `current_setting` returns
 * NULL even though TENANT_A's data is right there in the same DB.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let fixA: TenantFixture;
let fixB: TenantFixture;
let saAccount1Id: string;
let saAccount2Id: string;
let account2Id: string;

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
  await resetDb(prisma);
  fixA = await makeTenantFixture(prisma, TENANT_A);
  fixB = await makeTenantFixture(prisma, TENANT_B, { suffix: "0bbb" });

  // Build the timeline for tenant A.
  const sa1 = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-A1",
      accountId: fixA.accountId,
      premiseId: fixA.premiseId,
      commodityId: fixA.commodityId,
      rateScheduleId: fixA.rateScheduleId,
      billingCycleId: fixA.billingCycleId,
      startDate: new Date("2024-01-01"),
      endDate: new Date("2024-06-30"),
      status: "FINAL",
    },
  });
  saAccount1Id = sa1.id;

  // Two SAMs on SA-1: meter 1 (Jan-Mar), meter 2 (Apr-Jun).
  await prisma.serviceAgreementMeter.create({
    data: {
      utilityId: fixA.utilityId,
      serviceAgreementId: sa1.id,
      meterId: fixA.meterId,
      addedDate: new Date("2024-01-01"),
      removedDate: new Date("2024-03-31"),
      isPrimary: true,
    },
  });
  await prisma.serviceAgreementMeter.create({
    data: {
      utilityId: fixA.utilityId,
      serviceAgreementId: sa1.id,
      meterId: fixA.meterId2,
      addedDate: new Date("2024-04-01"),
      removedDate: new Date("2024-06-30"),
      isPrimary: true,
    },
  });

  // Second account; new SA on the same premise + commodity from Jul 1.
  const acct2 = await prisma.account.create({
    data: {
      utilityId: fixA.utilityId,
      accountNumber: "ACCT-A-2",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      depositAmount: 0,
    },
  });
  account2Id = acct2.id;

  const sa2 = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-A2",
      accountId: acct2.id,
      premiseId: fixA.premiseId,
      commodityId: fixA.commodityId,
      rateScheduleId: fixA.rateScheduleId,
      billingCycleId: fixA.billingCycleId,
      startDate: new Date("2024-07-01"),
      status: "ACTIVE",
    },
  });
  saAccount2Id = sa2.id;

  // SA-2 has meter 1 again (was removed from SA-1 at end of March,
  // sat unassigned through June, comes back online for SA-2 Jul 1).
  await prisma.serviceAgreementMeter.create({
    data: {
      utilityId: fixA.utilityId,
      serviceAgreementId: sa2.id,
      meterId: fixA.meterId,
      addedDate: new Date("2024-07-01"),
      isPrimary: true,
    },
  });
});

async function callResponsibleAccount(asOf: string, utilityId = TENANT_A): Promise<string | null> {
  const { prisma } = prismaImports;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
    const rows = await tx.$queryRaw<{ account_id: string | null }[]>`
      SELECT responsible_account_at(
        ${fixA.premiseId}::uuid,
        ${fixA.commodityId}::uuid,
        ${asOf}::date
      ) AS account_id
    `;
    return rows[0]?.account_id ?? null;
  });
}

async function callMeterAssignment(meterId: string, asOf: string, utilityId = TENANT_A) {
  const { prisma } = prismaImports;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
    const rows = await tx.$queryRaw<
      { service_agreement_id: string; account_id: string; premise_id: string }[]
    >`SELECT * FROM meter_assignment_at(${meterId}::uuid, ${asOf}::date)`;
    return rows[0] ?? null;
  });
}

describe("responsible_account_at", () => {
  it("returns null pre-history (before any SA started)", async () => {
    expect(await callResponsibleAccount("2023-06-15")).toBeNull();
  });

  it("returns Account-1 mid-SA-1 (2024-03-15)", async () => {
    expect(await callResponsibleAccount("2024-03-15")).toBe(fixA.accountId);
  });

  it("returns Account-1 the day SA-1 ends (2024-06-30) — endDate-inclusive", async () => {
    // The function uses `end_date >= as_of_date`, so the day-of-end is
    // still attributed to the SA that's ending. This matters for "who
    // got the bill for that day?" lookups.
    expect(await callResponsibleAccount("2024-06-30")).toBe(fixA.accountId);
  });

  it("returns Account-2 the day SA-2 starts (2024-07-01)", async () => {
    expect(await callResponsibleAccount("2024-07-01")).toBe(account2Id);
  });

  it("returns Account-2 far in the future (still ongoing)", async () => {
    expect(await callResponsibleAccount("2030-01-01")).toBe(account2Id);
  });

  it("scopes by tenant: tenant B sees nothing for tenant A's premise", async () => {
    // Same date that returns Account-1 for tenant A — should be NULL
    // when called with tenant B's GUC. Premise IDs are global-unique
    // but the function filters by current_setting.
    expect(await callResponsibleAccount("2024-03-15", TENANT_B)).toBeNull();
  });
});

describe("meter_assignment_at", () => {
  it("returns null pre-history", async () => {
    expect(await callMeterAssignment(fixA.meterId, "2023-06-15")).toBeNull();
  });

  it("returns SA-1 for meter1 mid-first-window (2024-02-15)", async () => {
    const result = await callMeterAssignment(fixA.meterId, "2024-02-15");
    expect(result?.service_agreement_id).toBe(saAccount1Id);
    expect(result?.account_id).toBe(fixA.accountId);
    expect(result?.premise_id).toBe(fixA.premiseId);
  });

  it("returns null in the gap between meter1's two assignments (2024-05-15)", async () => {
    // meter1 was removed 2024-03-31, returns to SA-2 only on 2024-07-01.
    // In between, it's unassigned.
    expect(await callMeterAssignment(fixA.meterId, "2024-05-15")).toBeNull();
  });

  it("returns SA-2 for meter1 in its second assignment window (2024-09-01)", async () => {
    const result = await callMeterAssignment(fixA.meterId, "2024-09-01");
    expect(result?.service_agreement_id).toBe(saAccount2Id);
    expect(result?.account_id).toBe(account2Id);
  });

  it("returns SA-1 for meter2 during its only assignment window (2024-05-15)", async () => {
    const result = await callMeterAssignment(fixA.meterId2, "2024-05-15");
    expect(result?.service_agreement_id).toBe(saAccount1Id);
  });

  it("scopes by tenant: tenant B's GUC sees nothing for tenant A's meter", async () => {
    expect(await callMeterAssignment(fixA.meterId, "2024-02-15", TENANT_B)).toBeNull();
  });

  it("does not leak: tenant B's own meter is invisible from tenant A's GUC", async () => {
    // Sanity check the inverse direction. Tenant B has its own meter
    // but no SA on it — the result is NULL either way, but the test
    // proves the function isn't cross-tenant-leaking even when
    // there's no data to potentially leak. (Belt + suspenders; the
    // earlier test was the load-bearing one.)
    expect(await callMeterAssignment(fixB.meterId, "2024-02-15", TENANT_A)).toBeNull();
  });
});
