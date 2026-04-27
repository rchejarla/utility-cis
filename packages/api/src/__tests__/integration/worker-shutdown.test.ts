import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Graceful-shutdown integration test for the BullMQ worker process.
 *
 * Verifies the close-with-timeout drain pattern from `worker.ts:shutdown`:
 *   - Enqueue a job whose handler intentionally sleeps a few seconds.
 *   - Call `Worker.close()` while the job is in flight.
 *   - Assert close() returns (within the spec's 60s budget — a passing
 *     test happens within ~5s).
 *   - Assert the in-flight job completed (its side effect is visible).
 *   - Assert no further jobs are processed after close() returns.
 *
 * This test does NOT spawn a child process. It exercises the underlying
 * BullMQ Worker.close() that the SIGTERM handler in worker.ts triggers.
 * Spawning subprocesses adds complexity (separate Prisma client,
 * subprocess output capture) without changing what's verified.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let queueImports: typeof import("../../lib/queues.js");
let bullmq: typeof import("bullmq");
let connection: typeof import("../../lib/queue-redis.js");

beforeAll(async () => {
  // Postgres comes along for the ride — `lib/prisma.ts` and a few
  // imported modules construct PrismaClient at import time and fail
  // loudly without a reachable DB. We don't actually use it for
  // shutdown testing.
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

  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  // Apply migrations so any imported module that does a connection
  // probe at import time doesn't blow up.
  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  queueImports = await import("../../lib/queues.js");
  bullmq = await import("bullmq");
  connection = await import("../../lib/queue-redis.js");
}, 180_000);

afterAll(async () => {
  await queueImports?.closeAllQueues().catch(() => {});
  await connection?.queueRedisConnection.quit().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("worker graceful shutdown", () => {
  it("drains an in-flight job before close() returns", async () => {
    const queueName = "shutdown-test-drain";
    const queue = new bullmq.Queue(queueName, {
      connection: connection.queueRedisConnection,
    });
    let jobStartedAt: number | null = null;
    let jobCompletedAt: number | null = null;

    const worker = new bullmq.Worker(
      queueName,
      async () => {
        jobStartedAt = Date.now();
        // Simulate a non-trivial job that takes a couple of seconds.
        // The shutdown path must wait for this to complete before
        // returning, not abort it mid-way.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        jobCompletedAt = Date.now();
        return { ok: true };
      },
      {
        connection: connection.queueRedisConnection,
        concurrency: 1,
      },
    );

    // Wait for the worker to be ready before enqueueing.
    await worker.waitUntilReady();

    await queue.add("slow-task", { payload: "hello" });

    // Spin until the job has clearly started, then trigger close.
    // 5-second cap so a hung worker doesn't hang the whole test.
    const startWaitDeadline = Date.now() + 5000;
    while (jobStartedAt === null && Date.now() < startWaitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(jobStartedAt).not.toBeNull();

    const closeStarted = Date.now();
    await worker.close();
    const closeDuration = Date.now() - closeStarted;

    // Close should have waited for the in-flight job. The job sleeps
    // 2s; the close call started after the job had been running for
    // an unknown short interval. Total close duration ≥ remaining job
    // time, ≤ the 60s spec budget. We assert a generous middle.
    expect(closeDuration).toBeGreaterThan(500);
    expect(closeDuration).toBeLessThan(10_000);
    expect(jobCompletedAt).not.toBeNull();
    // The job finished BEFORE close returned; not after.
    expect(jobCompletedAt!).toBeLessThanOrEqual(closeStarted + closeDuration);

    await queue.close();
  }, 30_000);

  it("does not process newly-enqueued jobs after close()", async () => {
    const queueName = "shutdown-test-no-new-jobs";
    const queue = new bullmq.Queue(queueName, {
      connection: connection.queueRedisConnection,
    });
    let processedCount = 0;

    const worker = new bullmq.Worker(
      queueName,
      async () => {
        processedCount += 1;
      },
      {
        connection: connection.queueRedisConnection,
        concurrency: 1,
      },
    );

    await worker.waitUntilReady();
    await worker.close();

    // After close, enqueueing should still succeed (queue itself is
    // still open — close acts on the Worker, not the Queue) but the
    // worker should not pick the job up.
    await queue.add("post-close", { payload: "ignored" });
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(processedCount).toBe(0);

    // Manual cleanup — the job is still pending in Redis.
    await queue.obliterate({ force: true });
    await queue.close();
  }, 15_000);
});
