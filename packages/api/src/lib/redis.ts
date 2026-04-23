import Redis from "ioredis";

/**
 * Redis is used purely as a best-effort cache (RBAC lookups, rate schedule
 * lookups). Treat it as optional: callers use the cacheGet/cacheSet/cacheDel
 * helpers below, which swallow per-command errors so a Redis outage
 * degrades to a DB-only path rather than failing requests.
 *
 * ioredis auto-reconnects on its own. The lifecycle listeners below log
 * once per state transition (connect, close, reconnect) instead of once
 * per failed command — a single network blip used to emit ECONNRESET on
 * every in-flight command and flood the logs.
 */

export const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
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
    console.log("[redis] ready");
    healthy = true;
    loggedErrorSinceClose = false;
  }
});

redis.on("close", () => {
  if (healthy) {
    console.warn("[redis] connection closed, reconnecting…");
    healthy = false;
  }
});

redis.on("error", (err: Error & { code?: string }) => {
  // Collapse the ECONNRESET / ECONNREFUSED storm that ioredis emits per
  // in-flight command into one line per disconnection. Keep a handler
  // attached so an unhandled 'error' event can't crash the process.
  if (!loggedErrorSinceClose) {
    console.warn(`[redis] connection error (${err.code ?? err.message})`);
    loggedErrorSinceClose = true;
  }
});

// Bound every cache call so a stalled ioredis client (mid-reconnect with
// commands piling up in the offline queue) can't hang a request. If Redis
// doesn't answer within CACHE_TIMEOUT_MS, callers fall through to the DB.
const CACHE_TIMEOUT_MS = 500;

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
  try {
    return await withTimeout<string | null>(redis.get(key), null);
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  ttlSeconds: number,
  value: string,
): Promise<void> {
  try {
    await withTimeout<unknown>(redis.setex(key, ttlSeconds, value), null);
  } catch {
    // best-effort cache write — losing this is fine
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    await withTimeout<unknown>(redis.del(key), null);
  } catch {
    // best-effort cache bust — next read falls through to DB
  }
}
