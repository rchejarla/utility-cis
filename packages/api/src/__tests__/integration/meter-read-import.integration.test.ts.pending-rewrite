import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * End-to-end test of the bulk meter-read import service. The import
 * endpoint is a long-tail of small concerns — meter resolution by
 * number, partial-success accounting, ImportBatch lifecycle, audit
 * emission, batch-source → read-source mapping, and the chronological
 * ordering invariant for `computeConsumption`. Mocks can't validate
 * any of those properly; they need a real Postgres.
 *
 * Each scenario starts from a fresh DB + tenant fixture + an SA with
 * the meter assigned, then runs `importMeterReads` and asserts the
 * resulting rows + ImportBatch + audit_log state.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/meter-read.service.js");
let fixA: TenantFixture;
let saId: string;
let meterNumber: string;
let meter2Number: string;

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/meter-read.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb(prisma);
  fixA = await makeTenantFixture(prisma, TENANT_A);

  // Active SA with both meters assigned, so reads have a valid
  // owning agreement.
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-IMPORT",
      accountId: fixA.accountId,
      premiseId: fixA.premiseId,
      commodityId: fixA.commodityId,
      rateScheduleId: fixA.rateScheduleId,
      billingCycleId: fixA.billingCycleId,
      startDate: new Date("2024-01-01"),
      status: "ACTIVE",
    },
  });
  saId = sa.id;

  await prisma.serviceAgreementMeter.createMany({
    data: [
      {
        utilityId: fixA.utilityId,
        serviceAgreementId: sa.id,
        meterId: fixA.meterId,
        addedDate: new Date("2024-01-01"),
        isPrimary: true,
      },
      {
        utilityId: fixA.utilityId,
        serviceAgreementId: sa.id,
        meterId: fixA.meterId2,
        addedDate: new Date("2024-01-01"),
        isPrimary: false,
      },
    ],
  });

  // Look up the meter numbers the fixture generated.
  const meters = await prisma.meter.findMany({
    where: { utilityId: fixA.utilityId },
    select: { id: true, meterNumber: true },
  });
  meterNumber = meters.find((m) => m.id === fixA.meterId)!.meterNumber;
  meter2Number = meters.find((m) => m.id === fixA.meterId2)!.meterNumber;
});

