import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
  endAdminPool,
} from "./_effective-dating-fixtures.js";

/**
 * Nothing this file does reaches Redis — see the note in
 * `customer-import.integration.test.ts`. The enqueue is a side effect
 * here, never the subject, so it stops at the mock and the tests behave
 * the same way on a machine with the dev Redis up as on one without.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * Service-agreement kind handler — the sixth consumer of the import
 * framework, and the one spec 28 names as a prerequisite for mirroring
 * a legacy CIS (OVL-IN-4).
 *
 * It is also the first handler that writes **more than one row per
 * source row**: an agreement is meaningless without the service point
 * that places it at a premise, and the overlay needs the rate code the
 * legacy CIS billed it under. So one CSV line can produce a
 * ServiceAgreement, a ServicePoint, a ServicePointMeter and an
 * SAScheduleAssignment — all in the framework's per-row transaction, so
 * a half-built agreement cannot survive a failure.
 *
 * What this file pins, beyond "rows land":
 *   - the four-way resolution (account, commodity, premise, meter) and a
 *     distinct error code for each miss, because an operator fixing a
 *     file needs to know which column was wrong
 *   - `METER_ALREADY_ASSIGNED`, which is rule 1 of
 *     `createServiceAgreement` — the import must not be a way around a
 *     business rule the API enforces
 *   - a generated agreement number when the column is blank, so a bulk
 *     load that has no legacy numbers still works
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

/** Codes the fixture generates from the tenant's uuid suffix. */
let commodityCode: string;
let accountNumber: string;
let premiseAddress: string;
let premiseZip: string;
let meterNumber: string;
let rateScheduleCode: string;

const ENABLED_MODULES = ["imports", "agreements"];

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

function buildMultipart(
  parts: Array<
    | { name: string; value: string }
    | { name: string; filename: string; contentType: string; body: string | Buffer }
  >,
): { body: Buffer; contentType: string } {
  const boundary = `----sa-import-test-${Math.random().toString(36).slice(2)}`;
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
      segments.push(typeof part.body === "string" ? Buffer.from(part.body) : part.body);
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

/** The canonical header line every test in this file posts. */
const HEADER =
  "agreement_number,account_number,commodity_code,premise_address,premise_zip," +
  "start_date,status,meter_number,rate_schedule_code\n";

const MAPPING = {
  agreement_number: "agreementNumber",
  account_number: "accountNumber",
  commodity_code: "commodityCode",
  premise_address: "premiseAddress",
  premise_zip: "premiseZip",
  start_date: "startDate",
  status: "status",
  meter_number: "meterNumber",
  rate_schedule_code: "rateScheduleCode",
};

async function postCsv(csv: string) {
  const { body, contentType } = buildMultipart([
    { name: "kind", value: "service_agreement" },
    { name: "source", value: "MANUAL_UPLOAD" },
    { name: "fileName", value: "agreements.csv" },
    { name: "mapping", value: JSON.stringify(MAPPING) },
    { name: "file", filename: "agreements.csv", contentType: "text/csv", body: csv },
  ]);
  return app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { ...headers(), "content-type": contentType },
    payload: body,
  });
}

/**
 * Row errors as (rowIndex, code) pairs, so an assertion reads as the
 * operator's view of their file: which line, and which column was wrong.
 */
function codesOf(result: {
  errors: Array<{ rowIndex: number; errorCode: string }>;
}): Array<{ rowIndex: number; code: string }> {
  return result.errors.map((e) => ({ rowIndex: e.rowIndex, code: e.errorCode }));
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  // `$disconnect` does not dispose a pool the application owns — that is
  // the driver-adapter contract — so the pools are ended here.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("import_row, import_batch, attachment, sa_rate_schedule_assignment");
    await ensurePrincipal(prisma, TENANT_A);

    fixA = await makeTenantFixture(prisma, TENANT_A);

    for (const moduleKey of ENABLED_MODULES) {
      await prisma.utilityModule.create({
        data: { utilityId: fixA.utilityId, moduleKey },
      });
    }

    // Read the codes back rather than reconstructing the fixture's
    // suffix arithmetic — a change to the fixture should not quietly
    // make every CSV in this file name rows that do not exist.
    const commodity = await prisma.commodity.findUniqueOrThrow({
      where: { id: fixA.commodityId },
      select: { code: true },
    });
    commodityCode = commodity.code;
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: fixA.accountId },
      select: { accountNumber: true },
    });
    accountNumber = account.accountNumber;
    const premise = await prisma.premise.findUniqueOrThrow({
      where: { id: fixA.premiseId },
      select: { addressLine1: true, zip: true },
    });
    premiseAddress = premise.addressLine1;
    premiseZip = premise.zip;
    const meter = await prisma.meter.findUniqueOrThrow({
      where: { id: fixA.meterId },
      select: { meterNumber: true },
    });
    meterNumber = meter.meterNumber;
    const schedule = await prisma.rateSchedule.findFirstOrThrow({
      where: { utilityId: fixA.utilityId },
      select: { id: true, code: true },
    });
    rateScheduleCode = schedule.code;
    /*
     * **The fixture leaves its schedule unpublished**, and a draft is
     * not a tariff anything may bill on: `bill-segment.service` refuses
     * one with a null `publishedAt`, so an assignment to it is a
     * configuration that looks complete and fails hours later inside a
     * run. Publishing it here is what makes the happy path below an
     * assertion about a billable assignment rather than a row count.
     */
    await prisma.rateSchedule.update({
      where: { id: schedule.id },
      data: { publishedAt: new Date("2025-01-01T00:00:00.000Z") },
    });

    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(fixA.utilityId);
  }),
);

