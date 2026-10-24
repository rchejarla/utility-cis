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
import pg from "pg";
import { runAsPlatform } from "../../lib/tenant-context.js";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

export const TENANT_A = "00000000-0000-4000-8000-0000000000aa";
export const TENANT_B = "00000000-0000-4000-8000-0000000000bb";
export const ACTOR = "00000000-0000-4000-8000-aaaa00000001";

/**
 * Run setup with authority to cross tenants.
 *
 * Wrap a `beforeAll` or `beforeEach` that writes fixture rows in this.
 *
 * Fixtures are not the thing under test, and most of them write rows for
 * two tenants in one pass — which is precisely what `cis_app` may not
 * do. So setup gets `cis_platform`, the way migrations and seeds get the
 * owner in production, while the code under test gets `cis_app` with the
 * tenant its own request or job established. That split is what makes
 * this suite evidence: a route that reads another tenant's rows now
 * fails, and one that reads its own still passes.
 *
 * Safe to wrap a whole hook, including one that calls `bootPostgres` or
 * injects a request. `tenant-context.ts` imports nothing but
 * `node:async_hooks`, so entering a scope cannot pull `config.ts` in
 * early and read `DATABASE_URL` before the container has set it; and
 * `enterScope` is a `store.run`, so a request handled inside this scope
 * still runs under the tenant its own middleware establishes.
 */
export function seedAsPlatform<T>(fn: () => Promise<T>): Promise<T> {
  return runAsPlatform(fn);
}

/** The same thing, for this module's own fixture writers. */
const asPlatform = seedAsPlatform;

/**
 * Give `ACTOR` a `cis_user` row and a role, in the tenant a test
 * authenticates as.
 *
 * This is the counterpart of `ensureUtilities`, and it exists for the
 * same reason: a column that used to be unenforced became enforced, and
 * every test that writes through the API now has to satisfy it.
 * `utility_id` became a foreign key, so a tenant had to exist; then the
 * authorization middleware stopped treating "no `cis_user` row" as
 * permission to proceed, so the principal has to exist too.
 *
 * That branch is worth remembering, because it was load-bearing for 21
 * files in this directory and for nothing else: the token's subject had
 * no row anywhere, the middleware shrugged, and every gated route
 * answered as though the caller held every permission. Closing it broke
 * all 21 at once, which is what prompted this.
 *
 * The role is a test fixture rather than one of the preset roles: it
 * grants every module every verb, because these tests exercise routes
 * across the whole surface and a realistic role would make each file's
 * coverage depend on which preset it happened to pick. Suites that care
 * about *what a role may do* mock `getUserRole` instead.
 *
 * Idempotent, so a `beforeEach` may call it. `resetDb` does not truncate
 * `cis_user`, `role` or `user_role`, so a `beforeAll` is usually enough.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensurePrincipal(
  prisma: any,
  utilityId: string,
  actorId: string = ACTOR,
): Promise<void> {
  const { MODULES } = await import("@utility-cis/shared");
  const permissions = Object.fromEntries(
    (MODULES as readonly string[]).map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE", "APPROVE"]]),
  );

  await asPlatform(async () => {
    const role = await prisma.role.upsert({
      where: { utilityId_name: { utilityId, name: "Integration Test Admin" } },
      update: { permissions },
      create: {
        utilityId,
        name: "Integration Test Admin",
        description: "Every module, every verb — a fixture, not a preset.",
        isSystem: false,
        permissions,
      },
      select: { id: true },
    });

    await prisma.cisUser.upsert({
      where: { id: actorId },
      update: { utilityId, isActive: true },
      create: {
        id: actorId,
        utilityId,
        email: `actor-${actorId.slice(-12)}@integration.test`,
        name: "Integration Tester",
        isActive: true,
      },
    });

    // `@@unique([userId, accountId])` does not constrain a tenant-wide row,
    // because Postgres treats NULL account ids as distinct — so this is a
    // find-then-create rather than an upsert.
    const existing = await prisma.userRole.findFirst({
      where: { userId: actorId, accountId: null },
      select: { id: true },
    });
    if (existing) {
      await prisma.userRole.update({
        where: { id: existing.id },
        data: { utilityId, roleId: role.id },
      });
    } else {
      await prisma.userRole.create({
        data: { utilityId, userId: actorId, accountId: null, roleId: role.id },
      });
    }
  });

  /*
   * `getUserRole` caches its answer in Redis for 300 seconds, keyed by
   * user and utility — so seeding the row is not enough to make it the
   * answer the middleware gets.
   *
   * This is not hypothetical tidiness. A file whose `beforeEach`
   * truncates and calls this would otherwise carry a previous test's
   * narrowed permissions into the next one: bill-document's
   * `grantAccounts` helper deliberately reduces this actor to
   * `{ accounts: [...] }`, and the two portal cases that ran after it
   * were refused `portal_billing:VIEW` by a cache the reseed never
   * touched. The 403 arrived from a role that no longer existed in any
   * table, which is the worst kind of fixture bug to read.
   *
   * It belongs here rather than in each caller: a principal reseeded
   * after a truncate always needs it, and forgetting it fails somewhere
   * other than the line that caused it.
   */
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateUserRoleCache(actorId, utilityId);
}

