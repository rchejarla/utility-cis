import path from "node:path";
import { hostname } from "node:os";
import Redis from "ioredis";
import { config } from "../config.js";
import { logger } from "./logger.js";

/**
 * Redis connection dedicated to BullMQ queues + workers.
 *
 * Different config from `lib/cache-redis.ts` because BullMQ has different
 * requirements:
 *   - `maxRetriesPerRequest: null` is mandatory — BullMQ's blocking
 *     commands (BRPOP, BLPOP) hang indefinitely, and ioredis's default
 *     retry-and-fail behavior would tear them down on every reconnect.
 *   - `enableOfflineQueue: false` in production — when Redis is
 *     unreachable, enqueue calls should fail fast rather than buffer
 *     in memory and drop on disconnect. The cache client tolerates
 *     offline queueing because cache writes are best-effort; queue
 *     writes are durable work.
 *
 * In tests/CI we keep the offline queue allowed so testcontainers'
 * brief boot windows don't cause spurious enqueue failures.
 */

const isProduction = config.NODE_ENV === "production";

/**
 * What this process calls itself in Redis's client list.
 *
 * An unnamed connection shows `name=` empty and is indistinguishable
 * from anyone else's, which is why the platform console could not
 * enumerate API nodes. Naming it makes `CLIENT LIST` the node registry —
 * with the TCP connection as the liveness signal, so there is no
 * heartbeat to tune and no stale row to age out. BullMQ does the same
 * thing for its workers (`bull:<queue>:w:<id>`).
 *
 * `connectionName` rather than a `CLIENT SETNAME` after connecting,
 * because ioredis re-applies it on every reconnect; a name set by hand
 * is lost the first time the socket drops.
 *
 * The role comes from the entry point's filename. `PROCESS_ROLE`
 * overrides it for anything launched differently — the cost of getting
 * it wrong is a mislabelled row on a diagnostic page, not a malfunction,
 * so a heuristic with an override beats threading a parameter through
 * every launcher.
 */
function clientRole(): string {
  if (process.env.PROCESS_ROLE) return process.env.PROCESS_ROLE;
  const entry = path.basename(process.argv[1] ?? "");
  return entry.startsWith("worker") ? "worker" : "api";
}

export const queueRedisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: !isProduction,
  reconnectOnError: () => true,
  connectionName: `${clientRole()}:${hostname()}`,
});

let healthy = false;
let loggedErrorSinceClose = false;

queueRedisConnection.on("ready", () => {
  if (!healthy) {
    logger.info({ component: "queue-redis" }, "ready");
    healthy = true;
    loggedErrorSinceClose = false;
  }
});

queueRedisConnection.on("close", () => {
  if (healthy) {
    logger.warn({ component: "queue-redis" }, "connection closed, reconnecting");
    healthy = false;
  }
});

queueRedisConnection.on("error", (err: Error & { code?: string }) => {
  if (!loggedErrorSinceClose) {
    logger.warn(
      { component: "queue-redis", code: err.code, message: err.message },
      "connection error",
    );
    loggedErrorSinceClose = true;
  }
});

queueRedisConnection.on("end", () => {
  logger.info({ component: "queue-redis" }, "connection closed permanently");
});
