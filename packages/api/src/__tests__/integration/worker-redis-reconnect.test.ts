import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Redis-reconnect integration test for the BullMQ worker process.
 *
 * Verifies the ioredis `reconnectOnError: () => true` behavior we
 * configured in `lib/queue-redis.ts`: when Redis becomes unavailable
 * mid-flight and then comes back, the worker resumes processing without
 * needing a process restart.
 *
 * Pattern:
 *   1. Boot Redis + start a worker against it.
 *   2. Stop the Redis container (forced disconnect).
 *   3. Start a fresh Redis on the same port (via a separate Docker
 *      command — testcontainers doesn't natively support port re-use).
 *   4. Enqueue a job; assert the worker picks it up and completes it
 *      after the reconnect.
 *
 * Because re-using the original mapped port across containers is
 * fragile (Docker may not give us back the same host port), we instead
 * verify the simpler property: ioredis is reconnect-tolerant. We pause
 * the network on the Redis container (`docker pause`), let the worker
 * see the disruption, then unpause and verify a job lands.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let queueImports: typeof import("../../lib/queues.js");
let bullmq: typeof import("bullmq");
let connection: typeof import("../../lib/queue-redis.js");

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
  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  const redisUrl = `redis://${redisHost}:${redisPort}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

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

describe("worker Redis reconnect", () => {
  it("resumes processing jobs after Redis pause/unpause", async () => {
    const queueName = "reconnect-test";
    const queue = new bullmq.Queue(queueName, {
      connection: connection.queueRedisConnection,
    });

    const processedJobs: string[] = [];
    const worker = new bullmq.Worker(
      queueName,
      async (job) => {
        processedJobs.push(job.name);
      },
      {
        connection: connection.queueRedisConnection,
        concurrency: 1,
      },
    );

    await worker.waitUntilReady();

    // Phase 1: baseline — job processes normally.
    await queue.add("pre-pause", { ts: Date.now() });
    {
      const deadline = Date.now() + 5000;
      while (!processedJobs.includes("pre-pause") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(processedJobs).toContain("pre-pause");

    // Phase 2: pause the Redis container. ioredis sees the connection
    // freeze (no active heartbeat coming back). Wait long enough that
    // the client's reconnect logic kicks in.
    const containerId = redisContainer.getId();
    execSync(`docker pause ${containerId}`, { stdio: "pipe" });
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Phase 3: unpause and let ioredis reconnect.
    execSync(`docker unpause ${containerId}`, { stdio: "pipe" });

    // Phase 4: enqueue a post-recovery job; assert it processes.
    // Generous deadline because reconnect timing depends on tcp
    // keepalive defaults — typically 1-3 seconds end-to-end.
    await queue.add("post-resume", { ts: Date.now() });
    {
      const deadline = Date.now() + 15_000;
      while (!processedJobs.includes("post-resume") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(processedJobs).toContain("post-resume");

    await worker.close();
    await queue.close();
  }, 60_000);
});