export interface BootedContainer {
  container: StartedPostgreSqlContainer;
  /**
   * The container's superuser URI — the owner that ran the migrations.
   *
   * Unchanged in meaning: it is still what a file passes to its own
   * `pg.Pool` to seed rows or alter roles. It is **not** what the
   * application reads; `bootPostgres` points `DATABASE_URL` at `cis_app`.
   */
  dbUrl: string;
  /** `cis_app` — what `DATABASE_URL` is set to. */
  appUrl: string;
  /** `cis_platform` — what `DATABASE_URL_PLATFORM` is set to. */
  platformUrl: string;
}

/** The password granted to the de-privileged roles for the container's life. */
const TEST_ROLE_PASSWORD = "probe";

/** Swap whatever credentials a connection URI carries for a role's. */
function asRoleUrl(dbUrl: string, role: string): string {
  return dbUrl.replace(/\/\/[^@]+@/, `//${role}:${TEST_ROLE_PASSWORD}@`);
}

/**
 * The superuser URI of the container this file booted.
 *
 * Held here so `resetDb` can TRUNCATE. `cis_app` is granted DML and
 * nothing else — deliberately, since a role that may not create or drop
 * anything cannot grant itself a way around a policy — so it has no
 * TRUNCATE privilege, and a reset run as the application role would fail
 * on every file that has one.
 */
let adminUrl: string | undefined;
let adminPool: pg.Pool | undefined;

function admin(): pg.Pool {
  if (!adminUrl) {
    throw new Error(
      "resetDb needs the owner connection, which bootPostgres records. " +
        "A file that boots its own container must truncate through its own client.",
    );
  }
  adminPool ??= new pg.Pool({ connectionString: adminUrl });
  return adminPool;
}

/**
 * SQL that creates a utility row, idempotently.
 *
 * Used by `bootPostgres`, which has no Prisma client yet — it has only
 * just set DATABASE_URL, and the caller imports the singleton afterwards
 * precisely so it reads it. `ensureUtilities` below does the same thing
 * through the client instead.
 *
 * The two agree today but nothing enforces it: they are separate
 * statements of the same insert, so a required column added to a test
 * utility has to be added in both places.
 */
function utilityInsertSql(ids: readonly string[]): string {
  return ids
    .map(
      (id) =>
        `INSERT INTO utility (id, name, status, created_at, updated_at) ` +
        `VALUES ('${id}', 'Test Utility ${id.slice(-4)}', 'ACTIVE', now(), now()) ` +
        `ON CONFLICT (id) DO NOTHING;`,
    )
    .join("\n");
}

