/**
 * Shared fixture helpers for the Slice 1 effective-dating integration
 * tests. Boots a Postgres container, applies migrations, and gives
 * tests a small, predictable graph (utility config, commodity, UOM,
 * billing cycle, rate schedule, account, premise, meter) they can
 * compose service agreements over.
 *
 * The helpers are NOT a test file — they live in this directory but
 * the integration runner's `*.integration.test.ts` glob excludes
 * them. Tests import the named helpers explicitly.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

export const TENANT_A = "00000000-0000-4000-8000-0000000000aa";
export const TENANT_B = "00000000-0000-4000-8000-0000000000bb";
export const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

export interface BootedContainer {
  container: StartedPostgreSqlContainer;
  dbUrl: string;
}

export async function bootPostgres(): Promise<BootedContainer> {
  const container = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const dbUrl = container.getConnectionUri();
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  return { container, dbUrl };
}

export interface TenantFixture {
  utilityId: string;
  commodityId: string;
  uomId: string;
  billingCycleId: string;
  billingCycleCode: string;
  accountId: string;
  premiseId: string;
  meterId: string;
  meterId2: string;
  meterId3: string;
}

const RESET_TABLES = [
  "audit_log",
  "service_point_meter",
  "service_point",
  "service_agreement",
  "meter",
  "account",
  "premise",
  "rate_schedule",
  "billing_cycle",
  "unit_of_measure",
  "measure_type_def",
  "commodity",
  "tenant_module",
  "tenant_config",
].join(", ");

/** Postgres `lock_not_available` — what `lock_timeout` raises. */
const LOCK_NOT_AVAILABLE = "55P03";
const LOCK_TIMEOUT_MS = 10_000;
const RESET_ATTEMPTS = 3;

// Same reasoning as makeTenantFixture below: staying off the generated
// Prisma types keeps this fixture from forcing heavy imports on every
// consumer. Tests pass the real client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ResetClient = any;

function isLockTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(LOCK_NOT_AVAILABLE) || msg.includes("lock timeout");
}

/**
 * Who is holding the locks we failed to take. Best-effort: if this
 * introspection itself fails, the caller still gets the original error.
 */
async function describeBlockers(prisma: ResetClient): Promise<string> {
  try {
    const rows = await prisma.$queryRawUnsafe(`
      SELECT pid, state, wait_event_type, left(query, 120) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
      ORDER BY state
    `);
    return JSON.stringify(rows);
  } catch {
    return "(pg_stat_activity unavailable)";
  }
}

/**
 * The RBAC caches describe rows a reset destroys, and they do not live
 * in the container that goes away with the file.
 *
 * `getTenantModules` and `getUserRole` cache in Redis for 600s and 300s,
 * keyed by ids the fixtures hard-code — every file shares `TENANT_A` and
 * the actor `…aaaa00000001`. The Redis itself is the developer's, shared
 * by every fork, so a cached module list outlives the file that wrote it
 * and is read by the next file as though it were that file's own setup.
 *
 * The symptom is a whole file of uniform 403s with nothing wrong in it.
 * In the 2026-10-14 full-suite run that was 17 tests across two files:
 * `lifecycle-endpoints` read another file's module set, and
 * `customer-import` — which does invalidate the module cache — read a
 * stale *role* for the shared actor and got FORBIDDEN on permissions its
 * own fixture had granted. Both passed in isolation, which is what makes
 * this class of failure so expensive to chase.
 *
 * Cheaper than asking every file to remember two invalidations: the
 * reset that invalidates the rows invalidates the cache of them. Files
 * that truncate on their own still need their own call.
 */
async function clearRbacCaches(): Promise<void> {
  try {
    const { redis } = await import("../../lib/cache-redis.js");
    await withTimeout(
      (async () => {
        for (const pattern of ["tenant-modules:*", "user-role:*"]) {
          const keys = await redis.keys(pattern);
          if (keys.length > 0) await redis.del(...keys);
        }
      })(),
      CACHE_CLEAR_TIMEOUT_MS,
    );
  } catch {
    // Best-effort, exactly as the cache helpers are: a run without a
    // reachable Redis is a run with no cache to poison.
  }
}

/**
 * Why a timeout and not just a try/catch.
 *
 * ioredis queues commands while disconnected and retries them for as
 * long as it takes, so an unreachable cache does not throw here — it
 * never answers. A `catch` cannot see that. The first version of this
 * helper awaited `keys()` with no bound and turned one fork's aborted
 * Redis connection into a hook that timed out and a file that sat for
 * twenty minutes, in a suite where that file had just passed: the
 * failure moved from the cache to the reset that consults it.
 *
 * A reset must never be able to hang on a best-effort cache clear, so
 * the wait is bounded and losing the race is not an error. Generous
 * enough that it only trips when Redis is genuinely gone.
 */
const CACHE_CLEAR_TIMEOUT_MS = 2_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      // Do not hold the process open for a cache clear nobody is
      // waiting on.
      timer.unref?.();
    }),
  ]);
}

