import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readRouteInputSchema } from "@utility-cis/shared";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  ACTOR,
  type TenantFixture,
  endAdminPool,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Route entry, against a real database: rows staged as `import_row`, then
 * posted as a whole through the `meter_read` handler.
 *
 * The fixture cycle is MONTHLY with bill day 10, so the window containing
 * 2026-06-05 is 2026-05-11 .. 2026-06-10. Entry here is for 2026-06-05.
 *
 * Nothing in the entry path enqueues (`processBatch` runs inline, and
 * `recordSkips` / the handler are in-transaction writes), so there is no
 * `enqueueSafely` to mock and no job can be left in the dev Redis.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let tenancy: typeof import("../../lib/tenant-context.js");
let entry: typeof import("../../services/read-route-entry.service.js");
let routes: typeof import("../../services/read-route.service.js");

let fixA: TenantFixture;
let fixB: TenantFixture;
const actor = { id: ACTOR, name: "Test Actor" };
const DAY = new Date("2026-06-05");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  tenancy = await import("../../lib/tenant-context.js");
  await import("../../imports/handlers/index.js");
  entry = await import("../../services/read-route-entry.service.js");
  routes = await import("../../services/read-route.service.js");
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
    // `resetDb` does not clear the staging tables; rows cascade from the batch.
    await prismaImports.prisma.importBatch.deleteMany();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
  }));

const asA = <T>(fn: () => Promise<T>) => tenancy.runAsTenant(TENANT_A, fn);
const asB = <T>(fn: () => Promise<T>) => tenancy.runAsTenant(TENANT_B, fn);
const seed = <T>(fn: (p: typeof prismaImports.prisma) => Promise<T>) =>
  seedAsPlatform(async () => await fn(prismaImports.prisma)); // awaited inside: a PrismaPromise is lazy

const open = (routeId: string, day = DAY) => asA(() => entry.openEntry(TENANT_A, actor, routeId, day));
const save = (batchId: string, input: Parameters<typeof entry.saveEntryRow>[3]) =>
  asA(() => entry.saveEntryRow(TENANT_A, actor, batchId, input));
const submit = (batchId: string) => asA(() => entry.submitEntry(TENANT_A, actor, batchId));

const readCount = () => seed((p) => p.meterRead.count());
const skipCount = (meterId?: string) => seed((p) => p.readSkip.count({ where: meterId ? { meterId } : {} }));

let seq = 0;

async function makeRoute(origin: "LOCAL" | "EXTERNAL" = "LOCAL"): Promise<string> {
  const code = `RT-${++seq}`;
  const route = await asA(() =>
    routes.createReadRoute(
      TENANT_A,
      actor,
      readRouteInputSchema.parse({ code, name: code, billingCycleId: fixA.billingCycleId, origin }),
    ),
  );
  return route.id;
}

