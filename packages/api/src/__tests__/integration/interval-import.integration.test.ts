import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  ACTOR,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Getting a day of interval data into the database (spec 26, TOU-INT-2).
 *
 * The interval path was built end to end and fed by **nothing but the
 * dev seed**: no route wrote `meter_read_interval`, no import handler
 * existed, so a utility with an AMI head-end had no way to deliver a
 * day. Everything downstream — tiling, classification, the roll-up into
 * TOU buckets, the coverage queue, the pre-run blocker — described data
 * only a seed could produce.
 *
 * Driven through `processBatch`, the framework's own per-row dispatch,
 * rather than by calling the handler: a handler that parses perfectly
 * and is not registered, or writes rows the framework rolls back, is
 * exactly the failure this is worth catching. The one thing mocked is
 * the queue, so a test never leaves a job in the dev Redis.
 */

vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let processBatch: typeof import("../../services/imports/process-batch.service.js")["processBatch"];
let fixA: TenantFixture;

const KIND = "meter_read_interval";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  // The registration side effect, as the app does it at boot.
  await import("../../imports/handlers/index.js");
  ({ processBatch } = await import("../../services/imports/process-batch.service.js"));
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
  }));

/** A batch of rows, as the wizard's mapping stage would hand them over. */
async function importRows(rows: Array<Record<string, string>>) {
  const batchId = await seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: TENANT_A,
        entityKind: KIND,
        fileName: "intervals.csv",
        source: "AMI",
        status: "PENDING",
        recordCount: rows.length,
        mapping: {},
        createdBy: ACTOR,
      },
      select: { id: true },
    });
    await prisma.importRow.createMany({
      data: rows.map((raw, i) => ({
        utilityId: TENANT_A,
        importBatchId: batch.id,
        rowIndex: i + 1,
        rawData: raw,
        status: "PENDING" as const,
      })),
    });
    return batch.id;
  });

  const result = await runAsTenant(TENANT_A, () =>
    processBatch({
      batchId,
      utilityId: TENANT_A,
      actorId: ACTOR,
      actorName: "Tester",
      scope: "pending",
    }),
  );
  return { batchId, result };
}

async function intervals() {
  return seedAsPlatform(async () =>
    prismaImports.prisma.meterReadInterval.findMany({
      where: { utilityId: TENANT_A },
      orderBy: { intervalStart: "asc" },
      select: {
        intervalStart: true,
        lengthMinutes: true,
        quantity: true,
        quality: true,
        registerId: true,
        uomId: true,
      },
    }),
  );
}

function row(over: Record<string, string> = {}) {
  return {
    meterNumber: "FIX-METER-aa",
    intervalStart: "2026-02-08T00:00:00Z",
    lengthMinutes: "60",
    quantity: "0.4",
    quality: "actual",
    ...over,
  };
}

/** The fixture's meter number, whatever the fixture calls it. */
async function meterNumber(): Promise<string> {
  return seedAsPlatform(async () => {
    const m = await prismaImports.prisma.meter.findFirstOrThrow({
      where: { id: fixA.meterId },
      select: { meterNumber: true },
    });
    return m.meterNumber;
  });
}