/**
 * Reset DB to a clean slate by truncating every table the tests touch
 * (audit_log first, then leaf tables, then root tables). RESTART
 * IDENTITY ensures sequence-based identifiers don't drift across runs.
 *
 * The TRUNCATE is bounded by `lock_timeout` and retried, because it can
 * block. CASCADE reaches `meter_read` through its FK to `meter`, and
 * `meter_read` is a Timescale hypertable, so this statement needs ACCESS
 * EXCLUSIVE on it and every one of its chunks — which Timescale's
 * background workers take periodically. Postgres has no default
 * lock_timeout, so a collision waits forever: in the 2026-10-10 suite run
 * one `beforeEach` in premise-loader.integration.test.ts blocked 153s and
 * died on the 120s hookTimeout, while the tests either side of it ran in
 * under a second. The report said only "Hook timed out in 120000ms" —
 * nothing about a lock, which is why it read as a slow machine.
 *
 * The holder is transient (the next test passed 4s later), so a bounded
 * retry turns that flake into a pass. If it ever doesn't clear, the error
 * names the sessions on the database instead of timing out mute.
 *
 * `SET LOCAL` and the TRUNCATE have to share one session, hence the
 * transaction — a bare `$executeRawUnsafe` pair can land on two different
 * pooled connections, leaving the TRUNCATE with no timeout at all.
 */
export async function resetDb(prisma: ResetClient) {
  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt++) {
    try {
      await prisma.$transaction(
        async (tx: { $executeRawUnsafe: (sql: string) => Promise<unknown> }) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
          await tx.$executeRawUnsafe(
            `TRUNCATE TABLE ${RESET_TABLES} RESTART IDENTITY CASCADE`,
          );
        },
        { timeout: LOCK_TIMEOUT_MS + 5_000, maxWait: 10_000 },
      );
      await clearRbacCaches();
      return;
    } catch (err) {
      if (!isLockTimeout(err) || attempt === RESET_ATTEMPTS) {
        if (isLockTimeout(err)) {
          throw new Error(
            `resetDb: TRUNCATE still blocked after ${RESET_ATTEMPTS} attempts ` +
              `at ${LOCK_TIMEOUT_MS}ms each. Sessions on this database: ` +
              `${await describeBlockers(prisma)}`,
            { cause: err },
          );
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/**
 * Create a fresh tenant fixture: one of every entity needed to spin
 * up service agreements + meter assignments. Returns the IDs the
 * tests will use.
 */
// Untyped to keep this fixture decoupled from generated Prisma types
// (which are heavy and would force every consumer to import them
// just to call the helper). Tests pass the real prisma client; the
// `data` payload below is validated by Postgres at insert time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function makeTenantFixture(
  prisma: any,
  utilityId: string,
  opts: { suffix?: string } = {},
): Promise<TenantFixture> {
  const suffix = opts.suffix ?? utilityId.slice(-4);

  await prisma.tenantConfig.create({ data: { utilityId } });

  const commodity = await prisma.commodity.create({
    data: { utilityId, code: `WATER-${suffix}`, name: "Water" },
  });

  // MeasureTypeDef is referenced by UnitOfMeasure with a NOT NULL FK.
  // Reuse a shared one across test runs if it already exists (e.g.,
  // the test sets up two tenants in one beforeEach).
  let measureType = await prisma.measureTypeDef.findFirst({
    where: { code: "VOLUME" },
  });
  if (!measureType) {
    measureType = await prisma.measureTypeDef.create({
      data: { code: "VOLUME", label: "Volume" },
    });
  }

  const uom = await prisma.unitOfMeasure.create({
    data: {
      utilityId,
      commodityId: commodity.id,
      measureTypeId: measureType.id,
      code: "GAL",
      name: "Gallons",
      conversionFactor: 1,
      isBaseUnit: true,
      isActive: true,
    },
  });

  const billingCycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: `Cycle-${suffix}`,
      cycleCode: `C-${suffix}`,
      readDayOfMonth: 1, billDayOfMonth: 10,
      frequency: "MONTHLY",
    },
  });

  // v2 RateSchedule has no rateType/rateConfig — pricing is in
  // RateComponent rows (slice 1 task 5) and SAs link to schedules
  // via SAScheduleAssignment (task 6). The schedule still exists
  // for completeness in case future fixtures reference it.
  await prisma.rateSchedule.create({
    data: {
      utilityId,
      name: `Rate-${suffix}`,
      code: `RATE-${suffix}`,
      commodityId: commodity.id,
      effectiveDate: new Date("2024-01-01"),
      version: 1,
    },
  });

  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: `ACCT-${suffix}`,
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: billingCycle.id,
      depositAmount: 0,
    },
  });

  const premise = await prisma.premise.create({
    data: {
      utilityId,
      addressLine1: `1 Test Lane ${suffix}`,
      city: "Testville",
      state: "TS",
      zip: "00000",
      premiseType: "RESIDENTIAL",
      commodityIds: [commodity.id],
      status: "ACTIVE",
    },
  });

  const meter = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-1`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  const meter2 = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-2`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  const meter3 = await prisma.meter.create({
    data: {
      utilityId,
      premiseId: premise.id,
      commodityId: commodity.id,
      uomId: uom.id,
      meterNumber: `MTR-${suffix}-3`,
      meterType: "MANUAL",
      status: "ACTIVE",
      installDate: new Date("2024-01-01"),
    },
  });

  return {
    utilityId,
    commodityId: commodity.id,
    uomId: uom.id,
    billingCycleId: billingCycle.id,
    billingCycleCode: billingCycle.cycleCode,
    accountId: account.id,
    premiseId: premise.id,
    meterId: meter.id,
    meterId2: meter2.id,
    meterId3: meter3.id,
  };
}
