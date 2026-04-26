import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration tests for the SLA breach sweep.
 *
 * Verifies the atomic UPDATE-RETURNING + auditLog.createMany pattern
 * against a real Postgres + Redis. The sweep is one cross-tenant
 * SQL statement; per-row audit lands in the same transaction so the
 * SR detail timeline shows the breach event.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT_A = "00000000-0000-4000-8000-0000000000a5";
const TENANT_B = "00000000-0000-4000-8000-0000000000b5";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/service-request.service.js");

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();

  const dbUrl = pgContainer.getConnectionUri();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";
  process.env.WORKER_QUEUES = "sla-breach-sweep";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/service-request.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_log,
      service_request,
      service_request_counter,
      service_agreement,
      account,
      premise,
      customer,
      rate_schedule,
      commodity,
      billing_cycle,
      tenant_config
    RESTART IDENTITY CASCADE
  `);
});

async function seedTenant(utilityId: string, opts: { slaBreachSweepEnabled?: boolean } = {}): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({
    data: { utilityId, slaBreachSweepEnabled: opts.slaBreachSweepEnabled ?? true },
  });
}

async function seedAccount(utilityId: string): Promise<{ accountId: string }> {
  const { prisma } = prismaImports;
  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Test", lastName: "Customer" },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: `ACC-${utilityId.slice(-4)}-${Math.random().toString(36).slice(2, 8)}`,
      customerId: customer.id,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
    },
  });
  return { accountId: account.id };
}

async function seedServiceRequest(opts: {
  utilityId: string;
  accountId: string;
  status?: "NEW" | "ASSIGNED" | "IN_PROGRESS" | "PENDING_FIELD" | "COMPLETED" | "CANCELLED";
  slaDueAt: Date | null;
  slaBreached?: boolean;
}): Promise<{ id: string; requestNumber: string }> {
  const { prisma } = prismaImports;
  const seq = Math.floor(Math.random() * 1_000_000);
  const requestNumber = `SR-2026-${String(seq).padStart(6, "0")}`;
  const row = await prisma.serviceRequest.create({
    data: {
      utilityId: opts.utilityId,
      requestNumber,
      accountId: opts.accountId,
      requestType: "OTHER",
      status: opts.status ?? "NEW",
      priority: "NORMAL",
      source: "CSR",
      description: "test",
      slaDueAt: opts.slaDueAt,
      slaBreached: opts.slaBreached ?? false,
    },
    select: { id: true, requestNumber: true },
  });
  return row;
}

describe("worker-sla-breach integration", () => {
  it("flips an open SR whose sla_due_at has passed", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const { accountId } = await seedAccount(TENANT_A);
    const sr = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "IN_PROGRESS",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(1);
    const after = await prisma.serviceRequest.findUnique({ where: { id: sr.id } });
    expect(after?.slaBreached).toBe(true);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "service_request", entityId: sr.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].source).toBe("scheduler:sla-breach-sweep");
    expect(audits[0].afterState).toMatchObject({ slaBreached: true });
  });

  it("does not flip COMPLETED or CANCELLED SRs even if past due", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const { accountId } = await seedAccount(TENANT_A);
    const completed = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "COMPLETED",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
    });
    const cancelled = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "CANCELLED",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(0);
    const c = await prisma.serviceRequest.findUnique({ where: { id: completed.id } });
    const x = await prisma.serviceRequest.findUnique({ where: { id: cancelled.id } });
    expect(c?.slaBreached).toBe(false);
    expect(x?.slaBreached).toBe(false);
  });

  it("does not flip SRs whose sla_due_at is still in the future", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const { accountId } = await seedAccount(TENANT_A);
    const sr = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "IN_PROGRESS",
      slaDueAt: new Date("2026-04-26T00:00:00Z"),
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(0);
    const after = await prisma.serviceRequest.findUnique({ where: { id: sr.id } });
    expect(after?.slaBreached).toBe(false);
  });

  it("does not flip SRs that are already breached (idempotency)", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const { accountId } = await seedAccount(TENANT_A);
    const sr = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "IN_PROGRESS",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
      slaBreached: true,
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(0);
    const audits = await prisma.auditLog.count({
      where: { entityType: "service_request", entityId: sr.id },
    });
    expect(audits).toBe(0);
  });

  it("respects sla_breach_sweep_enabled = false on the tenant_config join", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, { slaBreachSweepEnabled: false });
    const { accountId } = await seedAccount(TENANT_A);
    const sr = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "IN_PROGRESS",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(0);
    const after = await prisma.serviceRequest.findUnique({ where: { id: sr.id } });
    expect(after?.slaBreached).toBe(false);
  });

  it("processes multiple tenants in one sweep", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
    const a = await seedAccount(TENANT_A);
    const b = await seedAccount(TENANT_B);
    await seedServiceRequest({
      utilityId: TENANT_A,
      accountId: a.accountId,
      status: "IN_PROGRESS",
      slaDueAt: new Date("2026-04-24T00:00:00Z"),
    });
    await seedServiceRequest({
      utilityId: TENANT_B,
      accountId: b.accountId,
      status: "NEW",
      slaDueAt: new Date("2026-04-23T00:00:00Z"),
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));
    expect(result.flipped).toBe(2);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "service_request" },
    });
    expect(audits).toHaveLength(2);
    expect(new Set(audits.map((a) => a.utilityId))).toEqual(new Set([TENANT_A, TENANT_B]));
  });

  it("does not touch SRs with NULL sla_due_at (no SLA configured)", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const { accountId } = await seedAccount(TENANT_A);
    const sr = await seedServiceRequest({
      utilityId: TENANT_A,
      accountId,
      status: "IN_PROGRESS",
      slaDueAt: null,
    });

    const result = await serviceImports.sweepBreachedSRs(new Date("2026-04-25T12:00:00Z"));

    expect(result.flipped).toBe(0);
    const after = await prisma.serviceRequest.findUnique({ where: { id: sr.id } });
    expect(after?.slaBreached).toBe(false);
  });
});
