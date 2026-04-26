import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration tests for the audit-retention sweep.
 *
 * Verifies:
 *   - Per-tenant retention from tenant_config.scheduler_audit_retention_days
 *   - Only scheduler-emitted audits (source LIKE 'scheduler:%') are deleted
 *   - User audits (source = 'user:<id>' or NULL legacy rows) are preserved
 *   - Multi-tenant: each tenant's threshold applies to its own rows
 *   - Batching: 25k eligible rows are deleted across multiple
 *     batches (10k/batch in the implementation)
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT_A = "00000000-0000-4000-8000-0000000000a8";
const TENANT_B = "00000000-0000-4000-8000-0000000000b8";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/audit-retention.service.js");

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
  process.env.WORKER_QUEUES = "audit-retention";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/audit-retention.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE audit_log, tenant_config RESTART IDENTITY CASCADE
  `);
});

async function seedTenant(utilityId: string, retentionDays: number): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({
    data: { utilityId, schedulerAuditRetentionDays: retentionDays },
  });
}

async function seedAudit(opts: {
  utilityId: string;
  source: string | null;
  daysAgo: number;
  now: Date;
}): Promise<void> {
  const { prisma } = prismaImports;
  const createdAt = new Date(opts.now.getTime() - opts.daysAgo * 86400 * 1000);
  await prisma.auditLog.create({
    data: {
      utilityId: opts.utilityId,
      entityType: "test",
      entityId: "00000000-0000-4000-8000-000000000000",
      action: "UPDATE",
      source: opts.source,
      createdAt,
    },
  });
}

describe("worker-audit-retention integration", () => {
  it("deletes scheduler audits older than the tenant's retention window", async () => {
    const { prisma } = prismaImports;
    const NOW = new Date("2026-04-25T04:00:00Z");
    await seedTenant(TENANT_A, 90); // 90-day retention

    await seedAudit({ utilityId: TENANT_A, source: "scheduler:suspension-transitions", daysAgo: 60, now: NOW });
    await seedAudit({ utilityId: TENANT_A, source: "scheduler:sla-breach-sweep", daysAgo: 100, now: NOW });
    await seedAudit({ utilityId: TENANT_A, source: "scheduler:notification-send", daysAgo: 200, now: NOW });

    const result = await serviceImports.sweepExpiredSchedulerAudits(NOW);

    expect(result.deleted).toBe(2);
    expect(result.timedOut).toBe(false);

    const remaining = await prisma.auditLog.findMany({ where: { utilityId: TENANT_A } });
    expect(remaining).toHaveLength(1);
    // The 60-day-old row stays; the 100/200-day rows are gone.
  });

  it("does not delete user audits even if older than retention", async () => {
    const { prisma } = prismaImports;
    const NOW = new Date("2026-04-25T04:00:00Z");
    await seedTenant(TENANT_A, 90);

    await seedAudit({ utilityId: TENANT_A, source: "user:99999999-9999-4999-8999-999999999001", daysAgo: 500, now: NOW });
    await seedAudit({ utilityId: TENANT_A, source: null, daysAgo: 500, now: NOW }); // legacy row, NULL source

    const result = await serviceImports.sweepExpiredSchedulerAudits(NOW);

    expect(result.deleted).toBe(0);
    const remaining = await prisma.auditLog.count({ where: { utilityId: TENANT_A } });
    expect(remaining).toBe(2);
  });

  it("respects per-tenant retention thresholds independently", async () => {
    const { prisma } = prismaImports;
    const NOW = new Date("2026-04-25T04:00:00Z");
    await seedTenant(TENANT_A, 90); // shorter window
    await seedTenant(TENANT_B, 365); // longer window

    // 100-day-old scheduler audit:
    //   - TENANT_A: past 90-day threshold → deleted
    //   - TENANT_B: under 365-day threshold → kept
    await seedAudit({ utilityId: TENANT_A, source: "scheduler:suspension-transitions", daysAgo: 100, now: NOW });
    await seedAudit({ utilityId: TENANT_B, source: "scheduler:suspension-transitions", daysAgo: 100, now: NOW });

    const result = await serviceImports.sweepExpiredSchedulerAudits(NOW);

    expect(result.deleted).toBe(1);
    const a = await prisma.auditLog.count({ where: { utilityId: TENANT_A } });
    const b = await prisma.auditLog.count({ where: { utilityId: TENANT_B } });
    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it("returns deleted=0 when no rows are eligible", async () => {
    const NOW = new Date("2026-04-25T04:00:00Z");
    await seedTenant(TENANT_A, 90);
    await seedAudit({ utilityId: TENANT_A, source: "scheduler:suspension-transitions", daysAgo: 60, now: NOW });

    const result = await serviceImports.sweepExpiredSchedulerAudits(NOW);

    expect(result).toMatchObject({ deleted: 0, batches: 0, timedOut: false });
  });

  it("batches large deletes (12k rows → 2 batches at 10k each)", async () => {
    const { prisma } = prismaImports;
    const NOW = new Date("2026-04-25T04:00:00Z");
    await seedTenant(TENANT_A, 90);

    // Bulk-insert 12k expired scheduler audits via raw SQL — going
    // through Prisma's create() in a loop would be glacial.
    const expired = new Date(NOW.getTime() - 100 * 86400 * 1000).toISOString();
    await prisma.$executeRawUnsafe(`
      INSERT INTO audit_log (id, utility_id, entity_type, entity_id, action, source, created_at)
      SELECT
        gen_random_uuid(),
        '${TENANT_A}',
        'test',
        '00000000-0000-4000-8000-000000000000',
        'UPDATE',
        'scheduler:suspension-transitions',
        '${expired}'
      FROM generate_series(1, 12000)
    `);

    const result = await serviceImports.sweepExpiredSchedulerAudits(NOW);

    expect(result.deleted).toBe(12_000);
    expect(result.batches).toBe(2); // 10k + 2k = 2 batches
    expect(result.timedOut).toBe(false);

    const remaining = await prisma.auditLog.count();
    expect(remaining).toBe(0);
  }, 60_000);
});