/** A premise with an agreement, a service point and one meter (optionally with registers), on the route. */
async function makeStop(
  routeId: string | null,
  opts: { registers?: number[] } = {},
): Promise<{ premiseId: string; meterId: string; meterNumber: string; registerIds: string[]; agreementId: string }> {
  const n = ++seq;
  const made = await seed(async (prisma) => {
    const premise = await prisma.premise.create({
      data: {
        utilityId: TENANT_A,
        addressLine1: `${n} Entry Street`,
        city: "Testville",
        state: "TS",
        zip: "00000",
        premiseType: "RESIDENTIAL",
        commodityIds: [fixA.commodityId],
        status: "ACTIVE",
      },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        utilityId: TENANT_A,
        agreementNumber: `SA-EN-${n}`,
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
      data: {
        utilityId: TENANT_A,
        serviceAgreementId: agreement.id,
        premiseId: premise.id,
        startDate: new Date("2024-01-01"),
      },
    });
    const meter = await prisma.meter.create({
      data: {
        utilityId: TENANT_A,
        premiseId: premise.id,
        commodityId: fixA.commodityId,
        uomId: fixA.uomId,
        meterNumber: `EN-M-${n}`,
        meterType: "MANUAL",
        status: "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });
    await prisma.servicePointMeter.create({
      data: {
        utilityId: TENANT_A,
        servicePointId: sp.id,
        meterId: meter.id,
        addedDate: new Date("2024-01-01"),
      },
    });
    const registerIds: string[] = [];
    if (opts.registers?.length) {
      const measureType = await prisma.measureTypeDef.findFirstOrThrow({ orderBy: { id: "asc" } });
      for (const number of opts.registers) {
        const r = await prisma.meterRegister.create({
          data: {
            utilityId: TENANT_A,
            meterId: meter.id,
            registerNumber: number,
            uomId: fixA.uomId,
            measureTypeId: measureType.id,
            isActive: true,
          },
        });
        registerIds.push(r.id);
      }
    }
    return {
      premiseId: premise.id,
      meterId: meter.id,
      meterNumber: meter.meterNumber,
      registerIds,
      agreementId: agreement.id,
    };
  });
  if (routeId) {
    await asA(() => routes.addStop(TENANT_A, actor, routeId, { premiseId: made.premiseId }));
  }
  return made;
}

/** A read already in the window, optionally billed. */
async function priorRead(stop: { meterId: string; agreementId: string }, billed: boolean) {
  return seed((prisma) =>
    prisma.meterRead.create({
      data: {
        utilityId: TENANT_A,
        meterId: stop.meterId,
        serviceAgreementId: stop.agreementId,
        uomId: fixA.uomId,
        readDate: new Date("2026-05-20"),
        readDatetime: new Date("2026-05-20T12:00:00Z"),
        reading: 100,
        priorReading: 0,
        consumption: 100,
        readType: "ACTUAL",
        readSource: "MANUAL",
        billedAt: billed ? new Date("2026-06-01T00:00:00Z") : null,
      },
    }),
  );
}

const rowFor = <R extends { meterId: string; registerId: string | null }>(rows: R[], meterId: string, registerId: string | null = null) =>
  rows.find((r) => r.meterId === meterId && r.registerId === registerId)!;

describe("opening entry", () => {
  it("opens one file-less API batch per route and date, with a row per readable register in stop order", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const s2 = await makeStop(routeId, { registers: [1, 2] });

    const { batchId, rows } = await open(routeId);

    const batch = await seed((p) => p.importBatch.findUniqueOrThrow({ where: { id: batchId } }));
    expect(batch).toMatchObject({
      entityKind: "meter_read",
      source: "API",
      fileName: null,
      status: "PENDING",
      recordCount: 3,
    });
    expect(rows.map((r) => [r.meterId, r.registerId])).toEqual([
      [s1.meterId, null],
      [s2.meterId, s2.registerIds[0]],
      [s2.meterId, s2.registerIds[1]],
    ]);
    expect(rows.every((r) => r.status === "PENDING" && r.reading === null && r.skipReason === null)).toBe(true);
    expect(await readCount()).toBe(0);
  });

  it("returns the same batch, and no second set of rows, when entry is reopened", async () => {
    const routeId = await makeRoute();
    await makeStop(routeId);
    const first = await open(routeId);
    const again = await open(routeId);

    expect(again.batchId).toBe(first.batchId);
    expect(await seed((p) => p.importBatch.count())).toBe(1);
    expect(await seed((p) => p.importRow.count())).toBe(1);
  });

  it("opens a different batch for a different date", async () => {
    const routeId = await makeRoute();
    await makeStop(routeId);
    const a = await open(routeId, new Date("2026-06-05"));
    const b = await open(routeId, new Date("2026-06-06"));
    expect(b.batchId).not.toBe(a.batchId);
  });

  it("refuses an EXTERNAL route and an unknown one", async () => {
    const ext = await makeRoute("EXTERNAL");
    await expect(open(ext)).rejects.toMatchObject({ statusCode: 400, code: "ROUTE_IS_EXTERNAL" });
    await expect(open("00000000-0000-4000-8000-00000000dead")).rejects.toMatchObject({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    });
  });
});

describe("saving a row", () => {
  it("stages a reading as a PENDING import row without writing a meter_read", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    const { batchId } = await open(routeId);

    const saved = await save(batchId, { meterId: s.meterId, registerId: null, reading: 123.5 });

    expect(saved).toMatchObject({ meterId: s.meterId, reading: "123.5", status: "PENDING" });
    const stored = await seed((p) => p.importRow.findFirstOrThrow({ where: { importBatchId: batchId } }));
    expect(stored.status).toBe("PENDING");
    expect((stored.rawData as Record<string, string>).reading).toBe("123.5");
    expect(await readCount()).toBe(0);
    // And it survives a reopen: that is the point of staging server-side.
    const reopened = await open(routeId);
    expect(rowFor(reopened.rows, s.meterId).reading).toBe("123.5");
  });

  it("stages a coded row, and replaces a reading with a code", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s.meterId, registerId: null, reading: 5 });
    const saved = await save(batchId, {
      meterId: s.meterId,
      registerId: null,
      skipReason: "LOCKED_GATE",
      notes: "back gate",
    });
    expect(saved).toMatchObject({ reading: null, skipReason: "LOCKED_GATE", notes: "back gate" });
  });

  it("refuses a row with both a reading and a code, a negative reading, and a row not on the sheet", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    const stranger = await makeStop(null);
    const { batchId } = await open(routeId);
    await expect(
      save(batchId, { meterId: s.meterId, registerId: null, reading: 1, skipReason: "DOG" }),
    ).rejects.toMatchObject({ statusCode: 400, code: "ENTRY_ROW_AMBIGUOUS" });
    await expect(save(batchId, { meterId: s.meterId, registerId: null, reading: -1 })).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_READING",
    });
    await expect(save(batchId, { meterId: stranger.meterId, registerId: null, reading: 1 })).rejects.toMatchObject({
      statusCode: 404,
      code: "ENTRY_ROW_NOT_FOUND",
    });
  });

  it("does not see another tenant's batch", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await expect(
      asB(() => entry.saveEntryRow(TENANT_B, actor, batchId, { meterId: s.meterId, registerId: null, reading: 1 })),
    ).rejects.toMatchObject({ statusCode: 404, code: "ENTRY_NOT_FOUND" });
  });

  it("refuses a reading for a meter whose period already has a billed read", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    await priorRead(s, true);
    const { batchId } = await open(routeId);
    await expect(save(batchId, { meterId: s.meterId, registerId: null, reading: 150 })).rejects.toMatchObject({
      statusCode: 400,
      code: "READ_BILLED",
    });
  });

  it("accepts the same reading when the prior read is unbilled (the control for the one above)", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    await priorRead(s, false);
    const { batchId } = await open(routeId);
    const saved = await save(batchId, { meterId: s.meterId, registerId: null, reading: 150 });
    expect(saved.reading).toBe("150");
  });
});

