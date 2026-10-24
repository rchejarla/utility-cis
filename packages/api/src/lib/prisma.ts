import { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { logger } from "./logger.js";
import { config } from "../config.js";
import { currentTenant } from "./tenant-context.js";
import { rlsComplaints } from "./rls-guard.js";

/**
 * The connection pool, owned here rather than inside Prisma.
 *
 * Prisma 7 removed the built-in query engine, so a driver adapter is how
 * the client talks to Postgres at all — it is no longer an opt-in. That
 * also means this process owns the pool, which is what row-level
 * security needs: `app.current_utility_id` is a setting on the
 * connection a query runs on, and a pool we construct is a pool whose
 * checkouts we can hook.
 *
 * Exported for that reason and no other. Nothing should query through it
 * directly; `prisma` is the interface.
 */
/**
 * Tenant work, on a role the policies bind to.
 */
const tenantPool = new pg.Pool({ connectionString: config.DATABASE_URL });

/**
 * Work that crosses tenants by design, on a role holding BYPASSRLS — the
 * platform console's 24 routes and the 6 all-tenants queue sweeps.
 *
 * A separate role rather than a widened policy: an `OR
 * current_setting(...)` escape hatch is reachable from any code path
 * that can set a GUC, which puts the invariant back into application
 * code remembering something. This cannot be assumed from SQL.
 *
 * Falls back to `DATABASE_URL` when unset, which is right for a
 * deployment whose application role is still exempt anyway. Once it is
 * not, an unset value means the platform console reads nothing —
 * `assertRlsEnforced` checks for exactly that pairing rather than
 * letting it present as a blank screen.
 */
const platformPool = new pg.Pool({
  connectionString: config.DATABASE_URL_PLATFORM || config.DATABASE_URL,
});

/**
 * Which authority this query runs under, from the same context that
 * carries the tenant.
 *
 * It has to follow the context rather than be passed in.
 * `role.service` and `utility-readiness.service` are each imported by a
 * platform route *and* a tenant route, so a client threaded through
 * call sites would have to be threaded differently into the same
 * function depending on who called it.
 */
function poolFor(): pg.Pool {
  return currentTenant()?.kind === "platform" ? platformPool : tenantPool;
}

/** The value this physical connection currently carries, so it is set once. */
type TaggedClient = pg.PoolClient & { __acting?: string };

/**
 * Make the connection agree with who the calling code is acting for.
 *
 * This is the whole mechanism. The alternative was threading a
 * transaction through 432 query sites, which would have changed every
 * service signature and still left isolation resting on each of them
 * remembering to do it. Here a service keeps importing `prisma` and
 * keeps calling it the same way, and the tenant arrives anyway.
 *
 * It only works on Prisma 7. Prisma 6's query engine was a boundary that
 * dropped AsyncLocalStorage, so `currentTenant()` read `null` here no
 * matter who the caller was — measured, not assumed. Prisma 7 runs the
 * query compiler in process and the context survives.
 *
 * Both of the adapter's routes are wrapped, because wrapping one would
 * silently leave the other unscoped: `performIO` runs plain queries
 * through `pool.query`, and `startTransaction` holds a client from
 * `pool.connect`. Hooking `pool.on("acquire")` is not an option — that
 * event is synchronous and cannot await a `SET`.
 *
 * The id is interpolated because `SET` cannot be parameterised. That is
 * safe because `runAsTenant` refuses anything that is not a uuid, which
 * is the entire reason the check lives at its entrance.
 *
 * Memoised per connection, so a pool warm with one tenant's work pays
 * nothing: otherwise every query would carry a `SET` and a `RESET` of
 * its own, tripling the round trips of a run that posts twelve thousand
 * bills. Sound because nothing reaches this pool except through the two
 * wrappers, so a stale value is always reconciled before it can be read.
 *
 * `RESET` rather than a null: on a custom parameter it leaves the empty
 * string, which is the state we want for work with no tenant. A tenant
 * table's policy raises on `''::uuid` — loudly, which is the point —
 * while the eight policies admitting tenant-less rows are nullif-guarded
 * and keep serving them.
 */
async function applyActingTenant(client: TaggedClient): Promise<void> {
  const acting = currentTenant();
  const want = acting?.kind === "tenant" ? acting.utilityId : "";
  if (client.__acting === want) return;
  if (want === "") {
    await client.query("RESET app.current_utility_id");
  } else {
    await client.query(`SET app.current_utility_id = '${want}'`);
  }
  client.__acting = want;
}

const baseConnect = () => poolFor().connect();

// Transactions: the adapter holds this client for their duration, so what
// is set here covers every statement inside them.
async function connectWithTenant(): Promise<pg.PoolClient> {
  const client = (await baseConnect()) as TaggedClient;
  try {
    await applyActingTenant(client);
  } catch (err) {
    client.release(err as Error);
    throw err;
  }
  return client;
}

// Plain queries: `pool.query` checks a client out and returns it
// internally, with no room to set anything in between — so the checkout
// happens here instead, which is the only way a single query can carry a
// tenant at all.
async function queryWithTenant(text: unknown, values?: unknown): Promise<unknown> {
  const client = (await baseConnect()) as TaggedClient;
  let failed: Error | undefined;
  try {
    await applyActingTenant(client);
    return await (client.query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
  } catch (err) {
    failed = err as Error;
    throw err;
  } finally {
    // Handing the error to `release` destroys a connection broken
    // mid-statement rather than returning it to the pool for the next
    // caller to trip over.
    client.release(failed);
  }
}

/**
 * One pool-shaped thing over two real pools.
 *
 * The adapter takes a single pool and reaches it as `this.client`, so
 * the choice between roles has to happen inside the object it was
 * handed. A proxy rather than a hand-written façade, so anything the
 * adapter touches beyond `connect`, `query` and `end` still reaches a
 * real pool instead of becoming undefined on a Prisma upgrade.
 */
export const pool = new Proxy(tenantPool, {
  get(target, prop, receiver) {
    if (prop === "connect") return connectWithTenant;
    if (prop === "query") return queryWithTenant;
    if (prop === "end") return async () => {
      await Promise.all([tenantPool.end(), platformPool.end()]);
    };
    const value = Reflect.get(target, prop, receiver);
    // Bound to the real pool: an unbound method called on the proxy
    // would run with `this` as the proxy and recurse through this trap.
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as pg.Pool;

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// Warm up connection pool on import
prisma.$connect().catch((err) => logger.error({ err, component: "prisma" }, "Failed to connect"));

/**
 * Refuse to start in production on a database that is not enforcing
 * isolation — and say so loudly anywhere else.
 *
 * Everything else in this file assumes the policies bite. If the
 * application's role is exempt they do not, and nothing reports it:
 * queries succeed, rows come back, and every tenant's rows are among
 * them. The regression is one line in a deployment script
 * (`ALTER ROLE ... SUPERUSER`) and it has no symptom until a customer
 * sees another customer's bill.
 *
 * Development warns and continues on purpose. A dev stack pointed at a
 * superuser is a normal thing to have — `migrate deploy` needs one —
 * and refusing to boot would make the warning something to route
 * around rather than read.
 *
 * Checked against the tenant pool, which is the connection that must be
 * confined. The platform pool is *expected* to bypass; that is its job.
 */
export async function assertRlsEnforced(): Promise<void> {
  const [{ current_user: currentUser, bypasses }] = await tenantPool.query<{
    current_user: string;
    bypasses: boolean;
  }>(
    `SELECT current_user, (rolsuper OR rolbypassrls) AS bypasses
       FROM pg_roles WHERE rolname = current_user`,
  ).then((r) => r.rows);

  /*
   * A table with a policy and no FORCE is one its owner reads freely.
   * Asked of the catalog rather than of a list kept here, so a table
   * added by a later migration is covered by having been created.
   */
  const unforced = await tenantPool.query<{ relname: string }>(
    `SELECT DISTINCT c.relname
       FROM pg_class c
       JOIN pg_policy p ON p.polrelid = c.oid
      WHERE c.relnamespace = 'public'::regnamespace
        AND NOT c.relforcerowsecurity
      ORDER BY c.relname`,
  );

  const complaints = rlsComplaints({
    currentUser,
    bypasses,
    unforcedPoliciedTables: unforced.rows.map((r) => r.relname),
    platformUrlSet: config.DATABASE_URL_PLATFORM !== "",
  });

  if (complaints.length === 0) {
    logger.info(
      { component: "rls", role: currentUser },
      "Row-level security is enforced for the application role",
    );
    return;
  }

  if (config.NODE_ENV === "production") {
    throw new Error(
      `Refusing to start: tenant isolation is not enforced.\n- ${complaints.join("\n- ")}`,
    );
  }
  for (const complaint of complaints) {
    logger.warn({ component: "rls", role: currentUser }, complaint);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUtilityId(utilityId: string): void {
  if (typeof utilityId !== "string" || !UUID_RE.test(utilityId)) {
    throw new Error("Invalid utility ID format");
  }
}

/**
 * The ONLY way to put a tenant into `app.current_utility_id`.
 *
 * Both halves matter and neither is optional:
 *
 *   - **One transaction**, so the `set_config` and the queries that rely
 *     on it run on the same pooled connection. A bare `set_config`
 *     statement lands on whichever connection the pool hands out, and
 *     the queries after it may get a different one, so the setting
 *     simply isn't there.
 *   - **`true`** on the third argument, so the value is scoped to this
 *     transaction and is gone on commit or rollback. With `false` it is
 *     session-scoped and stays on that connection after the work ends,
 *     where the next request to be handed that connection inherits it.
 *
 * That second failure is why the previous `setTenantContext` was removed
 * rather than fixed: it was a bare, session-scoped statement, so it both
 * failed to reach its own queries and left another tenant's id behind.
 * The RLS policies read this setting, so residue is a cross-tenant read
 * that raises no error — inert only for as long as the application role
 * stays a superuser and bypasses RLS entirely.
 *
 * Nothing depended on it: every reader of the setting establishes it
 * itself, inside its own transaction — `audit-wrap.ts`'s `writeAuditRow`,
 * the two `effective-dating-queries.ts` handlers, and this function.
 *
 * Tenant separation today rests on the explicit `utility_id` predicates
 * in queries. Turning RLS on for real means routing tenant-scoped reads
 * through here; see docs/design/utility-cis-architecture.md §7.1.
 */
export async function withTenant<T>(
  utilityId: string,
  fn: (tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>
): Promise<T> {
  assertUtilityId(utilityId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
    return fn(tx);
  });
}
