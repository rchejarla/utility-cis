import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  ensurePrincipal,
  seedAsPlatform,
  endAdminPool,
  ACTOR,
  TENANT_A,
  TENANT_B,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Deleting a meter read — the one production path that removes one.
 *
 * Meter reads are what the bill is computed from, so a hard delete here
 * is the most consequential destructive operation in the product, and it
 * had no test at all. These cases are about the guards holding and the
 * deletion being *visible* afterwards.
 *
 * The audit case is the reason this file exists. `audit-wrap` derives the
 * `action` column from the event type's suffix — `.created` is CREATE,
 * `.deleted` is DELETE, anything else is UPDATE — and this service
 * passed `meter_read.updated` for a delete, so removing a read was
 * recorded as having been edited. Anyone auditing deletions of billing
 * source data by filtering on the action would not have found them.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let svc: typeof import("../../services/meter-read.service.js");
let fix: TenantFixture;
let saId: string;

const deleteMeterRead = (...args: Parameters<typeof svc.deleteMeterRead>) =>
  runAsTenant(args[0], async () => svc.deleteMeterRead(...args));

/** A read on the fixture's meter, unbilled unless told otherwise. */
async function makeRead(
  opts: { frozen?: boolean; corrects?: string; tenant?: string } = {},
) {
  return seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    return prisma.meterRead.create({
      data: {
        utilityId: opts.tenant ?? fix.utilityId,
        meterId: fix.meterId,
        serviceAgreementId: saId,
        uomId: fix.uomId,
        readDate: new Date("2026-06-30"),
        readDatetime: new Date("2026-06-30T12:00:00Z"),
        reading: "1200.0000",
        priorReading: "1000.0000",
        consumption: "200.0000",
        readType: opts.corrects ? "CORRECTED" : "ACTUAL",
        readSource: "MANUAL",
        isFrozen: opts.frozen ?? false,
        correctsReadId: opts.corrects,
      },
    });
  });
}

async function auditRowsFor(entityId: string) {
  return seedAsPlatform(async () =>
    prismaImports.prisma.auditLog.findMany({
      where: { entityType: "MeterRead", entityId },
      select: { action: true, afterState: true },
    }),
  );
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/meter-read.service.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  await resetDb();
  fix = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  await ensurePrincipal(prismaImports.prisma, TENANT_A);
  saId = await seedAsPlatform(async () => {
    const sa = await prismaImports.prisma.serviceAgreement.create({
      data: {
        utilityId: fix.utilityId,
        agreementNumber: "SA-MRD-1",
        accountId: fix.accountId,
        commodityId: fix.commodityId,
        startDate: new Date("2026-01-01"),
      },
    });
    return sa.id;
  });
});

describe("deleting a meter read", () => {
  it("removes an unbilled read", async () => {
    const read = await makeRead();
    await deleteMeterRead(fix.utilityId, ACTOR, "Tester", read.id);

    const remaining = await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.findMany({ where: { id: read.id } }),
    );
    expect(remaining).toEqual([]);
  });

  /*
   * The point of the file. A delete has to read back as a delete, or an
   * audit of who removed billing source data finds nothing.
   */
  it("records the removal as a DELETE, not an edit", async () => {
    const read = await makeRead();
    await deleteMeterRead(fix.utilityId, ACTOR, "Tester", read.id);

    const rows = await auditRowsFor(read.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("DELETE");
    // `afterState` is null because there is no after — which is the only
    // thing that distinguished a delete from an edit before this.
    expect(rows[0].afterState).toBeNull();
  });

  it("refuses a frozen read, naming the workflow that replaces it", async () => {
    const read = await makeRead({ frozen: true });
    await expect(
      deleteMeterRead(fix.utilityId, ACTOR, "Tester", read.id),
    ).rejects.toMatchObject({ code: "READ_FROZEN" });

    const survived = await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.findMany({ where: { id: read.id } }),
    );
    expect(survived).toHaveLength(1);
  });

  it("refuses a read a later correction supersedes", async () => {
    const original = await makeRead();
    await makeRead({ corrects: original.id });

    await expect(
      deleteMeterRead(fix.utilityId, ACTOR, "Tester", original.id),
    ).rejects.toMatchObject({ code: "READ_HAS_CORRECTION" });
  });

  /*
   * Whose read it is, asked of the service rather than of the policy:
   * a 404 rather than a 403, because whether another tenant's read
   * exists is not the caller's to learn.
   */
  it("does not reach another tenant's read", async () => {
    const read = await makeRead();
    await expect(
      deleteMeterRead(TENANT_B, ACTOR, "Tester", read.id),
    ).rejects.toMatchObject({ statusCode: 404 });

    const survived = await seedAsPlatform(async () =>
      prismaImports.prisma.meterRead.findMany({ where: { id: read.id } }),
    );
    expect(survived).toHaveLength(1);
  });

  it("writes nothing to the audit log when a refusal stops it", async () => {
    const read = await makeRead({ frozen: true });
    await deleteMeterRead(fix.utilityId, ACTOR, "Tester", read.id).catch(() => {});
    expect(await auditRowsFor(read.id)).toEqual([]);
  });
});
