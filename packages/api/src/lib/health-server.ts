import { createServer, type Server } from "node:http";
import { prisma } from "./prisma.js";
import { logger } from "./logger.js";
import { queueRedisConnection } from "./queue-redis.js";
import { registry } from "./telemetry.js";

/**
 * Tiny HTTP server for the worker process. Exposes:
 *   - GET  /health/live   — 200 always (process is up)
 *   - GET  /health/ready  — 200 iff redis.ping() and SELECT 1 both succeed within 2s
 *   - GET  /metrics       — Prometheus exposition format
 *   - POST /shutdown      — begin the graceful drain, loopback only, and
 *                           only when the caller registered a handler
 *
 * Kubernetes uses /live for restart decisions and /ready for traffic
 * gating (even though the worker takes no traffic, readiness gates
 * whether the pod counts as "ready" for rolling deploys).
 *
 * **Why shutdown is a route.** Windows has no POSIX signals: Node
 * emulates `process.kill(pid, "SIGTERM")` there as an unconditional
 * termination, so the worker's handler — the 60s per-worker drain, the
 * DLQ monitor teardown, the Redis quit — never runs, and an in-flight
 * job loses its lock mid-run. Verified against a running worker, whose
 * "Shutdown initiated" line never appeared. Asking over the server this
 * process already runs costs one route and behaves the same on both
 * platforms. `docker stop` and a pod eviction still arrive as SIGTERM,
 * and that path is unchanged.
 */

const READINESS_TIMEOUT_MS = 2_000;

/**
 * Whether a request came from this host.
 *
 * The shutdown route is the one thing here that changes the process, and
 * this server binds every interface for the probes' sake. The console
 * that asks for a shutdown runs on the same host by construction — a
 * stop is refused across hosts before it gets this far — so loopback is
 * the whole of what needs to reach it.
 *
 * `::ffff:127.0.0.1` is the form a dual-stack listener reports for an
 * IPv4 localhost connection, which is what a `fetch` to 127.0.0.1
 * actually arrives as.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface HealthServerOptions {
  /**
   * Begins this process's graceful shutdown. Registered by the worker;
   * without it the route does not exist, so nothing can ask a process to
   * stop that has not said how.
   */
  onShutdown?: () => void;
}

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

export function startHealthServer(port: number, opts: HealthServerOptions = {}): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/shutdown") {
      if (!opts.onShutdown) {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        // A GET would let a browser, a crawler or a readiness probe stop
        // the worker by looking at it.
        res.writeHead(405).end();
        return;
      }
      if (!isLoopbackAddress(req.socket.remoteAddress ?? undefined)) {
        logger.warn(
          { component: "health-server", from: req.socket.remoteAddress },
          "refused a shutdown request from outside this host",
        );
        res.writeHead(403, { "Content-Type": "application/json" })
          .end('{"error":"shutdown is accepted from this host only"}');
        return;
      }

      // Answered before the drain, which can take a minute: the caller
      // must not hold a request open for it, and watching the process go
      // is how it learns the drain finished.
      logger.info({ component: "health-server" }, "shutdown requested over HTTP");
      res.writeHead(202, { "Content-Type": "application/json" }).end('{"status":"stopping"}');
      opts.onShutdown();
      return;
    }

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
