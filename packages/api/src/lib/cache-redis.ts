import Redis from "ioredis";
import { logger } from "./logger.js";
import { config } from "../config.js";

/**
 * Cache-only Redis client for best-effort lookups (RBAC permissions,
 * rate schedules). Treat as optional: callers use the cacheGet/Set/Del
 * helpers below, which swallow per-command errors so a Redis outage
 * degrades to a DB-only path rather than failing requests.
 *
 * For BullMQ queue connections, see `lib/queue-redis.ts` (created in
 * Task 1). That client uses different ioredis settings
 * (`maxRetriesPerRequest: null`, `enableOfflineQueue: false`) required
 * by BullMQ's blocking commands; sharing the connection would force
 * one set of choices for both use cases.
 *
 * ioredis auto-reconnects on its own. The lifecycle listeners below log
 * once per state transition (connect, close, reconnect) instead of once
 * per failed command — a single network blip used to emit ECONNRESET on
 * every in-flight command and flood the logs.
 */
export const redis = new Redis(config.REDIS_URL, {
  // Cap reconnect backoff at 5s. Default is min(times * 50, 2000) which is
  // also fine; this just makes the intent explicit and tolerates longer
  // transient outages (e.g., Docker Desktop network adapter restart).
  retryStrategy(times: number): number {
    return Math.min(times * 200, 5000);
  },
});

let healthy = false;
let loggedErrorSinceClose = false;

redis.on("ready", () => {
  if (!healthy) {
    logger.info({ component: "cache-redis" }, "ready");
    healthy = true;
    loggedErrorSinceClose = false;
  }
});

redis.on("close", () => {
  if (healthy) {
    logger.warn({ component: "cache-redis" }, "connection closed, reconnecting");
    healthy = false;
  }
});

redis.on("error", (err: Error & { code?: string }) => {
  // Collapse the ECONNRESET / ECONNREFUSED storm that ioredis emits per
  // in-flight command into one line per disconnection. Keep a handler
  // attached so an unhandled 'error' event can't crash the process.
  if (!loggedErrorSinceClose) {
    logger.warn(
      { component: "cache-redis", code: err.code, message: err.message },
      "connection error",
    );
    loggedErrorSinceClose = true;
  }
});

// Bound every cache call so a stalled ioredis client (mid-reconnect with
// commands piling up in the offline queue) can't hang a request. If Redis
// doesn't answer within CACHE_TIMEOUT_MS, callers fall through to the DB.
const CACHE_TIMEOUT_MS = 500;

/**
 * Whether it is worth talking to Redis at all right now.
 *
 * The timeout above is the backstop; this is the thing that makes an
 * outage cheap. A wedged client answers nothing, so every call paid its
 * full 500ms and then fell through to the DB anyway — four of those in
 * one authorize pass is two seconds added to every authenticated
 * request, which is how this was found: `/health` answered in 5ms while
 * every gated route took a flat 2.05s whatever it returned.
 *
 * Read from `redis.status` rather than the `healthy` flag above. The
 * flag exists to debounce log lines and is a second copy of the same
 * fact; the client's own status is the one that cannot be wrong. During
 * startup it is `connecting`, so the first requests skip the cache and
 * read the database — correct, and faster than queueing behind a
 * connection that has not finished opening.
 */
function connected(): boolean {
  return redis.status === "ready";
}

async function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), CACHE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  if (!connected()) return null;
  try {
    return await withTimeout<string | null>(redis.get(key), null);
  } catch {
    return null;
  }
}

/**
 * Fill the cache. **Not awaited internally, by design.**
 *
 * Nothing in a request depends on the write landing — the value it would
 * store is already in hand, and a lost write costs one future miss. It
 * was awaited, so a stalled client charged the caller 500ms to write to
 * a cache that was not working: half the two seconds this path used to
 * add to every authenticated request was spent that way.
 *
 * The returned promise resolves immediately. Callers may keep awaiting
 * it; they are awaiting the enqueue, not the round trip. Two requests
 * racing to fill the same key write the same value, so there is nothing
 * to serialise.
 */
export async function cacheSet(
  key: string,
  ttlSeconds: number,
  value: string,
): Promise<void> {
  if (!connected()) return;
  void redis.setex(key, ttlSeconds, value).catch(() => {
    // best-effort cache write — losing this is fine
  });
}

/**
 * Drop a key. Awaited, unlike the write above, because a caller
 * invalidating expects the next read to miss — that is correctness, not
 * optimisation.
 *
 * Skipped while disconnected, which loses the invalidation if the key
 * outlives the outage. That risk is not new: a down client swallowed the
 * delete after timing out, so the window was always bounded by the TTL
 * rather than by this call succeeding. Reads are skipped while
 * disconnected too, so nothing serves the stale value until Redis is
 * back.
 */
export async function cacheDel(key: string): Promise<void> {
  if (!connected()) return;
  try {
    await withTimeout<unknown>(redis.del(key), null);
  } catch {
    // best-effort cache bust — next read falls through to DB
  }
}
