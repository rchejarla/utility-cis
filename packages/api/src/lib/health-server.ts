import { createServer, type Server } from "node:http";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { queueRedisConnection } from "./queue-redis.js";
import { registry } from "./telemetry.js";

/**
 * Tiny HTTP server for the worker process. Exposes:
 *   - GET /health/live   — 200 always (process is up)
 *   - GET /health/ready  — 200 iff redis.ping() and SELECT 1 both succeed within 2s
 *   - GET /metrics       — Prometheus exposition format
 *
 * Kubernetes uses /live for restart decisions and /ready for traffic
 * gating (even though the worker takes no traffic, readiness gates
 * whether the pod counts as "ready" for rolling deploys).
 */

const READINESS_TIMEOUT_MS = 2_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkReadiness(): Promise<{ ok: boolean; redis: boolean; db: boolean; error?: string }> {
  const [redisResult, dbResult] = await Promise.allSettled([
    withTimeout(queueRedisConnection.ping(), READINESS_TIMEOUT_MS),
    withTimeout(prisma.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS),
  ]);
  const redisOk = redisResult.status === "fulfilled";
  const dbOk = dbResult.status === "fulfilled";
  const ok = redisOk && dbOk;
  if (ok) return { ok, redis: redisOk, db: dbOk };
  const errors: string[] = [];
  if (!redisOk && redisResult.reason instanceof Error) errors.push(`redis: ${redisResult.reason.message}`);
  if (!dbOk && dbResult.reason instanceof Error) errors.push(`db: ${dbResult.reason.message}`);
  return { ok, redis: redisOk, db: dbOk, error: errors.join("; ") };
}

export function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url === "/health/live") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"alive"}');
      return;
    }
    if (url === "/health/ready") {
      void checkReadiness().then((result) => {
        const body = JSON.stringify(result);
        res
          .writeHead(result.ok ? 200 : 503, { "Content-Type": "application/json" })
          .end(body);
      }).catch((err) => {
        logger.error({ err, component: "health-server" }, "Readiness check failed unexpectedly");
        res.writeHead(503, { "Content-Type": "application/json" })
          .end('{"status":"error"}');
      });
      return;
    }
    if (url === "/metrics") {
      void registry.metrics().then((body) => {
        res
          .writeHead(200, { "Content-Type": registry.contentType })
          .end(body);
      }).catch((err) => {
        logger.error({ err, component: "health-server" }, "Failed to render metrics");
        res.writeHead(500).end();
      });
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, () => {
    logger.info({ component: "health-server", port }, "listening");
  });

  return server;
}