describe("service_agreement kind — registration and template", () => {
  it("appears in GET /imports/kinds", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const kinds = JSON.parse(res.body) as Array<{ kind: string; label: string }>;
    const sa = kinds.find((k) => k.kind === "service_agreement");
    expect(sa).toBeDefined();
    expect(sa?.label).toBe("Service agreements");
  });

  it("template.csv names every column the handler resolves on", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds/service_agreement/template.csv",
    });
    expect(res.statusCode).toBe(200);
    for (const col of [
      "accountNumber",
      "commodityCode",
      "premiseAddress",
      "premiseZip",
      "startDate",
      "meterNumber",
      "rateScheduleCode",
    ]) {
      expect(res.body).toContain(col);
    }
  });
});

describe("POST /api/v1/imports — service_agreement happy path", () => {
  it("creates the agreement, its service point, the meter install and the rate assignment", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const csv =
        HEADER +
        `SA-IMP-1,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},` +
        `2026-01-01,ACTIVE,${meterNumber},${rateScheduleCode}\n` +
        // Second row: no meter, no rate code — both optional, and an
        // agreement that has neither is still a valid agreement.
        `SA-IMP-2,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},` +
        `2026-02-01,PENDING,,\n`;

      const res = await postCsv(csv);
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.status).toBe("COMPLETE");
      expect(result.recordCount).toBe(2);
      expect(result.importedCount).toBe(2);
      expect(result.errorCount).toBe(0);

      const agreements = await prisma.serviceAgreement.findMany({
        where: { utilityId: fixA.utilityId },
        orderBy: { agreementNumber: "asc" },
        include: { servicePoints: { include: { meters: true } }, rateScheduleAssignments: true },
      });
      expect(agreements).toHaveLength(2);

      const first = agreements[0];
      expect(first).toMatchObject({
        agreementNumber: "SA-IMP-1",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        status: "ACTIVE",
      });
      expect(first.startDate.toISOString().slice(0, 10)).toBe("2026-01-01");

      // One service point, at the premise the CSV named, mirroring the
      // agreement's status.
      expect(first.servicePoints).toHaveLength(1);
      expect(first.servicePoints[0]).toMatchObject({
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
      });
      expect(first.servicePoints[0].meters).toHaveLength(1);
      expect(first.servicePoints[0].meters[0].meterId).toBe(fixA.meterId);

      expect(first.rateScheduleAssignments).toHaveLength(1);
      expect(first.rateScheduleAssignments[0]).toMatchObject({ roleCode: "primary" });

      // The second row's agreement exists with a service point and
      // nothing attached to it.
      const second = agreements[1];
      expect(second.status).toBe("PENDING");
      expect(second.servicePoints).toHaveLength(1);
      expect(second.servicePoints[0].status).toBe("PENDING");
      expect(second.servicePoints[0].meters).toHaveLength(0);
      expect(second.rateScheduleAssignments).toHaveLength(0);

      // Audit: one row per agreement, which is what makes a bulk load
      // answerable in the history the rest of the system keeps.
      const audits = await prisma.auditLog.findMany({
        where: { utilityId: fixA.utilityId, entityType: "ServiceAgreement" },
      });
      expect(audits).toHaveLength(2);
      expect(audits.every((a) => a.actorName === "Tester")).toBe(true);
    }), 120_000);

  it("generates an agreement number when the column is blank", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const csv =
        HEADER +
        `,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-03-01,PENDING,,\n`;

      const res = await postCsv(csv);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).importedCount).toBe(1);

      const sa = await prisma.serviceAgreement.findFirstOrThrow({
        where: { utilityId: fixA.utilityId },
      });
      // The tenant template's default, from `createServiceAgreement`.
      expect(sa.agreementNumber).toMatch(/^SA-\d{4}$/);
    }), 120_000);
});