describe("submitting", () => {
  it("posts every typed row, carrying the route and the register", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const s2 = await makeStop(routeId, { registers: [1, 2] });
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });
    await save(batchId, { meterId: s2.meterId, registerId: s2.registerIds[0], reading: 40 });
    await save(batchId, { meterId: s2.meterId, registerId: s2.registerIds[1], reading: 60 });

    const result = await submit(batchId);

    expect(result).toMatchObject({ batchId, status: "COMPLETE", importedCount: 3, errorCount: 0, skipsRecorded: 0 });
    const reads = await seed((p) => p.meterRead.findMany({ orderBy: { reading: "asc" } }));
    expect(reads).toHaveLength(3);
    expect(reads.every((r) => r.routeId === routeId)).toBe(true);
    expect(reads.map((r) => r.registerId)).toEqual([s2.registerIds[0], s2.registerIds[1], null]);
    expect(reads.map((r) => Number(r.reading))).toEqual([40, 60, 150]);
    const rows = await seed((p) => p.importRow.findMany({ where: { importBatchId: batchId } }));
    expect(rows.every((r) => r.status === "IMPORTED")).toBe(true);
  });

  it("records a skip instead of a read for a coded row", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const s2 = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });
    await save(batchId, { meterId: s2.meterId, registerId: null, skipReason: "LOCKED_GATE", notes: "dog" });

    const result = await submit(batchId);

    expect(result).toMatchObject({ importedCount: 1, errorCount: 0, skipsRecorded: 1 });
    const reads = await seed((p) => p.meterRead.findMany());
    expect(reads.map((r) => r.meterId)).toEqual([s1.meterId]);
    const skips = await seed((p) => p.readSkip.findMany());
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({
      meterId: s2.meterId,
      readRouteId: routeId,
      skipReason: "LOCKED_GATE",
      notes: "dog",
    });
    const coded = await seed((p) =>
      p.importRow.findMany({ where: { importBatchId: batchId, status: "SKIPPED" } }),
    );
    expect(coded).toHaveLength(1);
  });

  it("a stop with one register read and another coded is a read meter: one read, no skip", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId, { registers: [1, 2] });
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s.meterId, registerId: s.registerIds[0], reading: 40 });
    await save(batchId, { meterId: s.meterId, registerId: s.registerIds[1], skipReason: "UNREADABLE" });

    const result = await submit(batchId);

    expect(result).toMatchObject({ importedCount: 1, errorCount: 0, skipsRecorded: 0 });
    expect(await seed((p) => p.meterRead.count({ where: { meterId: s.meterId } }))).toBe(1);
    expect(await skipCount(s.meterId)).toBe(0);
  });

  it("a stop with every register coded is a skipped meter: one skip however many rows", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId, { registers: [1, 2] });
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s.meterId, registerId: s.registerIds[0], skipReason: "DOG" });
    await save(batchId, { meterId: s.meterId, registerId: s.registerIds[1], skipReason: "DOG" });

    const result = await submit(batchId);

    expect(result).toMatchObject({ importedCount: 0, skipsRecorded: 1 });
    expect(await skipCount(s.meterId)).toBe(1);
    expect(await readCount()).toBe(0);
  });

  it("leaves untouched rows out rather than failing them, and says how many", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });

    const result = await submit(batchId);

    expect(result).toMatchObject({ importedCount: 1, errorCount: 0, notEntered: 1 });
    expect(result.status).toBe("COMPLETE");
  });

  it("is a no-op on a second submit: no second read, and the first batch's counts", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const s2 = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });
    await save(batchId, { meterId: s2.meterId, registerId: null, skipReason: "DOG" });
    const first = await submit(batchId);
    const readsBefore = await readCount();
    const skipsBefore = await skipCount();
    const auditBefore = await seed((p) => p.auditLog.count());
    expect(readsBefore).toBe(1);

    const again = await submit(batchId);

    expect(again).toMatchObject({
      batchId: first.batchId,
      status: first.status,
      importedCount: first.importedCount,
      errorCount: first.errorCount,
      skipsRecorded: first.skipsRecorded,
      alreadySubmitted: true,
    });
    expect(await readCount()).toBe(readsBefore);
    expect(await skipCount()).toBe(skipsBefore);
    expect(await seed((p) => p.auditLog.count())).toBe(auditBefore);
  });

  it("writes one read per row when two submits race", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });

    const [a, b] = await Promise.all([submit(batchId), submit(batchId)]);

    expect(await readCount()).toBe(1);
    expect([a, b].filter((r) => !r.alreadySubmitted)).toHaveLength(1);
  });

  it("refuses to save into a batch that has been submitted, and a reopen returns it", async () => {
    const routeId = await makeRoute();
    const s1 = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s1.meterId, registerId: null, reading: 150 });
    await submit(batchId);

    await expect(save(batchId, { meterId: s1.meterId, registerId: null, reading: 151 })).rejects.toMatchObject({
      statusCode: 409,
      code: "ENTRY_CLOSED",
    });
    expect((await open(routeId)).batchId).toBe(batchId);
    expect(await readCount()).toBe(1);
  });

  it("rejects a row whose period was billed after it was typed, and posts its neighbour", async () => {
    const routeId = await makeRoute();
    const billed = await makeStop(routeId);
    const clean = await makeStop(routeId);
    // Both meters have a read in the window; only `billed`'s has been billed. Saved
    // while both are unbilled, so the save-time check does not stop either.
    const billedRead = await priorRead(billed, false);
    await priorRead(clean, false);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: billed.meterId, registerId: null, reading: 150 });
    await save(batchId, { meterId: clean.meterId, registerId: null, reading: 150 });
    const before = await readCount();
    await seed((p) =>
      p.meterRead.updateMany({ where: { id: billedRead.id }, data: { billedAt: new Date("2026-06-06T00:00:00Z") } }),
    );

    const result = await submit(batchId);

    expect(result).toMatchObject({ status: "PARTIAL", importedCount: 1, errorCount: 1 });
    expect(await readCount()).toBe(before + 1);
    expect(await seed((p) => p.meterRead.count({ where: { meterId: billed.meterId } }))).toBe(1);
    const rows = await seed((p) => p.importRow.findMany({ where: { importBatchId: batchId } }));
    const bad = rows.filter((r) => r.status === "ERROR");
    expect(bad).toHaveLength(1);
    expect(bad[0].errorCode).toBe("READ_BILLED");
    expect(rows.find((r) => r.status === "IMPORTED")).toBeDefined();
  });

  it("reports a coded row the skip rules refuse as an error, and keeps the reads already posted", async () => {
    const routeId = await makeRoute();
    const read = await makeStop(routeId);
    const already = await makeStop(routeId);
    await priorRead(already, false); // unbilled: so METER_ALREADY_READ, not READ_BILLED
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: read.meterId, registerId: null, reading: 150 });
    await save(batchId, { meterId: already.meterId, registerId: null, skipReason: "DOG" });

    const result = await submit(batchId);

    expect(result).toMatchObject({ importedCount: 1, errorCount: 1, skipsRecorded: 0 });
    const bad = await seed((p) => p.importRow.findFirstOrThrow({ where: { importBatchId: batchId, status: "ERROR" } }));
    expect(bad.errorCode).toBe("METER_ALREADY_READ");
    expect(await skipCount()).toBe(0);
  });

  it("a batch with nothing but codes still closes", async () => {
    const routeId = await makeRoute();
    const s = await makeStop(routeId);
    const { batchId } = await open(routeId);
    await save(batchId, { meterId: s.meterId, registerId: null, skipReason: "DOG" });
    const result = await submit(batchId);
    expect(result).toMatchObject({ status: "COMPLETE", importedCount: 0, skipsRecorded: 1 });
    expect(await submit(batchId)).toMatchObject({ alreadySubmitted: true, skipsRecorded: 1 });
  });
});
