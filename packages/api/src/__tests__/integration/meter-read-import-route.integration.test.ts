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
 * The import enqueue is a side effect here, never the subject, so it stops
 * at the mock; otherwise a run on a machine with the dev Redis up leaves
 * jobs behind that the platform console lists as stuck work.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

/**
 * A reading system's file carries the route its numbers were collected
 * on. The meter_read importer resolves that code to a `read_route` row:
 * a code we already hold as EXTERNAL is reused, a code nobody has seen
 * becomes a new EXTERNAL route, and a code that names a route *we*
 * maintain (LOCAL) is refused, so a vendor file cannot write reads onto
 * an itinerary that is ours (design §5.4).
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;
let meterNumber: string;
let meter2Number: string;

const ENABLED_MODULES = ["imports", "meter_reads", "meters", "agreements"];

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
    | { name: string; filename: string; contentType: string; body: string }
  >,
): { body: Buffer; contentType: string } {
  const boundary = `----route-import-test-${Math.random().toString(36).slice(2)}`;
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
      segments.push(Buffer.from(part.body));
      segments.push(Buffer.from("\r\n"));
    } else {
      segments.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      segments.push(Buffer.from(part.value));
      segments.push(Buffer.from("\r\n"));
    }
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(segments), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function postCsv(csv: string, withRoute: boolean) {
  const mapping: Record<string, string> = {
    meter_number: "meterNumber",
    read_datetime: "readDatetime",
    reading: "reading",
  };
  if (withRoute) mapping.route = "routeCode";
  const { body, contentType } = buildMultipart([
    { name: "kind", value: "meter_read" },
    { name: "source", value: "MANUAL_UPLOAD" },
    { name: "fileName", value: "reads.csv" },
    { name: "mapping", value: JSON.stringify(mapping) },
    { name: "file", filename: "reads.csv", contentType: "text/csv", body: csv },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/imports",
    headers: { ...headers(), "content-type": contentType },
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as {
    status: string;
    importedCount: number;
    errorCount: number;
    errors: Array<{ rowIndex: number; errorCode: string; errorMessage: string }>;
  };
}

const WITH_ROUTE = "meter_number,read_datetime,reading,route\n";

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
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    const { prisma } = prismaImports;
    await resetDb();
    await truncateTables("import_row, import_batch, attachment, in_app_notification");
    await ensurePrincipal(prisma, TENANT_A);
    fixA = await makeTenantFixture(prisma, TENANT_A);

    for (const moduleKey of ENABLED_MODULES) {
      await prisma.utilityModule.create({ data: { utilityId: fixA.utilityId, moduleKey } });
    }
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(fixA.utilityId);

    // An agreement with both fixture meters installed, so a read resolves.
    const sa = await prisma.serviceAgreement.create({
      data: {
        utilityId: fixA.utilityId,
        agreementNumber: "SA-ROUTE",
        accountId: fixA.accountId,
        commodityId: fixA.commodityId,
        startDate: new Date("2024-01-01"),
        status: "ACTIVE",
      },
    });
    const sp = await prisma.servicePoint.create({
      data: {
        utilityId: fixA.utilityId,
        serviceAgreementId: sa.id,
        premiseId: fixA.premiseId,
        type: "METERED",
        status: "ACTIVE",
        startDate: new Date("2024-01-01"),
      },
    });
    await prisma.servicePointMeter.createMany({
      data: [fixA.meterId, fixA.meterId2].map((meterId) => ({
        utilityId: fixA.utilityId,
        servicePointId: sp.id,
        meterId,
        addedDate: new Date("2024-01-01"),
      })),
    });
    const meters = await prisma.meter.findMany({
      where: { utilityId: fixA.utilityId },
      select: { id: true, meterNumber: true },
    });
    meterNumber = meters.find((m) => m.id === fixA.meterId)!.meterNumber;
    meter2Number = meters.find((m) => m.id === fixA.meterId2)!.meterNumber;
  }),
);

describe("meter_read import — routeCode", () => {
  it("writes route_id for a known EXTERNAL route code", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const route = await prisma.readRoute.create({
        data: {
          utilityId: fixA.utilityId,
          code: "W-04",
          name: "Vendor W-04",
          billingCycleId: fixA.billingCycleId,
          origin: "EXTERNAL",
        },
      });

      const result = await postCsv(
        WITH_ROUTE + `${meterNumber},2024-02-01T09:00:00Z,100,W-04\n`,
        true,
      );
      expect(result).toMatchObject({ status: "COMPLETE", importedCount: 1, errorCount: 0 });

      const reads = await prisma.meterRead.findMany({ where: { utilityId: fixA.utilityId } });
      expect(reads).toHaveLength(1);
      expect(reads[0]!.routeId).toBe(route.id);
      // Reused, not duplicated. Breaks if a known code is re-inserted.
      expect(await prisma.readRoute.count({ where: { utilityId: fixA.utilityId } })).toBe(1);
    }));

  it("creates one EXTERNAL route for a code nobody has seen, however many rows name it", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const result = await postCsv(
        WITH_ROUTE +
          `${meterNumber},2024-02-01T09:00:00Z,100,NEW-9\n` +
          `${meter2Number},2024-02-01T09:05:00Z,55,NEW-9\n`,
        true,
      );
      expect(result).toMatchObject({ status: "COMPLETE", importedCount: 2, errorCount: 0 });

      const routes = await prisma.readRoute.findMany({ where: { utilityId: fixA.utilityId } });
      expect(routes).toHaveLength(1);
      // Takes the cycle of the account the first row belongs to.
      expect(routes[0]).toMatchObject({
        code: "NEW-9",
        origin: "EXTERNAL",
        billingCycleId: fixA.billingCycleId,
      });
      expect(await prisma.readRouteStop.count({ where: { readRouteId: routes[0]!.id } })).toBe(0);

      const reads = await prisma.meterRead.findMany({ where: { utilityId: fixA.utilityId } });
      expect(reads).toHaveLength(2);
      expect(reads.every((r) => r.routeId === routes[0]!.id)).toBe(true);
    }));

  it("reuses that route on the next import of the same code", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      await postCsv(WITH_ROUTE + `${meterNumber},2024-02-01T09:00:00Z,100,NEW-9\n`, true);
      const second = await postCsv(
        WITH_ROUTE + `${meterNumber},2024-03-01T09:00:00Z,140,NEW-9\n`,
        true,
      );
      expect(second).toMatchObject({ importedCount: 1, errorCount: 0 });

      // Breaks if each import inserts its own row (or the second fails on
      // the unique key).
      const routes = await prisma.readRoute.findMany({ where: { utilityId: fixA.utilityId } });
      expect(routes).toHaveLength(1);
      const reads = await prisma.meterRead.findMany({ where: { utilityId: fixA.utilityId } });
      expect(reads).toHaveLength(2);
      expect(reads.every((r) => r.routeId === routes[0]!.id)).toBe(true);
    }));

  it("leaves route_id null when the file has no route column", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;

      const result = await postCsv(
        "meter_number,read_datetime,reading\n" + `${meterNumber},2024-02-01T09:00:00Z,100\n`,
        false,
      );
      expect(result).toMatchObject({ importedCount: 1, errorCount: 0 });

      const reads = await prisma.meterRead.findMany({ where: { utilityId: fixA.utilityId } });
      expect(reads).toHaveLength(1);
      expect(reads[0]!.routeId).toBeNull();
      expect(await prisma.readRoute.count({ where: { utilityId: fixA.utilityId } })).toBe(0);
    }));

  it("rejects a row whose route code names a LOCAL route, and only that row", () =>
    seedAsPlatform(async () => {
      const { prisma } = prismaImports;
      const local = await prisma.readRoute.create({
        data: {
          utilityId: fixA.utilityId,
          code: "OURS-1",
          name: "Our own route",
          billingCycleId: fixA.billingCycleId,
          origin: "LOCAL",
        },
      });

      // Row 1 (rowIndex is 1-based) is a clean row except for the route code. Row 2 is the same
      // shape with no route, proving the file itself is importable; so a
      // rejection of row 1 can only be about the route.
      const result = await postCsv(
        WITH_ROUTE +
          `${meterNumber},2024-02-01T09:00:00Z,100,OURS-1\n` +
          `${meter2Number},2024-02-01T09:05:00Z,55,\n`,
        true,
      );
      expect(result.importedCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ rowIndex: 1, errorCode: "ROUTE_IS_LOCAL" });

      // Nothing was written onto our itinerary, and it stayed ours.
      const reads = await prisma.meterRead.findMany({ where: { utilityId: fixA.utilityId } });
      expect(reads).toHaveLength(1);
      expect(reads[0]!.meterId).toBe(fixA.meterId2);
      expect(reads[0]!.routeId).toBeNull();
      const after = await prisma.readRoute.findUniqueOrThrow({ where: { id: local.id } });
      expect(after.origin).toBe("LOCAL");
    }));
});