describe("POST /api/v1/imports — an unmetered service", () => {
  it("creates a NON_BADGED service point for stormwater, with no meter", () =>
    seedAsPlatform(async () => {
      /*
       * Stormwater has no device: it is priced from premise attributes,
       * so its service point is NON_BADGED. The handler hardcoded
       * METERED, following `createServiceAgreement`, which is right for
       * water and simply false here — every imported stormwater
       * agreement got a metered point with nothing metering it.
       */
      const { prisma } = prismaImports;
      const header =
        "agreement_number,account_number,commodity_code,premise_address,premise_zip," +
        "start_date,status,service_point_type\n";
      const mapping = {
        agreement_number: "agreementNumber",
        account_number: "accountNumber",
        commodity_code: "commodityCode",
        premise_address: "premiseAddress",
        premise_zip: "premiseZip",
        start_date: "startDate",
        status: "status",
        service_point_type: "servicePointType",
      };
      const csv =
        header +
        `SA-SW-1,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,NON_BADGED\n` +
        // Blank still means METERED, so nothing already loading water
        // agreements changes behaviour.
        `SA-SW-2,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-02-01,ACTIVE,\n`;

      const { body, contentType } = buildMultipart([
        { name: "kind", value: "service_agreement" },
        { name: "source", value: "MANUAL_UPLOAD" },
        { name: "fileName", value: "stormwater.csv" },
        { name: "mapping", value: JSON.stringify(mapping) },
        { name: "file", filename: "stormwater.csv", contentType: "text/csv", body: csv },
      ]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports",
        headers: { ...headers(), "content-type": contentType },
        payload: body,
      });

      const result = JSON.parse(res.body);
      expect(result.errorCount).toBe(0);
      expect(result.importedCount).toBe(2);

      const points = await prisma.servicePoint.findMany({
        where: { utilityId: fixA.utilityId },
        include: { serviceAgreement: { select: { agreementNumber: true } }, meters: true },
        orderBy: { startDate: "asc" },
      });
      expect(points).toHaveLength(2);
      expect(points[0]).toMatchObject({ type: "NON_BADGED" });
      expect(points[0].meters).toHaveLength(0);
      expect(points[1]).toMatchObject({ type: "METERED" });
    }), 120_000);
});