/**
 * Create the utility rows a test's tenant ids refer to.
 *
 * For the files that boot their own container rather than calling
 * `bootPostgres` — they already hold a Prisma client, so they can do it
 * directly. Eight files boot their own; six call this, the other two
 * (`worker-redis-reconnect`, `worker-shutdown`) write no tenant rows.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ensureUtilities(prisma: any, ids: readonly string[]): Promise<void> {
  await asPlatform(async () => {
    for (const id of ids) {
      await prisma.utility.upsert({
        where: { id },
        update: {},
        create: { id, name: `Test Utility ${id.slice(-4)}` },
      });
    }
  });
}

/**
 * Boot a database, and declare the tenants this file writes rows for.
 *
 * `utility_id` is a foreign key to `utility`, so a test that writes
 * tenant-scoped rows for an id with no utility row is refused with
 * P2003. 44 of the 63 container-backed files build their own fixtures
 * rather than calling `makeTenantFixture`, and each invents its own
 * tenant id — so the id has to be declared somewhere.
 *
 * It is declared here, by the file that uses it, rather than in a
 * central list inside this helper. A list here would have to be updated
 * from a distance every time a file introduced a tenant, would rot the
 * first time one was removed, and would leave each test silently
 * depending on a registry it never mentions. Passing the ids at the call
 * site keeps the declaration next to the constants it names, and a new
 * file that forgets gets a P2003 naming the exact table — a loud,
 * accurate error rather than a phantom tenant.
 *
 * Files that run `prisma/seed.ts` pass nothing: that seed creates the
 * utility itself, because the six files which run it inherit whatever
 * tenant it defines rather than inventing one.
 *
 * When `provisionTenant()` exists (build-order step 3) this should call
 * it instead of inserting rows, so tests exercise the path production
 * uses rather than a parallel one that can drift from it.
 */