describe("importing a series", () => {
  it("writes an interval per row, in the meter's own unit", async () => {
    const meter = await meterNumber();

    const { result } = await importRows([
      row({ meterNumber: meter, intervalStart: "2026-02-08T00:00:00Z", quantity: "0.4" }),
      row({ meterNumber: meter, intervalStart: "2026-02-08T01:00:00Z", quantity: "0.3" }),
    ]);

    expect(result.status).toBe("COMPLETE");
    const rows = await intervals();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.quantity.toString()).toBe("0.4");
    expect(rows[0]!.lengthMinutes).toBe(60);
    // The unit comes from the meter: an interval file carries a
    // quantity, not a unit, and a series in the wrong unit bills wrong
    // while looking right.
    expect(rows[0]!.uomId).toBe(fixA.uomId);
  });

  it("keeps a negative quantity, which is a meter exporting", async () => {
    const meter = await meterNumber();

    await importRows([row({ meterNumber: meter, quantity: "-0.75" })]);

    expect((await intervals())[0]!.quantity.toString()).toBe("-0.75");
  });

  it("records a quality the head-end reported", async () => {
    const meter = await meterNumber();

    await importRows([row({ meterNumber: meter, quality: "missing" })]);

    /*
     * `missing` is a row rather than an absence — a hole the meter
     * knows about, which the roll-up refuses differently from one
     * nobody noticed. An importer that dropped these would make the
     * distinction the coverage queue is built on unreachable.
     */
    expect((await intervals())[0]!.quality).toBe("missing");
  });

  it("reports the row, not the batch, when one row is wrong", async () => {
    const meter = await meterNumber();

    const { batchId, result } = await importRows([
      row({ meterNumber: meter }),
      row({ meterNumber: meter, intervalStart: "2026-02-08T01:00:00Z", lengthMinutes: "10" }),
    ]);

    expect(result.status).toBe("PARTIAL");
    expect(await intervals()).toHaveLength(1);
    const errors = await seedAsPlatform(async () =>
      prismaImports.prisma.importRow.findMany({
        where: { importBatchId: batchId, status: "ERROR" },
        select: { errorCode: true, errorMessage: true },
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.errorCode).toBe("INVALID_LENGTH");
    // The message names the four lengths, because a constraint-name
    // error from the insert would tell an operator nothing.
    expect(errors[0]!.errorMessage).toContain("5, 15, 30, 60");
  });

  it("refuses a row naming a meter this tenant does not have", async () => {
    const { batchId } = await importRows([row({ meterNumber: "NOT-A-METER" })]);

    expect(await intervals()).toHaveLength(0);
    const errors = await seedAsPlatform(async () =>
      prismaImports.prisma.importRow.findMany({
        where: { importBatchId: batchId, status: "ERROR" },
        select: { errorCode: true },
      }),
    );
    expect(errors[0]!.errorCode).toBe("UNKNOWN_METER");
  });
});

describe("importing the same day twice", () => {
  it("replaces the values rather than doubling the day", async () => {
    const meter = await meterNumber();
    await importRows([row({ meterNumber: meter, quantity: "0.4" })]);

    /*
     * A head-end re-sending a day usually means corrected values, and
     * an operator importing the same file twice means the same day.
     * Both want one row. The database's own key — two partial unique
     * indexes over `(meter_id, register_id, interval_start)` — is what
     * makes that the only possible outcome, and it is what the handler
     * keys on.
     */
    await importRows([row({ meterNumber: meter, quantity: "0.9", quality: "edited" })]);

    const rows = await intervals();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.quantity.toString()).toBe("0.9");
    expect(rows[0]!.quality).toBe("edited");
  });
});

describe("a file that names no timezone", () => {
  it("reads the wall clock in the tenant's own zone", async () => {
    const meter = await meterNumber();
    await seedAsPlatform(async () => {
      await prismaImports.prisma.utilityConfig.updateMany({
        where: { utilityId: TENANT_A },
        data: { timezone: "America/Denver" },
      });
    });

    await importRows([
      row({ meterNumber: meter, intervalStart: "2026-02-08 01:00:00" }),
    ]);

    /*
     * 01:00 in Denver in February is 08:00Z. Read as UTC it would land
     * seven hours early — and nothing downstream could tell: the series
     * still tiles, still classifies, and bills against the wrong TOU
     * period. Which is why the import summary says the zone was
     * assumed rather than leaving it silent.
     */
    const rows = await intervals();
    expect(rows[0]!.intervalStart.toISOString()).toBe("2026-02-08T08:00:00.000Z");
  });

  it("gets the offset right on the far side of a DST change", async () => {
    const meter = await meterNumber();
    await seedAsPlatform(async () => {
      await prismaImports.prisma.utilityConfig.updateMany({
        where: { utilityId: TENANT_A },
        data: { timezone: "America/Denver" },
      });
    });

    // 8 March 2026 is a spring-forward day in Denver: 01:00 is MST
    // (-07:00) and 03:00 is MDT (-06:00).
    await importRows([
      row({ meterNumber: meter, intervalStart: "2026-03-08 01:00:00", quantity: "1" }),
      row({ meterNumber: meter, intervalStart: "2026-03-08 03:00:00", quantity: "2" }),
    ]);

    const rows = await intervals();
    expect(rows.map((r) => r.intervalStart.toISOString())).toEqual([
      "2026-03-08T08:00:00.000Z",
      "2026-03-08T09:00:00.000Z",
    ]);
  });
});

describe("tracing a row back to its file", () => {
  it("stamps the batch that wrote each interval", async () => {
    const meter = await meterNumber();

    const { batchId } = await importRows([row({ meterNumber: meter })]);

    /*
     * `import_batch_id` has existed on this table since the baseline
     * migration, with an index on `(utility_id, import_batch_id)` — and
     * **no handler could stamp it**, because `HandlerContext` did not
     * carry the batch id. So the question the column exists for ("which
     * file put this here") had no answer, which is what a head-end
     * sending a bad day makes you ask first.
     */
    const stamped = await seedAsPlatform(async () =>
      prismaImports.prisma.meterReadInterval.findMany({
        where: { utilityId: TENANT_A, importBatchId: batchId },
        select: { id: true },
      }),
    );
    expect(stamped).toHaveLength(1);
  });
});
