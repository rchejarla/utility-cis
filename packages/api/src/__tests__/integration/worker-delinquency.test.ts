import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration tests for the delinquency dispatcher (pattern #2 — fan-out).
 *
 * Verifies eligibility logic, priority assignment, deterministic
 * idempotency keys, and missed-tick recovery. The per-tenant
 * evaluation logic itself is already covered by existing service
 * tests (delinquency.service.test.ts); this file exercises the
 * dispatcher's decision matrix.
 *
 * What we don't bother re-testing here: the consumer worker actually
 * processing the enqueued jobs. The consumer is a thin wrapper over
 * evaluateDelinquencyForTenant, which has its own unit tests, and
 * the BullMQ queue plumbing is already exercised in
 * worker-suspension.test.ts. Spinning up a worker just to drain the
 * queue would be redundant.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT_A = "00000000-0000-4000-8000-0000000000d1";
const TENANT_B = "00000000-0000-4000-8000-0000000000d2";
const TENANT_C = "00000000-0000-4000-8000-0000000000d3";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let dispatcherImports: typeof import("../../workers/delinquency-dispatcher.js");
let queueImports: typeof import("../../lib/queues.js");

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
  process.env.WORKER_QUEUES = "delinquency-dispatch,delinquency-tenant";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  dispatcherImports = await import("../../workers/delinquency-dispatcher.js");
  queueImports = await import("../../lib/queues.js");
}, 180_000);

