import { z } from "zod";

/**
 * Single typed config module for both API and worker processes. All
 * environment-variable access goes through here. Validation happens
 * once at module load — missing or malformed env halts startup with
 * a clear error rather than failing at first use.
 *
 * Convention: every env var that affects runtime behavior is declared
 * in the schema below. Outside this module, never read `process.env.X`
 * directly — import `config` instead. ESLint can enforce this if/when
 * the rule is added.
 */

/**
 * Loose-string boolean coercion for env vars. Accepts the boolean
 * variants people actually type (`"true"`, `"TRUE"`, `"1"`) and treats
 * everything else (including missing) as false. Exported for tests.
 */
export const truthyString = z
  .union([z.string(), z.boolean(), z.undefined()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return false;
    return v.toLowerCase() === "true" || v === "1";
  });

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Core connection strings. Both default to empty rather than being
  // required at config-load time. Reasoning: forcing a value here would
  // crash any test environment that doesn't happen to have `.env` —
  // and tests mock Prisma + Redis anyway, so the value isn't actually
  // used. In production, Prisma and BullMQ/ioredis both surface clear
  // runtime errors at first connection attempt if the value is empty
  // or wrong, so the guard doesn't disappear; it just moves to the
  // place that actually depends on it.
  DATABASE_URL: z.string().default(""),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Logging.
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // API + worker process configuration. PORT is the API listen port
  // (matches the cloud-platform convention of $PORT).
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_QUEUES: z.string().default("all"),

  // Auth configuration. NEXTAUTH_SECRET is optional in dev (falls back
  // to unsigned JWT decode for the dev test pills) but required in
  // production — runtime check in middleware/auth.ts enforces this.
  NEXTAUTH_SECRET: z.string().optional(),
  ENABLE_DEV_AUTH_ENDPOINTS: truthyString,

  // Web app URL — used for CORS origin and password-reset / portal
  // links in outbound notifications.
  WEB_URL: z.string().default("http://localhost:3000"),

  // Test / dev opt-outs.
  DISABLE_SCHEDULERS: truthyString,

  // Bull Board admin UI.
  BULL_BOARD_ENABLED: truthyString,
});

export type AppConfig = z.infer<typeof configSchema>;

function loadConfig(): AppConfig {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Use console here intentionally — the logger module also reads
    // config (LOG_LEVEL), so a broken config means we can't trust the
    // logger yet. Plain stderr + non-zero exit is the right primitive
    // at the boundary.
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();

/**
 * Pure parser for the `WORKER_QUEUES` env var. Returns `null` for the
 * "all" sentinel (or empty) — caller treats null as "subscribe to
 * every queue in QUEUE_NAMES". Otherwise returns the trimmed,
 * non-empty queue names.
 *
 * Exported so tests can assert parsing behavior without mocking the
 * full config singleton.
 */
export function parseWorkerQueues(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "all") return null;
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length === 0 ? null : parts;
}

/**
 * Resolve which queues this process should subscribe to from the
 * loaded `config.WORKER_QUEUES`. Selective subscription enables future
 * per-queue replica split-out without code changes: deploy a second
 * worker Deployment with `WORKER_QUEUES=delinquency-tenant,delinquency-dispatch`.
 */
export function resolveWorkerQueues(): string[] | null {
  return parseWorkerQueues(config.WORKER_QUEUES);
}
