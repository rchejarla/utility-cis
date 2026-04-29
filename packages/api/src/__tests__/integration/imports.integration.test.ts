import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
} from "./_effective-dating-fixtures.js";

/**
 * End-to-end test of the generic import framework. Exercises:
 *   - multipart upload to POST /api/v1/imports
 *   - kind dispatch to the meter-read handler
 *   - mapping validation
 *   - per-row error reporting via import_row
 *   - original file persisted via Attachment
 *   - GET /imports + /imports/:id + /imports/:id/rows + error-summary
 *   - permission gate (kind handler's permission, not imports.VIEW)
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;
let saId: string;
let meterNumber: string;
let meter2Number: string;

const ENABLED_MODULES = [
  "imports",
  "meter_reads",
  "meters",
  "premises",
  "accounts",
  "customers",
  "agreements",
];

function makeToken(utilityId: string, actorId = "00000000-0000-4000-8000-aaaa00000001") {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

const headers = () => ({ authorization: `Bearer ${makeToken(TENANT_A)}` });

/**
 * Build a multipart/form-data body. Returns a Buffer + the
 * matching Content-Type header (with the boundary). Files declared
 * in `parts` are encoded with their filename + MIME; other entries
 * are plain text fields.
 */
function buildMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; body: string | Buffer }
  >,
): { body: Buffer; contentType: string } {
  const boundary = `----imports-test-${Math.random().toString(36).slice(2)}`;
  const segments: Buffer[] = [];
  for (const part of parts) {
    segments.push(Buffer.from(`--${boundary}\r\n`));
    if ("filename" in part) {
      segments.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      segments.push(Buffer.from(`Content-Type: ${part.contentType}\r\n\r\n`));
      segments.push(
        typeof part.body === "string" ? Buffer.from(part.body) : part.body,
      );
      segments.push(Buffer.from("\r\n"));
    } else {
      segments.push(
        Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`),
      );
      segments.push(Buffer.from(part.value));
      segments.push(Buffer.from("\r\n"));
    }
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(segments),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await resetDb(prisma);
  // The shared resetDb doesn't truncate import tables — add them so
  // tests don't accumulate batches across cases.
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE import_row, import_batch, attachment, in_app_notification RESTART IDENTITY CASCADE",
  );

  fixA = await makeTenantFixture(prisma, TENANT_A);

  for (const moduleKey of ENABLED_MODULES) {
    await prisma.tenantModule.create({
      data: { utilityId: fixA.utilityId, moduleKey },
    });
  }

  // RBAC caches tenant-modules + user-role in Redis (TTL 600s).
  // Without explicit invalidation, state from a previous test file
  // leaks into this one when vitest runs them sequentially in the
  // same process.
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(fixA.utilityId);

  // SA + open SAMs so meter-read processing can resolve agreement.
  const sa = await prisma.serviceAgreement.create({
    data: {
      utilityId: fixA.utilityId,
      agreementNumber: "SA-IMP",
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

  const meters = await prisma.meter.findMany({
    where: { utilityId: fixA.utilityId },
    select: { id: true, meterNumber: true },
  });
  meterNumber = meters.find((m) => m.id === fixA.meterId)!.meterNumber;
  meter2Number = meters.find((m) => m.id === fixA.meterId2)!.meterNumber;
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("GET /api/v1/imports/kinds", () => {
  it("returns the registered meter_read handler metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{
      kind: string;
      label: string;
      canonicalFields: Array<{ name: string; required: boolean }>;
    }>;
    const meterRead = body.find((k) => k.kind === "meter_read");
    expect(meterRead).toBeDefined();
    expect(meterRead?.label).toBe("Meter reads");
    expect(meterRead?.canonicalFields.find((f) => f.name === "meterNumber")?.required).toBe(true);
  });
});

describe("GET /api/v1/imports/kinds/:kind/template.csv", () => {
  it("returns a CSV template for meter_read", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds/meter_read/template.csv",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const lines = res.body.split("\n").filter(Boolean);
    expect(lines[0]).toContain("meterNumber");
    expect(lines[0]).toContain("readDatetime");
    expect(lines[0]).toContain("reading");
    expect(lines.length).toBeGreaterThan(1); // header + at least one example row
  });
});

describe("POST /api/v1/imports — meter_read happy path", () => {
  it("uploads a CSV, parses, processes rows, persists Attachment, returns COMPLETE", async () => {
    const { prisma } = prismaImports;

    const csv =
      "meter_number,read_datetime,reading\n" +
      `${meterNumber},2024-02-01T09:00:00Z,100\n` +
      `${meter2Number},2024-02-01T09:05:00Z,55\n`;

    const mapping = {
      meter_number: "meterNumber",
      read_datetime: "readDatetime",
      reading: "reading",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "fileName", value: "test.csv" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "test.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body) as {
      batchId: string;
      status: string;
      recordCount: number;
      importedCount: number;
      errorCount: number;
      attachmentId: string;
    };
    expect(result.status).toBe("COMPLETE");
    expect(result.recordCount).toBe(2);
    expect(result.importedCount).toBe(2);
    expect(result.errorCount).toBe(0);
    expect(result.attachmentId).toBeTruthy();

    // Two MeterRead rows created, both attached to the SA.
    const reads = await prisma.meterRead.findMany({
      where: { utilityId: fixA.utilityId },
    });
    expect(reads).toHaveLength(2);
    expect(reads.every((r) => r.serviceAgreementId === saId)).toBe(true);

    // ImportBatch status correct.
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: result.batchId },
    });
    expect(batch.status).toBe("COMPLETE");
    expect(batch.entityKind).toBe("meter_read");

    // import_row rows: all IMPORTED.
    const rows = await prisma.importRow.findMany({
      where: { importBatchId: result.batchId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "IMPORTED")).toBe(true);

    // Original file persisted as Attachment.
    const attachment = await prisma.attachment.findUniqueOrThrow({
      where: { id: result.attachmentId },
    });
    expect(attachment.entityType).toBe("ImportBatch");
    expect(attachment.entityId).toBe(result.batchId);
    expect(attachment.fileName).toBe("test.csv");
    expect(attachment.fileType).toBe("text/csv");
  });
});

describe("POST /api/v1/imports — partial success", () => {
  it("imports valid rows, marks invalid ones ERROR, batch ends PARTIAL", async () => {
    const { prisma } = prismaImports;

    const csv =
      "meter_number,read_datetime,reading\n" +
      `${meterNumber},2024-02-01T09:00:00Z,100\n` +
      `DOES-NOT-EXIST,2024-02-01T09:00:00Z,200\n` +
      `${meter2Number},2024-02-01T09:05:00Z,55\n`;

    const mapping = {
      meter_number: "meterNumber",
      read_datetime: "readDatetime",
      reading: "reading",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "AMR" },
      { name: "fileName", value: "partial.csv" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "partial.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body) as {
      batchId: string;
      status: string;
      importedCount: number;
      errorCount: number;
      errors: Array<{ rowIndex: number; errorCode: string; errorMessage: string }>;
    };
    expect(result.status).toBe("PARTIAL");
    expect(result.importedCount).toBe(2);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].errorCode).toBe("METER_NOT_FOUND");
    expect(result.errors[0].rowIndex).toBe(2);

    // import_row table reflects the per-row truth.
    const rows = await prisma.importRow.findMany({
      where: { importBatchId: result.batchId },
      orderBy: { rowIndex: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["IMPORTED", "ERROR", "IMPORTED"]);
  });
});

describe("POST /api/v1/imports — mapping validation", () => {
  it("rejects mapping that omits a required canonical field", async () => {
    const csv = "meter_number,reading\nMTR-X,100\n";
    const mapping = { meter_number: "meterNumber", reading: "reading" }; // no readDatetime

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "x.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const errBody = JSON.parse(res.body);
    expect(errBody.error.code).toBe("MAPPING_MISSING_REQUIRED");
  });

  it("rejects mapping that points two headers at the same canonical field", async () => {
    const csv = "a,b,c,d\n1,2,3,4\n";
    const mapping = {
      a: "meterNumber",
      b: "meterNumber", // duplicate
      c: "readDatetime",
      d: "reading",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "dup.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    const errBody = JSON.parse(res.body);
    expect(errBody.error.code).toBe("MAPPING_DUPLICATE");
  });
});

describe("POST /api/v1/imports — unknown kind", () => {
  it("rejects an unknown kind with 400", async () => {
    const csv = "a\n1\n";
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "not_a_kind" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: "{}" },
      { name: "file", filename: "x.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("UNKNOWN_IMPORT_KIND");
  });
});

describe("GET /api/v1/imports — list", () => {
  it("returns batches across kinds with filters", async () => {
    const { prisma } = prismaImports;

    // Seed two batches directly.
    await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "AMR",
        recordCount: 5,
        importedCount: 5,
        errorCount: 0,
        status: "COMPLETE",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
      },
    });
    await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        recordCount: 10,
        importedCount: 7,
        errorCount: 3,
        status: "PARTIAL",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
      },
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/v1/imports",
      headers: headers(),
    });
    expect(all.statusCode).toBe(200);
    const allBody = JSON.parse(all.body) as { data: Array<{ status: string }> };
    expect(allBody.data.length).toBe(2);

    const filtered = await app.inject({
      method: "GET",
      url: "/api/v1/imports?status=PARTIAL",
      headers: headers(),
    });
    const filteredBody = JSON.parse(filtered.body) as { data: Array<{ status: string }> };
    expect(filteredBody.data.length).toBe(1);
    expect(filteredBody.data[0].status).toBe("PARTIAL");
  });
});

describe("GET /api/v1/imports/:id/error-summary", () => {
  it("aggregates error counts by errorCode", async () => {
    // Run a partial-success import first.
    const csv =
      "meter_number,read_datetime,reading\n" +
      `MISSING-A,2024-02-01T09:00:00Z,1\n` +
      `MISSING-B,2024-02-02T09:00:00Z,2\n` +
      `MISSING-C,2024-02-03T09:00:00Z,3\n`;
    const mapping = {
      meter_number: "meterNumber",
      read_datetime: "readDatetime",
      reading: "reading",
    };
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "errs.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    const { batchId } = JSON.parse(res.body);

    const summaryRes = await app.inject({
      method: "GET",
      url: `/api/v1/imports/${batchId}/error-summary`,
      headers: headers(),
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = JSON.parse(summaryRes.body) as Array<{
      errorCode: string;
      count: number;
    }>;
    const meterNotFound = summary.find((s) => s.errorCode === "METER_NOT_FOUND");
    expect(meterNotFound?.count).toBe(3);
  });
});

// ─── Slice 2 — async-path service-level tests ────────────────────────
//
// These exercise the cancel/retry/zombie service functions and the
// processBatch cancellation path. They run against the same Postgres
// fixture as the rest of the file — Redis is not required because
// enqueueSafely returns null when Redis is unreachable rather than
// throwing, so the cancel/retry endpoints succeed without a worker
// listening. Full end-to-end worker tests live in import-worker.

describe("POST /api/v1/imports — async path threshold", () => {
  it("returns 202 + async:true when recordCount > SYNC_THRESHOLD_ROWS (250)", async () => {
    const lines = ["meterNumber,readDatetime,reading"];
    for (let i = 0; i < 251; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      const hh = String(i % 24).padStart(2, "0");
      const mm = String(i % 60).padStart(2, "0");
      lines.push(`${meterNumber},2024-02-${day}T${hh}:${mm}:00Z,${1000 + i}`);
    }
    const csv = lines.join("\n");
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter_read" },
      { name: "source", value: "MANUAL_UPLOAD" },
      {
        name: "mapping",
        value: JSON.stringify({
          meterNumber: "meterNumber",
          readDatetime: "readDatetime",
          reading: "reading",
        }),
      },
      { name: "file", filename: "251.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const result = JSON.parse(res.body) as {
      async: boolean;
      batchId: string;
      recordCount: number;
    };
    expect(result.async).toBe(true);
    expect(result.recordCount).toBe(251);
    expect(result.batchId).toBeTruthy();

    // Batch is in PENDING because no worker picked it up in this test
    // (Redis isn't running). That's the expected state for an
    // un-drained queue.
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: result.batchId },
    });
    expect(batch.status).toBe("PENDING");
    expect(batch.recordCount).toBe(251);
  });
});

describe("POST /api/v1/imports/:id/cancel", () => {
  it("flips cancel_requested on a PENDING batch", async () => {
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "x.csv",
        recordCount: 5,
        status: "PROCESSING",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/cancel`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(updated.cancelRequested).toBe(true);
  });

  it("is a no-op on terminal batches", async () => {
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "x.csv",
        recordCount: 5,
        importedCount: 5,
        status: "COMPLETE",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/cancel`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const updated = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(updated.cancelRequested).toBe(false);
  });
});

describe("POST /api/v1/imports/:id/retry", () => {
  it("flips PARTIAL → PENDING and clears completedAt", async () => {
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "x.csv",
        recordCount: 10,
        importedCount: 7,
        errorCount: 3,
        status: "PARTIAL",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
        completedAt: new Date(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/retry`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(202);
    const updated = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(updated.status).toBe("PENDING");
    expect(updated.cancelRequested).toBe(false);
    expect(updated.completedAt).toBeNull();
  });

  it("rejects retry on a PROCESSING batch (not retryable)", async () => {
    const { prisma } = prismaImports;
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "x.csv",
        recordCount: 5,
        status: "PROCESSING",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${batch.id}/retry`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("NOT_RETRYABLE");
  });
});

describe("reclaimZombieBatches", () => {
  it("flips PROCESSING + stale lastProgressAt back to PENDING", async () => {
    const { prisma } = prismaImports;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stale = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "stale.csv",
        recordCount: 5,
        status: "PROCESSING",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: tenMinutesAgo,
      },
    });
    const fresh = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "fresh.csv",
        recordCount: 5,
        status: "PROCESSING",
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
      },
    });
    const { reclaimZombieBatches } = await import(
      "../../services/imports/zombie-sweep.service.js"
    );
    const ids = await reclaimZombieBatches(new Date());
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(fresh.id);

    const staleAfter = await prisma.importBatch.findUniqueOrThrow({
      where: { id: stale.id },
    });
    const freshAfter = await prisma.importBatch.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(staleAfter.status).toBe("PENDING");
    expect(freshAfter.status).toBe("PROCESSING");
  });
});

// ─── Slice 4a — Premise / Meter / Account handlers ──────────────────

describe("POST /api/v1/imports — premise handler", () => {
  it("imports a premise; resolves ownerEmail to customerId and commodityCodes to uuid[]", async () => {
    const { prisma } = prismaImports;

    // Seed a customer for the owner-email lookup. The fixture's
    // commodity is `WATER-<suffix>`, so use that exact code.
    const owner = await prisma.customer.create({
      data: {
        utilityId: fixA.utilityId,
        customerType: "INDIVIDUAL",
        firstName: "Owner",
        lastName: "Test",
        email: "owner@example.com",
      },
    });
    const commodity = await prisma.commodity.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
    });

    const csv =
      "addressLine1,city,state,zip,premiseType,ownerEmail,commodityCodes\n" +
      `999 Main St,Springfield,IL,62704,RESIDENTIAL,owner@example.com,${commodity.code}\n`;

    const mapping = {
      addressLine1: "addressLine1",
      city: "city",
      state: "state",
      zip: "zip",
      premiseType: "premiseType",
      ownerEmail: "ownerEmail",
      commodityCodes: "commodityCodes",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "premise" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "p.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("COMPLETE");
    expect(result.importedCount).toBe(1);

    const created = await prisma.premise.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, addressLine1: "999 Main St" },
    });
    expect(created.ownerId).toBe(owner.id);
    expect(created.commodityIds).toEqual([commodity.id]);
    expect(created.state).toBe("IL");
  });

  it("rejects rows whose ownerEmail doesn't match any customer", async () => {
    const csv =
      "addressLine1,city,state,zip,premiseType,ownerEmail\n" +
      "100 Oak Ave,Springfield,IL,62704,RESIDENTIAL,nobody@example.com\n";
    const mapping = {
      addressLine1: "addressLine1",
      city: "city",
      state: "state",
      zip: "zip",
      premiseType: "premiseType",
      ownerEmail: "ownerEmail",
    };
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "premise" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "p.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("FAILED");
    expect(result.errors[0].errorCode).toBe("OWNER_NOT_FOUND");
  });
});

describe("POST /api/v1/imports — meter handler", () => {
  it("imports a meter; resolves premise via (address, zip), commodity by code, UoM by code", async () => {
    const { prisma } = prismaImports;
    // Use the existing fixture premise: addressLine1 "1 Test Lane <suffix>", zip "00000".
    const fixturePremise = await prisma.premise.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, zip: "00000" },
    });
    const commodity = await prisma.commodity.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
    });
    const uom = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, commodityId: commodity.id },
    });

    const csv =
      "meterNumber,premiseAddress,premiseZip,commodityCode,uomCode,meterType,installDate\n" +
      `MTR-IMP-1,${fixturePremise.addressLine1},00000,${commodity.code},${uom.code},MANUAL,2025-01-15\n`;

    const mapping = {
      meterNumber: "meterNumber",
      premiseAddress: "premiseAddress",
      premiseZip: "premiseZip",
      commodityCode: "commodityCode",
      uomCode: "uomCode",
      meterType: "meterType",
      installDate: "installDate",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "m.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("COMPLETE");
    expect(result.importedCount).toBe(1);

    const created = await prisma.meter.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, meterNumber: "MTR-IMP-1" },
    });
    expect(created.premiseId).toBe(fixturePremise.id);
    expect(created.commodityId).toBe(commodity.id);
    expect(created.uomId).toBe(uom.id);
  });

  it("surfaces DUPLICATE_METER when meter_number already exists", async () => {
    const { prisma } = prismaImports;
    const fixturePremise = await prisma.premise.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, zip: "00000" },
    });
    const commodity = await prisma.commodity.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
    });
    const uom = await prisma.unitOfMeasure.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, commodityId: commodity.id },
    });
    // Pre-insert a meter with the same number.
    await prisma.meter.create({
      data: {
        utilityId: fixA.utilityId,
        premiseId: fixturePremise.id,
        commodityId: commodity.id,
        uomId: uom.id,
        meterNumber: "MTR-DUP",
        meterType: "MANUAL",
        status: "ACTIVE",
        installDate: new Date("2024-01-01"),
      },
    });

    const csv =
      "meterNumber,premiseAddress,premiseZip,commodityCode,uomCode,meterType,installDate\n" +
      `MTR-DUP,${fixturePremise.addressLine1},00000,${commodity.code},${uom.code},MANUAL,2025-01-15\n`;
    const mapping = {
      meterNumber: "meterNumber",
      premiseAddress: "premiseAddress",
      premiseZip: "premiseZip",
      commodityCode: "commodityCode",
      uomCode: "uomCode",
      meterType: "meterType",
      installDate: "installDate",
    };
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "meter" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "m.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("FAILED");
    expect(result.errors[0].errorCode).toBe("DUPLICATE_METER");
  });
});

describe("POST /api/v1/imports — account handler", () => {
  it("imports an account; resolves customerEmail to customerId", async () => {
    const { prisma } = prismaImports;
    const customer = await prisma.customer.create({
      data: {
        utilityId: fixA.utilityId,
        customerType: "INDIVIDUAL",
        firstName: "Acct",
        lastName: "Customer",
        email: "acct@example.com",
      },
    });

    const csv =
      "accountNumber,accountType,status,customerEmail\n" +
      "ACC-IMP-1,RESIDENTIAL,ACTIVE,acct@example.com\n";
    const mapping = {
      accountNumber: "accountNumber",
      accountType: "accountType",
      status: "status",
      customerEmail: "customerEmail",
    };
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "account" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "a.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("COMPLETE");
    expect(result.importedCount).toBe(1);

    const created = await prisma.account.findFirstOrThrow({
      where: { utilityId: fixA.utilityId, accountNumber: "ACC-IMP-1" },
    });
    expect(created.customerId).toBe(customer.id);
    expect(created.accountType).toBe("RESIDENTIAL");
  });

  it("surfaces DUPLICATE_ACCOUNT when account_number already exists", async () => {
    // The fixture pre-creates an account with accountNumber=ACCT-<suffix>.
    const { prisma } = prismaImports;
    const existing = await prisma.account.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
    });

    const csv =
      "accountNumber,accountType,status\n" + `${existing.accountNumber},RESIDENTIAL,ACTIVE\n`;
    const mapping = {
      accountNumber: "accountNumber",
      accountType: "accountType",
      status: "status",
    };
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "account" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "a.csv", contentType: "text/csv", body: csv },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { ...headers(), "content-type": contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.body);
    expect(result.status).toBe("FAILED");
    expect(result.errors[0].errorCode).toBe("DUPLICATE_ACCOUNT");
  });
});

describe("processBatch — cancellation", () => {
  it("finalises CANCELLED when cancelRequested is set before the loop runs", async () => {
    const { prisma } = prismaImports;
    // 60 PENDING rows: > PROGRESS_INTERVAL (50) so the cancel check
    // fires after the first chunk.
    const batch = await prisma.importBatch.create({
      data: {
        utilityId: fixA.utilityId,
        entityKind: "meter_read",
        source: "MANUAL_UPLOAD",
        fileName: "cancel.csv",
        recordCount: 60,
        status: "PENDING",
        cancelRequested: true, // pre-flag so the first heartbeat aborts
        createdBy: "00000000-0000-4000-8000-aaaa00000001",
        lastProgressAt: new Date(),
      },
    });
    await prisma.importRow.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        importBatchId: batch.id,
        rowIndex: i + 1,
        rawData: {
          meterNumber,
          readDatetime: `2024-02-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
          reading: String(1000 + i),
        },
        status: "PENDING" as const,
      })),
    });

    const { processBatch } = await import(
      "../../services/imports/process-batch.service.js"
    );
    const result = await processBatch({
      batchId: batch.id,
      utilityId: fixA.utilityId,
      actorId: "00000000-0000-4000-8000-aaaa00000001",
      actorName: "Tester",
      scope: "pending",
    });
    expect(result.status).toBe("CANCELLED");

    const updated = await prisma.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(updated.status).toBe("CANCELLED");
    // Some rows may be IMPORTED (the first 50-row chunk processed
    // before the cancel check fired); the rest stay PENDING.
    expect(updated.importedCount).toBeLessThanOrEqual(50);
  });
});
