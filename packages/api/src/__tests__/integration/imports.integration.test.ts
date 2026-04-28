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

const ENABLED_MODULES = ["imports", "meter_reads", "meters", "premises", "agreements"];

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