describe("POST /api/v1/imports — service_agreement row errors", () => {
  it("names the column that missed: account, commodity, premise and meter each get their own code", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const csv =
        HEADER +
        `SA-E-1,NO-SUCH-ACCOUNT,${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,\n` +
        `SA-E-2,${accountNumber},NO-SUCH-COMMODITY,${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,\n` +
        `SA-E-3,${accountNumber},${commodityCode},9 Nowhere St,99999,2026-01-01,ACTIVE,,\n` +
        `SA-E-4,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,NO-SUCH-METER,\n` +
        `SA-E-5,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,NO-SUCH-RATE\n`;

      const res = await postCsv(csv);
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.status).toBe("FAILED");
      expect(result.errorCount).toBe(5);
      expect(result.importedCount).toBe(0);

      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "ACCOUNT_NOT_FOUND" },
        { rowIndex: 2, code: "COMMODITY_NOT_FOUND" },
        { rowIndex: 3, code: "PREMISE_NOT_FOUND" },
        { rowIndex: 4, code: "METER_NOT_FOUND" },
        { rowIndex: 5, code: "RATE_SCHEDULE_NOT_FOUND" },
      ]);

      // Nothing partial survived: a failed row leaves no service point
      // behind, which is the framework's per-row transaction doing its
      // job through a handler that writes four tables.
      expect(
        await prisma.serviceAgreement.count({ where: { utilityId: fixA.utilityId } }),
      ).toBe(0);
      expect(await prisma.servicePoint.count({ where: { utilityId: fixA.utilityId } })).toBe(0);
    }), 120_000);

  it("refuses a second agreement for a meter already installed on an active one", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      // An agreement already holding the meter, created the way the API
      // creates one: agreement → service point → install.
      const existing = await prisma.serviceAgreement.create({
        data: {
          utilityId: fixA.utilityId,
          agreementNumber: "SA-EXISTING",
          accountId: fixA.accountId,
          commodityId: fixA.commodityId,
          startDate: new Date("2025-01-01"),
          status: "ACTIVE",
        },
      });
      const sp = await prisma.servicePoint.create({
        data: {
          utilityId: fixA.utilityId,
          serviceAgreementId: existing.id,
          premiseId: fixA.premiseId,
          type: "METERED",
          status: "ACTIVE",
          startDate: new Date("2025-01-01"),
        },
      });
      await prisma.servicePointMeter.create({
        data: {
          utilityId: fixA.utilityId,
          servicePointId: sp.id,
          meterId: fixA.meterId,
          addedDate: new Date("2025-01-01"),
        },
      });

      const csv =
        HEADER +
        `SA-DUP-METER,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},` +
        `2026-01-01,ACTIVE,${meterNumber},\n`;

      const res = await postCsv(csv);
      expect(res.statusCode).toBe(200);
      const result = JSON.parse(res.body);
      expect(result.errorCount).toBe(1);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "METER_ALREADY_ASSIGNED" },
      ]);

      // The import is not a way around rule 1: the new agreement does
      // not exist at all.
      expect(
        await prisma.serviceAgreement.count({
          where: { utilityId: fixA.utilityId, agreementNumber: "SA-DUP-METER" },
        }),
      ).toBe(0);
    }), 120_000);

  it("reports a re-sent file as duplicates rather than overwriting", () =>
    seedAsPlatform(async () => {
      const csv =
        HEADER +
        `SA-TWICE,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,PENDING,,\n`;

      expect(JSON.parse((await postCsv(csv)).body).importedCount).toBe(1);

      const second = JSON.parse((await postCsv(csv)).body);
      expect(second.errorCount).toBe(1);
      expect(codesOf(second)).toEqual([
        { rowIndex: 1, code: "DUPLICATE_AGREEMENT" },
      ]);
    }), 120_000);

  it("records an ambiguous premise rather than guessing between two", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      // A second premise at the same address and zip. Nothing stops
      // this: the address is not unique, and a legacy export routinely
      // carries duplicates.
      await prisma.premise.create({
        data: {
          utilityId: fixA.utilityId,
          addressLine1: premiseAddress,
          city: "Testville",
          state: "TS",
          zip: premiseZip,
          premiseType: "RESIDENTIAL",
          commodityIds: [fixA.commodityId],
          status: "ACTIVE",
        },
      });

      const csv =
        HEADER +
        `SA-AMB,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,PENDING,,\n`;

      const res = await postCsv(csv);
      const result = JSON.parse(res.body);
      expect(result.errorCount).toBe(1);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "PREMISE_AMBIGUOUS" },
      ]);
    }), 120_000);

  it("refuses a rate code that exists only as a draft", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      /*
       * The two mistakes `assign-rate-schedule-dialog` was built to
       * prevent are assigning a draft and assigning a superseded
       * version, "because both mistakes are silent when made and
       * surface much later inside a billing run" (spec 05). The dialog
       * carries both guards; `createSAScheduleAssignment` carries
       * neither. An import that resolved a code to whatever row it found
       * would be the loosest path of the three, and the one that runs
       * unattended over thousands of rows.
       */
      await prisma.rateSchedule.create({
        data: {
          utilityId: fixA.utilityId,
          name: "Draft tariff",
          code: "DRAFT-ONLY",
          commodityId: fixA.commodityId,
          effectiveDate: new Date("2026-01-01"),
          version: 1,
          // publishedAt left null — this is what a draft is.
        },
      });

      const csv =
        HEADER +
        `SA-DRAFT,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,DRAFT-ONLY\n`;

      const result = JSON.parse((await postCsv(csv)).body);
      expect(result.errorCount).toBe(1);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "RATE_SCHEDULE_NOT_PUBLISHED" },
      ]);
      expect(
        await prisma.sAScheduleAssignment.count({ where: { utilityId: fixA.utilityId } }),
      ).toBe(0);
    }), 120_000);

  it("refuses a code mid-revision, when the published version is superseded and its successor is a draft", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      // `reviseRateSchedule` supersedes the predecessor immediately and
      // leaves the revision a draft, so between revise and publish a
      // code has no version that may bill. The honest answer is to say
      // so, not to pick one of the two.
      const v1 = await prisma.rateSchedule.create({
        data: {
          utilityId: fixA.utilityId,
          name: "Mid-revision tariff",
          code: "MID-REV",
          commodityId: fixA.commodityId,
          effectiveDate: new Date("2025-01-01"),
          version: 1,
          publishedAt: new Date("2025-01-01T00:00:00.000Z"),
        },
      });
      const v2 = await prisma.rateSchedule.create({
        data: {
          utilityId: fixA.utilityId,
          name: "Mid-revision tariff",
          code: "MID-REV",
          commodityId: fixA.commodityId,
          effectiveDate: new Date("2026-01-01"),
          version: 2,
          supersedesId: v1.id,
        },
      });
      await prisma.rateSchedule.update({
        where: { id: v1.id },
        data: { supersededById: v2.id, expirationDate: new Date("2026-01-01") },
      });

      const csv =
        HEADER +
        `SA-MID,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,MID-REV\n`;

      const result = JSON.parse((await postCsv(csv)).body);
      expect(result.errorCount).toBe(1);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "RATE_SCHEDULE_NOT_PUBLISHED" },
      ]);
    }), 120_000);

  it("assigns the current version of a revised code, not the superseded one", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const v1 = await prisma.rateSchedule.create({
        data: {
          utilityId: fixA.utilityId,
          name: "Revised tariff",
          code: "REVISED",
          commodityId: fixA.commodityId,
          effectiveDate: new Date("2025-01-01"),
          version: 1,
          publishedAt: new Date("2025-01-01T00:00:00.000Z"),
        },
      });
      const v2 = await prisma.rateSchedule.create({
        data: {
          utilityId: fixA.utilityId,
          name: "Revised tariff",
          code: "REVISED",
          commodityId: fixA.commodityId,
          effectiveDate: new Date("2026-01-01"),
          version: 2,
          supersedesId: v1.id,
          publishedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });
      await prisma.rateSchedule.update({
        where: { id: v1.id },
        data: { supersededById: v2.id, expirationDate: new Date("2026-01-01") },
      });

      const csv =
        HEADER +
        `SA-REV,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,REVISED\n`;

      const result = JSON.parse((await postCsv(csv)).body);
      expect(result.errorCount).toBe(0);
      expect(result.importedCount).toBe(1);

      const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
        where: { utilityId: fixA.utilityId },
      });
      expect(assignment.rateScheduleId).toBe(v2.id);
    }), 120_000);

  it("rejects a service point type the enum does not have", () =>
    seedAsPlatform(async () => {
      const header =
        "agreement_number,account_number,commodity_code,premise_address,premise_zip," +
        "start_date,service_point_type\n";
      const mapping = {
        agreement_number: "agreementNumber",
        account_number: "accountNumber",
        commodity_code: "commodityCode",
        premise_address: "premiseAddress",
        premise_zip: "premiseZip",
        start_date: "startDate",
        service_point_type: "servicePointType",
      };
      const csv =
        header +
        `SA-BADTYPE,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,UNMETERED\n`;

      const { body, contentType } = buildMultipart([
        { name: "kind", value: "service_agreement" },
        { name: "source", value: "MANUAL_UPLOAD" },
        { name: "fileName", value: "agreements.csv" },
        { name: "mapping", value: JSON.stringify(mapping) },
        { name: "file", filename: "agreements.csv", contentType: "text/csv", body: csv },
      ]);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/imports",
        headers: { ...headers(), "content-type": contentType },
        payload: body,
      });

      const result = JSON.parse(res.body);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "INVALID_SERVICE_POINT_TYPE" },
      ]);
    }), 120_000);

  it("rejects a bad date and an unknown status in parseRow, before any lookup", () =>
    seedAsPlatform(async () => {
      const csv =
        HEADER +
        `SA-P-1,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},not-a-date,ACTIVE,,\n` +
        `SA-P-2,${accountNumber},${commodityCode},${premiseAddress},${premiseZip},2026-01-01,SORT-OF,,\n` +
        `SA-P-3,,${commodityCode},${premiseAddress},${premiseZip},2026-01-01,ACTIVE,,\n`;

      const res = await postCsv(csv);
      const result = JSON.parse(res.body);
      expect(result.errorCount).toBe(3);
      expect(codesOf(result)).toEqual([
        { rowIndex: 1, code: "INVALID_START_DATE" },
        { rowIndex: 2, code: "INVALID_STATUS" },
        { rowIndex: 3, code: "MISSING_ACCOUNT_NUMBER" },
      ]);
    }), 120_000);
});
