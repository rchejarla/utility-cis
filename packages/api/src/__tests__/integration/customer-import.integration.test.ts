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
 * Customer kind handler — the second consumer of the import framework.
 * If anything in the framework was implicitly meter-read-shaped, this
 * test surfaces it. Specifically validates:
 *   - the registry dispatches the customer kind
 *   - kind-specific permission gate (customers.CREATE, not meter_reads)
 *   - parseRow's conditional-required logic (INDIVIDUAL needs name,
 *     ORGANIZATION needs organizationName)
 *   - processRow without a prepareBatch step works (unlike meter-reads
 *     which uses prepareBatch for the meter-number map)
 *   - real Customer rows land in the tenant
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
let fixA: TenantFixture;

const ENABLED_MODULES = ["imports", "customers"];

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
  const boundary = `----customer-import-test-${Math.random().toString(36).slice(2)}`;
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
  await prisma.$executeRawUnsafe(
    "TRUNCATE TABLE import_row, import_batch, attachment, customer RESTART IDENTITY CASCADE",
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
});

describe("customer kind — registered alongside meter_read", () => {
  it("appears in GET /imports/kinds", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const kinds = JSON.parse(res.body) as Array<{ kind: string; label: string }>;
    const customer = kinds.find((k) => k.kind === "customer");
    expect(customer).toBeDefined();
    expect(customer?.label).toBe("Customers");
  });

  it("template.csv contains both example rows (one INDIVIDUAL, one ORGANIZATION)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/imports/kinds/customer/template.csv",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("customerType");
    expect(res.body).toContain("INDIVIDUAL");
    expect(res.body).toContain("ORGANIZATION");
  });
});

describe("POST /api/v1/imports — customer happy path", () => {
  it("imports a mix of INDIVIDUAL and ORGANIZATION customers, status COMPLETE, audit emitted", async () => {
    const { prisma } = prismaImports;

    const csv =
      "customer_type,first_name,last_name,organization_name,email\n" +
      "INDIVIDUAL,Jane,Doe,,jane@example.com\n" +
      "INDIVIDUAL,John,Smith,,john@example.com\n" +
      "ORGANIZATION,,,Acme Corp,billing@acme.test\n";

    const mapping = {
      customer_type: "customerType",
      first_name: "firstName",
      last_name: "lastName",
      organization_name: "organizationName",
      email: "email",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "fileName", value: "customers.csv" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "customers.csv", contentType: "text/csv", body: csv },
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
    expect(result.recordCount).toBe(3);
    expect(result.importedCount).toBe(3);
    expect(result.errorCount).toBe(0);

    const customers = await prisma.customer.findMany({
      where: { utilityId: fixA.utilityId },
      orderBy: { createdAt: "asc" },
    });
    expect(customers).toHaveLength(3);

    const jane = customers.find((c) => c.firstName === "Jane");
    expect(jane).toMatchObject({
      customerType: "INDIVIDUAL",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
    });

    const acme = customers.find((c) => c.customerType === "ORGANIZATION");
    expect(acme).toMatchObject({
      customerType: "ORGANIZATION",
      organizationName: "Acme Corp",
      email: "billing@acme.test",
    });

    const audits = await prisma.auditLog.count({
      where: { utilityId: fixA.utilityId, entityType: "Customer" },
    });
    expect(audits).toBe(3);
  });
});

describe("POST /api/v1/imports — customer parse-row validation", () => {
  it("rejects INDIVIDUAL rows with no first_name AND no last_name", async () => {
    const csv =
      "customer_type,first_name,last_name\n" +
      "INDIVIDUAL,,\n" + // both names missing → MISSING_NAME
      "INDIVIDUAL,Jane,Doe\n";

    const mapping = {
      customer_type: "customerType",
      first_name: "firstName",
      last_name: "lastName",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
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

    const result = JSON.parse(res.body);
    expect(result.status).toBe("PARTIAL");
    expect(result.importedCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.errors[0].errorCode).toBe("MISSING_NAME");
    expect(result.errors[0].rowIndex).toBe(1);
  });

  it("rejects ORGANIZATION rows with no organization_name", async () => {
    const csv =
      "customer_type,organization_name\n" +
      "ORGANIZATION,\n" +
      "ORGANIZATION,Acme\n";

    const mapping = {
      customer_type: "customerType",
      organization_name: "organizationName",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
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

    const result = JSON.parse(res.body);
    expect(result.status).toBe("PARTIAL");
    expect(result.errors[0].errorCode).toBe("MISSING_ORGANIZATION_NAME");
  });

  it("rejects unknown customer types", async () => {
    const csv = "customer_type,first_name,last_name\nROBOT,R2,D2\n";
    const mapping = {
      customer_type: "customerType",
      first_name: "firstName",
      last_name: "lastName",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
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

    const result = JSON.parse(res.body);
    expect(result.status).toBe("FAILED");
    expect(result.errors[0].errorCode).toBe("INVALID_CUSTOMER_TYPE");
  });

  it("rejects malformed email addresses", async () => {
    const csv =
      "customer_type,first_name,last_name,email\n" +
      "INDIVIDUAL,Jane,Doe,not-an-email\n";
    const mapping = {
      customer_type: "customerType",
      first_name: "firstName",
      last_name: "lastName",
      email: "email",
    };

    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
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

    const result = JSON.parse(res.body);
    expect(result.status).toBe("FAILED");
    expect(result.errors[0].errorCode).toBe("INVALID_EMAIL");
  });
});

describe("POST /api/v1/imports — customer permission gate", () => {
  it("requires customers.CREATE specifically (not meter_reads.CREATE)", async () => {
    const { prisma } = prismaImports;

    // Set up a role that has meter_reads.CREATE but NOT customers.CREATE.
    const roleRow = await prisma.role.create({
      data: {
        utilityId: fixA.utilityId,
        name: "Meter-Reads-Only",
        description: "Test",
        permissions: { meter_reads: ["VIEW", "CREATE"], imports: ["VIEW"] },
      },
    });

    const userId = "00000000-0000-4000-8000-bbbb00000002";
    await prisma.cisUser.create({
      data: {
        utilityId: fixA.utilityId,
        id: userId,
        email: "scoped@example.com",
        name: "Scoped User",
        isActive: true,
      },
    });
    await prisma.userRole.create({
      data: { utilityId: fixA.utilityId, userId, accountId: null, roleId: roleRow.id },
    });

    const csv = "customer_type,first_name,last_name\nINDIVIDUAL,Jane,Doe\n";
    const mapping = {
      customer_type: "customerType",
      first_name: "firstName",
      last_name: "lastName",
    };

    const scopedToken = makeToken(TENANT_A, userId);
    const { body, contentType } = buildMultipart([
      { name: "kind", value: "customer" },
      { name: "source", value: "MANUAL_UPLOAD" },
      { name: "mapping", value: JSON.stringify(mapping) },
      { name: "file", filename: "x.csv", contentType: "text/csv", body: csv },
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/imports",
      headers: { authorization: `Bearer ${scopedToken}`, "content-type": contentType },
      payload: body,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });
});
