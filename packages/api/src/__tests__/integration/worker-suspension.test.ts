import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Production-grade integration test for the suspension migration.
 *
 * Boots ephemeral Postgres + Redis containers, applies the real
 * Prisma migrations against the Postgres, then exercises the full
 * BullMQ pipeline:
 *   enqueue `transition-suspensions` job
 *   → BullMQ Worker pulls it
 *   → handler calls sweepSuspensionsAllTenants
 *   → cross-tenant UPDATE RETURNING + auditLog.createMany
 *   → assert DB state.
 *
 * Crucially, this test treats the worker process the same way prod
 * does: real Redis, real Postgres, real Prisma client, real
 * BullMQ Queue + Worker. Mocks are forbidden here.
 *
 * Each scenario runs against fresh data (TRUNCATE tables in
 * `beforeEach`) but reuses the containers across the suite so we
 * pay startup cost once.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT_A = "00000000-0000-4000-8000-0000000000aa";
const TENANT_B = "00000000-0000-4000-8000-0000000000bb";
const SA_A = "00000000-0000-4000-8000-00000000a001";
const SA_B = "00000000-0000-4000-8000-00000000b001";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let queueImports: typeof import("../../lib/queues.js");
let workerImports: typeof import("../../workers/suspension-worker.js");

beforeAll(async () => {
  // ─── Start containers ────────────────────────────────────────────
  // Postgres image MUST include TimescaleDB — production schema has
  // a hypertable on meter_read and the migration setup expects the
  // extension to be available. Stock `postgres:16` images don't ship
  // with it. Match the prod minor version (16) so schema features
  // behave identically. No persistent volume; containers torn down
  // in afterAll.
  pgContainer = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();

  const dbUrl = pgContainer.getConnectionUri();
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;

  // ─── Prepare env BEFORE importing modules ────────────────────────
  // config.ts reads process.env at import time; we need test URLs in
  // place so the singleton prisma client and queueRedisConnection
  // pick them up. NODE_ENV=test relaxes some prod-only behaviors
  // (notably, queueRedis allows offline queue during testcontainer
  // boot windows).
  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error"; // keep test output quiet
  process.env.WORKER_QUEUES = "suspension-transitions";
  process.env.DISABLE_SCHEDULERS = "false";

  // ─── Apply migrations against the test DB ────────────────────────
  // `prisma migrate deploy` is the production-correct command (no
  // shadow DB, no schema diffs, just apply the on-disk migrations).
  // Skip seed — tests own their own data setup.
  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  // ─── Late-import modules so they pick up the env we just set ─────
  prismaImports = await import("../../lib/prisma.js");
  queueImports = await import("../../lib/queues.js");
  workerImports = await import("../../workers/suspension-worker.js");
}, 180_000);

afterAll(async () => {
  await queueImports?.closeAllQueues().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  // Reset state between scenarios. CASCADE handles the FK chain so we
  // don't need to enumerate every dependent table; listing the roots
  // is enough.
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_log,
      service_suspension,
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

async function seedTenant(utilityId: string, opts: { suspensionEnabled?: boolean; requireHoldApproval?: boolean } = {}): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({
    data: {
      utilityId,
      requireHoldApproval: opts.requireHoldApproval ?? false,
      suspensionEnabled: opts.suspensionEnabled ?? true,
    },
  });
}

/**
 * Insert the minimum-viable parent chain for a ServiceAgreement so
 * a ServiceSuspension's FK can be satisfied. Creates one customer,
 * account, premise, commodity, rate schedule, billing cycle, and
 * service agreement — all under the supplied tenant. Idempotent on
 * `agreementId` if you reuse one across calls (returns existing).
 *
 * Production-grade rationale: tests should exercise real data
 * shapes (FKs intact, NOT NULL constraints satisfied) rather than
 * disable constraints to make the test pass. The helper is verbose
 * but keeps the test scenarios themselves terse.
 */
async function seedAgreementChain(utilityId: string, agreementId: string): Promise<void> {
  const { prisma } = prismaImports;
  // Skip work if the agreement already exists.
  const existing = await prisma.serviceAgreement.findUnique({ where: { id: agreementId } });
  if (existing) return;

  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Test", lastName: "Customer" },
  });
  // Use the LAST 8 chars of the agreement ID for uniqueness — the
  // first 8 are shared between our test SA constants (which all start
  // with "00000000-..."), which would collide on the unique
  // (utility_id, account_number) constraint.
  const idSuffix = agreementId.slice(-8);
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: `ACC-${idSuffix}`,
      customerId: customer.id,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
    },
  });
  const premise = await prisma.premise.create({
    data: {
      utilityId,
      addressLine1: "123 Test St",
      city: "Testville",
      state: "TS",
      zip: "12345",
      premiseType: "RESIDENTIAL",
      commodityIds: [],
      ownerId: customer.id,
    },
  });
  const commodity = await prisma.commodity.create({
    data: { utilityId, code: `C-${agreementId.slice(-4)}`, name: "Test Commodity" },
  });
  const rateSchedule = await prisma.rateSchedule.create({
    data: {
      utilityId,
      name: "Test Rate",
      code: `R-${agreementId.slice(-4)}`,
      commodityId: commodity.id,
      rateType: "FLAT",
      effectiveDate: new Date("2026-01-01"),
      rateConfig: { baseCharge: 0 },
    },
  });
  const billingCycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Test Cycle",
      cycleCode: `BC-${agreementId.slice(-4)}`,
      readDayOfMonth: 1,
      billDayOfMonth: 5,
    },
  });
  const sa = await prisma.serviceAgreement.create({
    data: {
      id: agreementId,
      utilityId,
      agreementNumber: `SA-${agreementId.slice(-8)}`,
      accountId: account.id,
      commodityId: commodity.id,
      rateScheduleId: rateSchedule.id,
      billingCycleId: billingCycle.id,
      startDate: new Date("2026-01-01"),
      status: "ACTIVE",
    },
  });
  await prisma.servicePoint.create({
    data: {
      utilityId,
      serviceAgreementId: sa.id,
      premiseId: premise.id,
      type: "METERED",
      status: "ACTIVE",
      startDate: new Date("2026-01-01"),
    },
  });
}