afterAll(async () => {
  await queueImports?.closeAllQueues().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE delinquency_action, delinquency_rule, account, customer, tenant_config RESTART IDENTITY CASCADE
  `);
  // Obliterate the per-tenant queue between tests so jobs from prior
  // cases don't leak forward AND idempotency-key markers don't
  // suppress legitimate re-enqueues. `drain(true)` only removes
  // waiting/delayed; obliterate clears everything including job
  // metadata.
  const queue = queueImports.getQueue(queueImports.QUEUE_NAMES.delinquencyTenant);
  await queue.obliterate({ force: true });
});

interface SeedTenantOpts {
  delinquencyEnabled?: boolean;
  timezone?: string;
  runHourLocal?: number;
  lastRunAt?: Date | null;
  accountCount?: number;
}

async function seedTenant(utilityId: string, opts: SeedTenantOpts = {}): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({
    data: {
      utilityId,
      delinquencyEnabled: opts.delinquencyEnabled ?? true,
      timezone: opts.timezone ?? "UTC",
      delinquencyRunHourLocal: opts.runHourLocal ?? 3,
      delinquencyLastRunAt: opts.lastRunAt ?? null,
    },
  });

  const accountCount = opts.accountCount ?? 1;
  if (accountCount > 0) {
    const customer = await prisma.customer.create({
      data: { utilityId, customerType: "INDIVIDUAL", firstName: "Test", lastName: "Customer" },
    });
    const data = Array.from({ length: accountCount }).map((_, i) => ({
      utilityId,
      accountNumber: `ACC-${utilityId.slice(-4)}-${i}`,
      customerId: customer.id,
      accountType: "RESIDENTIAL" as const,
      status: "ACTIVE" as const,
    }));
    await prisma.account.createMany({ data });
  }
}

async function getEnqueuedJobs(): Promise<Array<{ id: string; data: Record<string, unknown>; opts: Record<string, unknown> }>> {
  const queue = queueImports.getQueue(queueImports.QUEUE_NAMES.delinquencyTenant);
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "prioritized"]);
  return jobs.map((j) => ({
    id: j.id ?? "",
    data: j.data,
    opts: j.opts,
  }));
}

describe("dispatchDelinquency", () => {
  it("enqueues only tenants whose local hour matches delinquencyRunHourLocal", async () => {
    // 2026-04-25T03:00:00Z. UTC tenant with run hour 3 → matches.
    // UTC tenant with run hour 8 → doesn't match.
    await seedTenant(TENANT_A, { timezone: "UTC", runHourLocal: 3 });
    await seedTenant(TENANT_B, { timezone: "UTC", runHourLocal: 8 });

    const result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-04-25T03:00:00Z"),
    );
    expect(result.enqueued).toBe(1);
    expect(result.reasons.onSchedule).toBe(1);
    expect(result.reasons.missedRecovery).toBe(0);

    const jobs = await getEnqueuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.utilityId).toBe(TENANT_A);
    expect(jobs[0].data.reason).toBe("onSchedule");
  });

  it("skips tenants with delinquencyEnabled=false", async () => {
    await seedTenant(TENANT_A, { delinquencyEnabled: false, runHourLocal: 3 });

    const result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-04-25T03:00:00Z"),
    );
    expect(result.candidatesConsidered).toBe(0);
    expect(result.enqueued).toBe(0);
  });

  it("respects tenant timezone (NY 03:00 = UTC 07:00 in EDT)", async () => {
    await seedTenant(TENANT_A, { timezone: "America/New_York", runHourLocal: 3 });

    // 03:00 UTC = 23:00 NY (previous day) — does not match.
    let result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-07-26T03:00:00Z"),
    );
    expect(result.enqueued).toBe(0);

    // 07:00 UTC = 03:00 NY EDT — matches.
    result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-07-26T07:00:00Z"),
    );
    expect(result.enqueued).toBe(1);
  });

  it("missed-tick recovery: enqueues even off-schedule when lastRunAt > 23h ago", async () => {
    // Tenant configured to run at 03:00, but today is 15:00. Normally
    // wouldn't fire. But lastRunAt was 30 hours ago — recovery.
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      runHourLocal: 3,
      lastRunAt: new Date("2026-04-23T15:00:00Z"),
    });

    const result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-04-25T15:00:00Z"),
    );
    expect(result.enqueued).toBe(1);
    expect(result.reasons.missedRecovery).toBe(1);

    const jobs = await getEnqueuedJobs();
    expect(jobs[0].data.reason).toBe("missedRecovery");
  });

  it("missed-tick recovery: a tenant that ran 22 hours ago does NOT fire off-schedule", async () => {
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      runHourLocal: 3,
      lastRunAt: new Date("2026-04-24T17:00:00Z"), // 22h ago from "now" below
    });

    const result = await dispatcherImports.dispatchDelinquency(
      new Date("2026-04-25T15:00:00Z"),
    );
    expect(result.enqueued).toBe(0);
  });

  it("assigns priorities by tenant size (small=1, medium=2, large=3)", async () => {
    // Three tenants, all on-schedule at 03:00 UTC. Account counts:
    // TENANT_A: 5 (small → priority 1)
    // TENANT_B: 1500 (medium → priority 2)
    // TENANT_C: 15000 (large → priority 3)
    await seedTenant(TENANT_A, { runHourLocal: 3, accountCount: 5 });
    await seedTenant(TENANT_B, { runHourLocal: 3, accountCount: 1500 });
    await seedTenant(TENANT_C, { runHourLocal: 3, accountCount: 15_000 });

    await dispatcherImports.dispatchDelinquency(new Date("2026-04-25T03:00:00Z"));

    const jobs = await getEnqueuedJobs();
    const byTenant = new Map(jobs.map((j) => [j.data.utilityId as string, j.opts.priority as number]));
    expect(byTenant.get(TENANT_A)).toBe(1);
    expect(byTenant.get(TENANT_B)).toBe(2);
    expect(byTenant.get(TENANT_C)).toBe(3);
  }, 30_000);

  it("idempotency: dispatching twice within the same hour does not double-enqueue", async () => {
    await seedTenant(TENANT_A, { runHourLocal: 3, accountCount: 5 });

    await dispatcherImports.dispatchDelinquency(new Date("2026-04-25T03:00:00Z"));
    await dispatcherImports.dispatchDelinquency(new Date("2026-04-25T03:00:30Z"));

    const jobs = await getEnqueuedJobs();
    expect(jobs).toHaveLength(1);
  });

  it("idempotency keys differ across hours so a separate hour's tick enqueues again", async () => {
    await seedTenant(TENANT_A, { runHourLocal: 3, accountCount: 5 });
    await seedTenant(TENANT_A.replace(/d1$/, "e1"), { runHourLocal: 4, accountCount: 5 });

    await dispatcherImports.dispatchDelinquency(new Date("2026-04-25T03:00:00Z"));
    await dispatcherImports.dispatchDelinquency(new Date("2026-04-25T04:00:00Z"));

    const jobs = await getEnqueuedJobs();
    expect(jobs).toHaveLength(2);
    const ids = jobs.map((j) => j.id);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