describe("importMeterReads (real DB)", () => {
  it("imports a clean batch of 3 rows: ImportBatch COMPLETE, 3 reads inserted, audit rows emitted", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    const result = await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "MANUAL_UPLOAD",
      fileName: "test.csv",
      reads: [
        { meterNumber, readDatetime: "2024-02-01T09:00:00Z", reading: 100 },
        { meterNumber, readDatetime: "2024-03-01T09:00:00Z", reading: 250 },
        { meterNumber: meter2Number, readDatetime: "2024-02-15T09:00:00Z", reading: 50 },
      ],
    });

    expect(result.imported).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(result.exceptions).toBe(0);

    const reads = await prisma.meterRead.findMany({
      where: { utilityId: fixA.utilityId, importBatchId: result.batchId },
      orderBy: [{ meterId: "asc" }, { readDatetime: "asc" }],
    });
    expect(reads).toHaveLength(3);
    expect(reads.every((r) => r.serviceAgreementId === saId)).toBe(true);
    expect(reads.every((r) => r.readSource === "MANUAL")).toBe(true); // mapped from MANUAL_UPLOAD

    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: result.batchId },
    });
    expect(batch.status).toBe("COMPLETE");
    expect(batch.recordCount).toBe(3);
    expect(batch.importedCount).toBe(3);
    expect(batch.errorCount).toBe(0);
    expect(batch.completedAt).not.toBeNull();

    const audits = await prisma.auditLog.count({
      where: { utilityId: fixA.utilityId, entityType: "MeterRead" },
    });
    expect(audits).toBe(3);
  });

  it("computes priorReading + consumption correctly across multiple reads on the same meter (chronological invariant)", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    // Submit out of order — service must sort by (meter, datetime ASC)
    // before processing so each row's prior reading sees the previous
    // one.
    await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "API",
      reads: [
        { meterNumber, readDatetime: "2024-04-01T09:00:00Z", reading: 500 },
        { meterNumber, readDatetime: "2024-02-01T09:00:00Z", reading: 100 },
        { meterNumber, readDatetime: "2024-03-01T09:00:00Z", reading: 250 },
      ],
    });

    const reads = await prisma.meterRead.findMany({
      where: { utilityId: fixA.utilityId, meterId: fixA.meterId },
      orderBy: { readDatetime: "asc" },
      select: { readDatetime: true, reading: true, priorReading: true, consumption: true },
    });
    expect(reads).toHaveLength(3);
    // Feb 1: no prior reading → 0, consumption = 100.
    expect(Number(reads[0].priorReading)).toBe(0);
    expect(Number(reads[0].consumption)).toBe(100);
    // Mar 1: prior = 100, consumption = 150.
    expect(Number(reads[1].priorReading)).toBe(100);
    expect(Number(reads[1].consumption)).toBe(150);
    // Apr 1: prior = 250, consumption = 250.
    expect(Number(reads[2].priorReading)).toBe(250);
    expect(Number(reads[2].consumption)).toBe(250);
  });

  it("partial success: invalid rows reported, valid rows still committed, batch COMPLETE", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    const result = await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "AMR",
      reads: [
        { meterNumber, readDatetime: "2024-02-01T09:00:00Z", reading: 100 },
        { meterNumber: "DOES-NOT-EXIST", readDatetime: "2024-02-01T09:00:00Z", reading: 200 },
        { meterNumber: meter2Number, readDatetime: "2024-02-01T09:00:00Z", reading: 75 },
      ],
    });

    expect(result.imported).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      row: 2, // 1-indexed; this is the second row in the input order
      meterNumber: "DOES-NOT-EXIST",
    });
    expect(result.errors[0].error).toMatch(/not found/);

    const reads = await prisma.meterRead.count({
      where: { utilityId: fixA.utilityId, importBatchId: result.batchId },
    });
    expect(reads).toBe(2);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    // Two of three succeeded — COMPLETE, not FAILED. Operator has data.
    expect(batch.status).toBe("COMPLETE");
    expect(batch.errorCount).toBe(1);
    expect(batch.importedCount).toBe(2);
    expect(batch.errors).not.toBeNull();
  });

  it("rejects rows for REMOVED meters with a clear error and leaves the rest committed", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    // Mark meter2 as REMOVED (bypass the trigger by going via the close
    // helper would be cleaner, but for this test we just flip the
    // status directly).
    await prisma.meter.update({
      where: { id: fixA.meterId2 },
      data: { status: "REMOVED", removalDate: new Date("2024-01-15") },
    });

    const result = await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "AMI",
      reads: [
        { meterNumber, readDatetime: "2024-02-01T09:00:00Z", reading: 100 },
        { meterNumber: meter2Number, readDatetime: "2024-02-01T09:00:00Z", reading: 200 },
      ],
    });

    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toMatch(/REMOVED/);
  });

  it("when EVERY row fails, the batch is marked FAILED", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    const result = await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "API",
      reads: [
        { meterNumber: "NONE-1", readDatetime: "2024-02-01T09:00:00Z", reading: 1 },
        { meterNumber: "NONE-2", readDatetime: "2024-02-02T09:00:00Z", reading: 2 },
      ],
    });

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(2);

    const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: result.batchId } });
    expect(batch.status).toBe("FAILED");
    expect(batch.importedCount).toBe(0);
  });

  it("maps batch source → read source per row when row didn't supply readSource", async () => {
    const { prisma } = prismaImports;
    const { importMeterReads } = serviceImports;

    await importMeterReads(fixA.utilityId, ACTOR, "Tester", {
      source: "AMI",
      reads: [
        { meterNumber, readDatetime: "2024-02-01T09:00:00Z", reading: 100 },
        // Row-level override wins over the batch source mapping.
        {
          meterNumber: meter2Number,
          readDatetime: "2024-02-01T09:00:00Z",
          reading: 50,
          readSource: "CUSTOMER_SELF",
        },
      ],
    });

    const reads = await prisma.meterRead.findMany({
      where: { utilityId: fixA.utilityId },
      select: { meterId: true, readSource: true },
    });
    const m1 = reads.find((r) => r.meterId === fixA.meterId);
    const m2 = reads.find((r) => r.meterId === fixA.meterId2);
    expect(m1?.readSource).toBe("AMI"); // batch fallback
    expect(m2?.readSource).toBe("CUSTOMER_SELF"); // row override
  });
});
