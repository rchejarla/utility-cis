import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Real-DB integration test for service-request routes. The global
 * vitest.setup.ts mocks `../lib/prisma.js` so every other suite uses a
 * synthetic Prisma. This suite re-mocks the module with `importActual`
 * so we talk to the real database — required because the service-request
 * lifecycle spans audited writes, counter allocation, SLA resolution,
 * and enum-driven transitions that aren't tractable to mock.
 */
vi.mock("../../lib/prisma.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/prisma.js")>(
    "../../lib/prisma.js",
  );
  return actual;
});

// Keep the global redis mock; RBAC reads from cacheGet which will miss
// and fall through to the DB. Reset the cache helpers to explicit misses
// for this suite so stale cached roles from prior suites don't leak in.
vi.mock("../../lib/redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// Import after vi.mock declarations so the real prisma is wired in.
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

const UID = "00000000-0000-4000-8000-000000000001"; // dev tenant
const CSR_SUB = "99999999-9999-4999-8999-999999999001"; // no CisUser row — backward-compat pass-through
const PORTAL_SUB = "99999999-9999-4999-8999-999999999002"; // seeded below with Portal Customer role

let app: FastifyInstance;

async function setTenantSession() {
  await prisma.$executeRawUnsafe(
    `SELECT set_config('app.current_utility_id', '${UID}', true)`,
  );
}

beforeAll(async () => {
  app = await createTestApp();
  await app.ready();

  await setTenantSession();

  // Enable the service_requests module for the dev tenant (Task 15 will
  // do this globally; Task 14 needs it locally for the integration test).
  await prisma.tenantModule.upsert({
    where: { utilityId_moduleKey: { utilityId: UID, moduleKey: "service_requests" } },
    update: { isEnabled: true },
    create: { utilityId: UID, moduleKey: "service_requests", isEnabled: true },
  });

  // Ensure the two global type-def codes the tests use exist. skipDuplicates
  // keeps this idempotent across test runs.
  await prisma.serviceRequestTypeDef.createMany({
    data: [
      { code: "LEAK_REPORT", label: "Leak Report" },
      { code: "OTHER", label: "Other" },
    ],
    skipDuplicates: true,
  });

  // Create a CisUser bound to the Portal Customer role so the
  // portal-denial test hits the FORBIDDEN branch (role present but no
  // service_requests:VIEW permission), rather than the backward-compat
  // pass-through.
  const portalRole = await prisma.role.findFirst({
    where: { utilityId: UID, name: "Portal Customer" },
  });
  if (portalRole) {
    await prisma.cisUser.upsert({
      where: { id: PORTAL_SUB },
      update: {},
      create: {
        id: PORTAL_SUB,
        utilityId: UID,
        email: "portal-integration@test.com",
        name: "Portal Integration Test",
        roleId: portalRole.id,
        isActive: true,
      },
    });
  }

  // Create a CSR CisUser so the FK on service_request.created_by resolves.
  // Grant the CSR role service_requests permissions (Task 15 will overwrite
  // with the full preset, but we need them now for this integration test).
  const csrRole = await prisma.role.findFirst({
    where: { utilityId: UID, name: "CSR" },
  });
  if (csrRole) {
    const perms =
      (csrRole.permissions as Record<string, string[] | undefined>) ?? {};
    perms.service_requests = ["VIEW", "CREATE", "EDIT"];
    await prisma.role.update({
      where: { id: csrRole.id },
      data: { permissions: perms },
    });
    await prisma.cisUser.upsert({
      where: { id: CSR_SUB },
      update: { roleId: csrRole.id, isActive: true },
      create: {
        id: CSR_SUB,
        utilityId: UID,
        email: "csr-integration@test.com",
        name: "CSR Integration Test",
        roleId: csrRole.id,
        isActive: true,
      },
    });
  }
});

afterAll(async () => {
  await app.close();
});

function csrToken() {
  return createTestToken({
    sub: CSR_SUB,
    utility_id: UID,
    role: "CSR",
    email: "csr@test.com",
  });
}

function portalToken() {
  return createTestToken({
    sub: PORTAL_SUB,
    utility_id: UID,
    role: "Portal Customer",
    email: "portal-integration@test.com",
  });
}

describe("service-requests routes (integration)", () => {
  beforeEach(async () => {
    await setTenantSession();
    // RLS may still filter rows — that's OK, the first test creates fresh
    // rows and later tests don't depend on cross-run isolation.
    await prisma.serviceRequest.deleteMany({ where: { utilityId: UID } });
  });

  it("creates -> lists -> assigns -> transitions -> completes a request", async () => {
    const headers = { authorization: `Bearer ${csrToken()}` };

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/service-requests",
      headers,
      payload: {
        requestType: "LEAK_REPORT",
        priority: "HIGH",
        description: "pipe leak near meter",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.requestNumber).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(created.status).toBe("NEW");

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(
      listRes.json().data.some((r: { id: string }) => r.id === created.id),
    ).toBe(true);

    // NEW -> ASSIGNED via /assign auto-transition
    const assignRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/assign`,
      headers,
      payload: { assignedTeam: "Field Ops" },
    });
    expect(assignRes.statusCode).toBe(200);
    expect(assignRes.json().status).toBe("ASSIGNED");

    // ASSIGNED -> IN_PROGRESS
    const inProgressRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/transition`,
      headers,
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(inProgressRes.statusCode).toBe(200);
    expect(inProgressRes.json().status).toBe("IN_PROGRESS");

    // Complete
    const completeRes = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${created.id}/complete`,
      headers,
      payload: { resolutionNotes: "Fixed the leak, no further action." },
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().status).toBe("COMPLETED");
  });

  it("rejects invalid status transitions with 409", async () => {
    const headers = { authorization: `Bearer ${csrToken()}` };

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/service-requests",
      headers,
      payload: { requestType: "OTHER", priority: "LOW", description: "x" },
    });
    const { id } = createRes.json();
    // NEW -> IN_PROGRESS is invalid (must go through ASSIGNED).
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/service-requests/${id}/transition`,
      headers,
      payload: { toStatus: "IN_PROGRESS" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("denies portal customers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/service-requests",
      headers: { authorization: `Bearer ${portalToken()}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