export async function bootPostgres(
  opts: { utilities?: readonly string[] } = {},
): Promise<BootedContainer> {
  const container = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const dbUrl = container.getConnectionUri();
  adminUrl = dbUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";

  // The migration needs the owner; nothing after it does.
  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  /*
   * Point the application at `cis_app`, not at the superuser that just
   * ran the migrations.
   *
   * This is what makes the suite evidence about isolation. Until
   * 2026-10-24 every file here connected as the container's `postgres`
   * — a superuser *and* the owner of every table, exempt from row-level
   * security on both counts — so a route that read another tenant's
   * rows passed, and so did a route that read them correctly. A suite
   * that cannot tell those apart is no evidence at all.
   *
   * The migration creates both roles NOLOGIN with no password, since
   * credentials are not a migration's business. Granted here for the
   * container's lifetime, which is a few seconds.
   */
  execSync("pnpm prisma db execute --stdin", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    input:
      `ALTER ROLE cis_app LOGIN PASSWORD '${TEST_ROLE_PASSWORD}';\n` +
      `ALTER ROLE cis_platform LOGIN PASSWORD '${TEST_ROLE_PASSWORD}';\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const appUrl = asRoleUrl(dbUrl, "cis_app");
  const platformUrl = asRoleUrl(dbUrl, "cis_platform");
  process.env.DATABASE_URL = appUrl;
  process.env.DATABASE_URL_PLATFORM = platformUrl;

  // Through `prisma db execute` rather than a client: this function has
  // only just set DATABASE_URL, and the caller imports `lib/prisma.js`
  // afterwards precisely so the singleton reads it.
  if (opts.utilities && opts.utilities.length > 0) {
    // No `--schema`: Prisma 7 removed the flag from `db execute`, which
    // now takes the schema path from prisma.config.ts.
    execSync("pnpm prisma db execute --stdin", {
      cwd: SHARED_DIR,
      env: { ...process.env, DATABASE_URL: dbUrl },
      input: utilityInsertSql(opts.utilities),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  return { container, dbUrl, appUrl, platformUrl };
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
  "utility_module",
  "utility_config",
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
async function describeBlockers(pool: ResetPool): Promise<string> {
  try {
    const client = await pool.connect();
    try {
      const res = await client.query(`
        SELECT pid, state, wait_event_type, left(query, 120) AS query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
        ORDER BY state
      `);
      return JSON.stringify(res.rows);
    } finally {
      client.release();
    }
  } catch {
    return "(pg_stat_activity unavailable)";
  }
}

/**
 * The slice of `pg.Pool` that `resetDb` needs.
 *
 * Named so the retry and the one-session guarantee stay unit-testable
 * without a container: `_effective-dating-fixtures.test.ts` passes a
 * fake that fails the TRUNCATE a chosen number of times. The statements
 * used to run through a Prisma client, which is what that test stubbed;
 * they now run on a pooled connection, because a reset needs the owner
 * role and the application's client no longer connects as it.
 */
export type ResetPool = {
  connect(): Promise<{
    query(sql: string): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
};

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
/**
 * Truncate tables `resetDb`'s list does not cover, over the owner
 * connection.
 *
 * Six files truncate a list of their own — auth tables, import tables,
 * notification tables — because `RESET_TABLES` deliberately leaves them
 * alone. They used to do it with `prisma.$executeRawUnsafe`, which
 * worked only while the application connected as a superuser; `cis_app`
 * is granted DML and no TRUNCATE, so the same statement is now a 42501.
 *
 * The privilege is not the thing to widen — a reset is fixture work, and
 * fixture work gets the role that owns the schema. This is `resetDb`'s
 * mechanism with the caller's own list.
 */
/**
 * Close the owner pool `resetDb` and `truncateTables` share.
 *
 * Call it before stopping the container. It is a second pool, separate
 * from the application's, so `prisma.$disconnect()` and `pool.end()` do
 * not touch it — and a container stopped while one of its connections is
 * live has Postgres report 57P01 as an unhandled error after an
 * otherwise green run.
 */
export async function endAdminPool(): Promise<void> {
  const open = adminPool;
  adminPool = undefined;
  adminUrl = undefined;
  await open?.end().catch(() => {});
}

export async function truncateTables(tables: string): Promise<void> {
  const client = await admin().connect();
  try {
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  } finally {
    client.release();
  }
}

export async function resetDb(pool: ResetPool = admin()) {
  for (let attempt = 1; attempt <= RESET_ATTEMPTS; attempt++) {
    try {
      /*
       * Over the owner connection, not the client the caller passed.
       *
       * `cis_app` is granted SELECT, INSERT, UPDATE and DELETE and
       * nothing else, so it has no TRUNCATE privilege — which is the
       * grant working rather than something to widen. A reset is fixture
       * work, and fixture work gets the role that owns the schema, the
       * same way migrations and seeds do in production.
       *
       * One connection for the `SET LOCAL` and the TRUNCATE, for the
       * reason the transaction was here before: a bare pair can land on
       * two pooled connections, leaving the TRUNCATE with no timeout.
       */
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
        await client.query(`TRUNCATE TABLE ${RESET_TABLES} RESTART IDENTITY CASCADE`);
        await client.query("COMMIT");
      } catch (truncateErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw truncateErr;
      } finally {
        client.release();
      }
      await clearRbacCaches();
      return;
    } catch (err) {
      if (!isLockTimeout(err) || attempt === RESET_ATTEMPTS) {
        if (isLockTimeout(err)) {
          throw new Error(
            `resetDb: TRUNCATE still blocked after ${RESET_ATTEMPTS} attempts ` +
              `at ${LOCK_TIMEOUT_MS}ms each. Sessions on this database: ` +
              `${await describeBlockers(pool)}`,
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

  // The tenant itself, first: every row below carries its id, and
  // `utility_id` is a foreign key, so nothing can be written before it
  // exists. Upserted — `resetDb` does not truncate `utility`, so a file
  // calling this per test would collide on the second call.
  await ensureUtilities(prisma, [utilityId]);

  return asPlatform(async () => {
    await prisma.utilityConfig.create({ data: { utilityId } });

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
  });
}