async function seedSuspension(opts: {
  utilityId: string;
  serviceAgreementId: string;
  status: "PENDING" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  startDate: Date;
  endDate: Date | null;
  approvedBy?: string | null;
}): Promise<{ id: string }> {
  const { prisma } = prismaImports;
  await seedAgreementChain(opts.utilityId, opts.serviceAgreementId);
  const row = await prisma.serviceSuspension.create({
    data: {
      utilityId: opts.utilityId,
      serviceAgreementId: opts.serviceAgreementId,
      suspensionType: "TEST",
      status: opts.status,
      startDate: opts.startDate,
      endDate: opts.endDate,
      approvedBy: opts.approvedBy ?? null,
    },
    select: { id: true },
  });
  return row;
}

describe("worker-suspension integration", () => {
  it("flips PENDING → ACTIVE for an enabled tenant whose start date has passed", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A, { suspensionEnabled: true });
    const hold = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"), // past
      endDate: null,
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result).toEqual({ activated: 1, completed: 0 });

    const after = await prisma.serviceSuspension.findUnique({ where: { id: hold.id } });
    expect(after?.status).toBe("ACTIVE");

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "service_suspension", entityId: hold.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBeNull();
    expect(audits[0].source).toBe("scheduler:suspension-transitions");
    expect(audits[0].beforeState).toMatchObject({ status: "PENDING" });
    expect(audits[0].afterState).toMatchObject({ status: "ACTIVE" });
  });

  it("flips ACTIVE → COMPLETED when end date has passed", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A);
    const hold = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "ACTIVE",
      startDate: new Date("2026-04-20T00:00:00Z"),
      endDate: new Date("2026-04-24T00:00:00Z"), // past
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result).toEqual({ activated: 0, completed: 1 });

    const after = await prisma.serviceSuspension.findUnique({ where: { id: hold.id } });
    expect(after?.status).toBe("COMPLETED");

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "service_suspension", entityId: hold.id },
    });
    expect(audits[0].afterState).toMatchObject({ status: "COMPLETED" });
  });

  it("does not touch open-ended ACTIVE holds (endDate IS NULL)", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A);
    const hold = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "ACTIVE",
      startDate: new Date("2026-04-20T00:00:00Z"),
      endDate: null, // open-ended; requires manual completion
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result.completed).toBe(0);
    const after = await prisma.serviceSuspension.findUnique({ where: { id: hold.id } });
    expect(after?.status).toBe("ACTIVE");
  });

  it("respects suspension_enabled = false on the tenant_config join", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A, { suspensionEnabled: false });
    const hold = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result).toEqual({ activated: 0, completed: 0 });
    const after = await prisma.serviceSuspension.findUnique({ where: { id: hold.id } });
    expect(after?.status).toBe("PENDING");

    const audits = await prisma.auditLog.findMany({
      where: { entityType: "service_suspension" },
    });
    expect(audits).toHaveLength(0);
  });

  it("respects require_hold_approval — only approved PENDING holds activate", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    const APPROVER = "00000000-0000-4000-8000-0000000000ee";
    await seedTenant(TENANT_A, { requireHoldApproval: true });
    const approved = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
      approvedBy: APPROVER,
    });
    const unapproved = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_B,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
      approvedBy: null,
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result.activated).toBe(1);
    const approvedAfter = await prisma.serviceSuspension.findUnique({ where: { id: approved.id } });
    const unapprovedAfter = await prisma.serviceSuspension.findUnique({ where: { id: unapproved.id } });
    expect(approvedAfter?.status).toBe("ACTIVE");
    expect(unapprovedAfter?.status).toBe("PENDING");
  });

  it("processes multiple tenants in one sweep", async () => {
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
    await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
    });
    await seedSuspension({
      utilityId: TENANT_B,
      serviceAgreementId: SA_B,
      status: "ACTIVE",
      startDate: new Date("2026-04-20T00:00:00Z"),
      endDate: new Date("2026-04-24T00:00:00Z"),
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));

    expect(result).toEqual({ activated: 1, completed: 1 });

    const audits = await prisma.auditLog.findMany({ where: { entityType: "service_suspension" } });
    expect(audits).toHaveLength(2);
    const utilityIds = new Set(audits.map((a) => a.utilityId));
    expect(utilityIds).toEqual(new Set([TENANT_A, TENANT_B]));
  });

  it("end-to-end: enqueue -> Worker -> DB state asserted", async () => {
    const { prisma } = prismaImports;
    const { getQueue, QUEUE_NAMES } = queueImports;
    const { buildSuspensionWorker, SUSPENSION_JOB_NAME } = workerImports;

    await seedTenant(TENANT_A);
    const hold = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
    });

    const worker = buildSuspensionWorker();

    try {
      const queue = getQueue(QUEUE_NAMES.suspensionTransitions);
      const job = await queue.add(SUSPENSION_JOB_NAME, {});

      // Wait for the job to complete. BullMQ's job.waitUntilFinished
      // resolves when the job succeeds or rejects when it fails — the
      // canonical way to assert end-to-end pipeline behavior.
      const queueEvents = (await import("bullmq")).QueueEvents;
      const events = new queueEvents(QUEUE_NAMES.suspensionTransitions, {
        connection: (await import("../../lib/queue-redis.js")).queueRedisConnection.duplicate(),
      });
      await events.waitUntilReady();
      try {
        await job.waitUntilFinished(events, 30_000);
      } finally {
        await events.close();
      }

      const after = await prisma.serviceSuspension.findUnique({ where: { id: hold.id } });
      expect(after?.status).toBe("ACTIVE");

      const audits = await prisma.auditLog.findMany({
        where: { entityType: "service_suspension", entityId: hold.id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].source).toBe("scheduler:suspension-transitions");
    } finally {
      await worker.close();
    }
  });

  it("atomicity — audit and suspension status flip together (single transaction)", async () => {
    // Atomicity at the Prisma+Postgres level is guaranteed when the
    // mutation and audit write happen inside the same `$transaction`
    // call (verified by the unit test). What this integration test
    // adds: end-to-end proof that for every flipped suspension row
    // there is exactly one corresponding audit_log row, no orphans
    // either way. If the transaction were ever split, partial
    // application would leave a row count mismatch.
    const { prisma } = prismaImports;
    const { sweepSuspensionsAllTenants } = await import(
      "../../services/service-suspension.service.js"
    );

    await seedTenant(TENANT_A);
    await seedTenant(TENANT_B);
    // Three holds across two tenants: 1 activation + 2 completions.
    const a1 = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_A,
      status: "PENDING",
      startDate: new Date("2026-04-24T00:00:00Z"),
      endDate: null,
    });
    const a2 = await seedSuspension({
      utilityId: TENANT_A,
      serviceAgreementId: SA_B,
      status: "ACTIVE",
      startDate: new Date("2026-04-20T00:00:00Z"),
      endDate: new Date("2026-04-24T00:00:00Z"),
    });
    const SA_T = "00000000-0000-4000-8000-00000000c001";
    const b1 = await seedSuspension({
      utilityId: TENANT_B,
      serviceAgreementId: SA_T,
      status: "ACTIVE",
      startDate: new Date("2026-04-20T00:00:00Z"),
      endDate: new Date("2026-04-24T00:00:00Z"),
    });

    const result = await sweepSuspensionsAllTenants(new Date("2026-04-25T12:00:00Z"));
    expect(result).toEqual({ activated: 1, completed: 2 });

    // For every flipped row, there is exactly one audit row keyed by
    // its id; no extras, no missing. This is the visible signature
    // of the atomic UPDATE-RETURNING + createMany pattern.
    for (const id of [a1.id, a2.id, b1.id]) {
      const audits = await prisma.auditLog.findMany({
        where: { entityType: "service_suspension", entityId: id },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].source).toBe("scheduler:suspension-transitions");
    }

    // No stray audits for entities that didn't flip.
    const allAudits = await prisma.auditLog.count({
      where: { entityType: "service_suspension" },
    });
    expect(allAudits).toBe(3);
  });
});
