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

export const queueRedisConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: !isProduction,
  reconnectOnError: () => true,
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
