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

const truthyString = z
  .union([z.string(), z.boolean(), z.undefined()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v === undefined) return false;
    return v.toLowerCase() === "true" || v === "1";
  });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Core dependencies — fail-fast if missing.
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Logging.
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Worker process configuration.
  WORKER_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WORKER_QUEUES: z.string().default("all"),

  // Test / dev opt-outs.
  DISABLE_SCHEDULERS: truthyString,

  // Migration-window per-job legacy fallback flags. Removed in step 9.
  USE_LEGACY_SCHEDULERS_SUSPENSION: truthyString,
  USE_LEGACY_SCHEDULERS_NOTIFICATION: truthyString,
  USE_LEGACY_SCHEDULERS_DELINQUENCY: truthyString,

  // Bull Board admin UI.
  BULL_BOARD_ENABLED: truthyString,
});

export type AppConfig = z.infer<typeof schema>;

function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
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
 * Resolve which queues this process should subscribe to from
 * `WORKER_QUEUES`. Returns `null` for "all" — caller treats null as
 * "subscribe to every queue in QUEUE_NAMES".
 *
 * Selective subscription enables future per-queue replica split-out
 * without code changes: deploy a second worker Deployment with
 * `WORKER_QUEUES=delinquency-tenant,delinquency-dispatch`.
 */
export function resolveWorkerQueues(): string[] | null {
  const raw = config.WORKER_QUEUES.trim();
  if (raw === "" || raw.toLowerCase() === "all") return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
