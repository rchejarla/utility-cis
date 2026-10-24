import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { bootPostgres, TENANT_A, TENANT_B } from "./_effective-dating-fixtures.js";

/**
 * How the acting tenant reaches the database.
 *
 * Plan: `docs/superpowers/plans/2026-10-24-rls-enforcement.md`, Tasks 3–5.
 *
 * The policies bind to `app.current_utility_id`, and `withTenant` — the
 * only safe way to set it — has five call sites against 432 bare-client
 * query sites. Threading a transaction through all of them would change
 * every service signature and still leave isolation resting on code
 * remembering something. So the tenant travels in AsyncLocalStorage and
 * is applied to the connection itself, which is why this package now owns
 * its `pg` pool instead of letting Prisma hide one.
 *
 * A unit test cannot see any of this: `vitest.setup.ts` mocks
 * `lib/prisma.js` for the whole unit suite, so the real module never
 * loads there.
 */

const utilityId = TENANT_A;
const otherUtility = TENANT_B;

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtility] });
  pgContainer = booted.container;

  /*
   * Everything below runs as the roles a deployment will actually use —
   * `cis_app` for tenant work and `cis_platform` for work that crosses
   * tenants — rather than as the container's superuser. That is the
   * whole point: a superuser is exempt from RLS, so a suite running as
   * one cannot tell whether any of this works.
   *
   * The migration creates both roles NOLOGIN with no password on
   * purpose, since credentials are not a migration's business
   * (`scripts/grant-dev-db-logins.sql` does it for dev). This grants
   * them for the container's lifetime, which is a few seconds.
   *
   * Fixtures are inserted over a plain superuser connection first,
   * because `cis_app` could not create a row for two different tenants
   * in one pass — which is the policy working, not a problem to route
   * around.
   */
  const superuserPool = new pg.Pool({ connectionString: booted.dbUrl });
  try {
    await superuserPool.query(`ALTER ROLE cis_app LOGIN PASSWORD 'probe'`);
    await superuserPool.query(`ALTER ROLE cis_platform LOGIN PASSWORD 'probe'`);

    // Through a throwaway Prisma client rather than hand-written INSERTs:
    // the column list is the schema's business, and restating it here
    // only creates a second place to get it wrong.
    const { PrismaClient } = await import("@utility-cis/shared/src/generated/prisma");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const seeder = new PrismaClient({ adapter: new PrismaPg(superuserPool) });
    try {
      for (const [uid, number] of [
        [utilityId, "CTX-A-001"],
        [otherUtility, "CTX-B-001"],
      ] as const) {
        const cycle = await seeder.billingCycle.create({
          data: {
            utilityId: uid,
            name: "R1",
            cycleCode: "R01",
            readDayOfMonth: 1,
            billDayOfMonth: 15,
            frequency: "MONTHLY",
          },
        });
        await seeder.account.create({
          data: {
            utilityId: uid,
            accountNumber: number,
            accountType: "RESIDENTIAL",
            status: "ACTIVE",
            billingCycleId: cycle.id,
          },
        });
      }
    } finally {
      await seeder.$disconnect().catch(() => {});
    }
  } finally {
    await superuserPool.end();
  }

  // Point the client at the de-privileged roles *before* importing it:
  // `config.ts` reads the environment once, at module load.
  const asRoleUrl = (role: string) =>
    booted.dbUrl.replace(/\/\/[^@]+@/, `//${role}:probe@`);
  process.env.DATABASE_URL = asRoleUrl("cis_app");
  process.env.DATABASE_URL_PLATFORM = asRoleUrl("cis_platform");

  prismaImports = await import("../../lib/prisma.js");
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("the connection pool", () => {
  /*
   * Owning the pool is the point, not a detail. Prisma's own pool is
   * opaque: there is no hook for "a connection was handed out", and
   * `$extends` cannot wrap an operation in a transaction, because the
   * bound `query()` already executes on the client it came from. A pool
   * this process constructs has `connect`, and that is where the tenant
   * can be applied once per checkout rather than once per call site.
   */
  it("is one this process owns, so a checkout is something we can hook", async () => {
    const { pool } = prismaImports;
    expect(pool).toBeDefined();
    expect(typeof pool.connect).toBe("function");
    expect(typeof pool.end).toBe("function");
  });

  it("carries every query, including the raw SQL and the generated client", async () => {
    const { prisma } = prismaImports;
    const { runAsTenant } = await import("../../lib/tenant-context.js");
    // Scoped, because the client now connects as a role the policies
    // bind to: an unscoped read of a tenant table is refused, which is
    // the behaviour the rest of this suite exists to establish.
    const { viaClient, viaRaw } = await runAsTenant(utilityId, async () => ({
      viaClient: await prisma.account.count(),
      viaRaw: Number(
        (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM account`)[0].n,
      ),
    }));
    // One, not two: the other tenant's row is there and is not visible.
    expect(viaClient).toBe(1);
    expect(viaRaw).toBe(1);
  });
});

/**
 * Applying the acting tenant to the connection a query runs on.
 *
 * This is the half that was impossible on Prisma 6: its query engine was
 * a boundary that dropped AsyncLocalStorage, so the hook below saw
 * `null` no matter who the caller was acting for. Prisma 7 runs the
 * query compiler in process, and the context survives.
 *
 * These run as `cis`, still a superuser, so the policies do not bite and
 * the counts are of every tenant's rows. That is deliberate: this task
 * is about whether the *setting* arrives and leaves correctly, which is
 * observable on its own. `rls-enforcement.integration.test.ts` proves
 * the policies refuse a role that is not exempt, and Task 8 is where the
 * application becomes one.
 */
describe("the acting tenant on a connection", () => {
  const setting = async () => {
    const { prisma } = prismaImports;
    const [{ v }] = await prisma.$queryRaw<{ v: string | null }[]>`
      SELECT current_setting('app.current_utility_id', true) AS v`;
    return v;
  };

  it("is set for work inside a tenant scope", async () => {
    const { runAsTenant } = await import("../../lib/tenant-context.js");
    expect(await runAsTenant(utilityId, setting)).toBe(utilityId);
  });

  /*
   * Review Focus 2, and the leak §7.1 measured before `setTenantContext`
   * was removed: a session-scoped value on a pooled connection outlives
   * the work that set it, and the next caller handed that connection
   * inherits a tenant it was never given.
   *
   * The claim is that the id is GONE — not that the parameter is unset.
   * `RESET` on a custom GUC leaves the empty string, and empty is the
   * safe state: a tenant table's policy raises on `''::uuid`, while the
   * eight policies admitting tenant-less rows are nullif-guarded and keep
   * serving them.
   */
  it("does not leave a tenant behind on the connection it used", async () => {
    const { runAsTenant } = await import("../../lib/tenant-context.js");
    await runAsTenant(utilityId, async () => prismaImports.prisma.account.count());
    const after = await setting();
    expect(after).not.toBe(utilityId);
    expect(after ?? "").toBe("");
  });

  it("gives interleaved tenants their own setting, not each other's", async () => {
    const { runAsTenant } = await import("../../lib/tenant-context.js");
    const read = (id: string) =>
      runAsTenant(id, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return setting();
      });
    const [a, b, a2] = await Promise.all([read(utilityId), read(otherUtility), read(utilityId)]);
    expect([a, b, a2]).toEqual([utilityId, otherUtility, utilityId]);
  });

  /*
   * Review Focus 5. `withTenant` and `auditCreate`/`auditUpdate` each
   * open a transaction and issue `set_config(..., true)`, which is
   * transaction-local — so it must not destroy the session value the
   * checkout established for the surrounding work.
   */
  it("survives an inner transaction setting it transaction-locally", async () => {
    const { runAsTenant } = await import("../../lib/tenant-context.js");
    const { prisma } = prismaImports;
    const after = await runAsTenant(utilityId, async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
        await tx.account.count();
      });
      return setting();
    });
    expect(after).toBe(utilityId);
  });

  it("sets nothing for platform work, which is meant to cross tenants", async () => {
    const { runAsPlatform } = await import("../../lib/tenant-context.js");
    expect((await runAsPlatform(setting)) ?? "").toBe("");
  });

  /*
   * Task 6. Setting nothing is not enough on its own: with RLS enforced,
   * a connection carrying no tenant reads nothing rather than
   * everything. Platform work needs a role the policies do not bind to,
   * and `runAsPlatform` is what selects it.
   *
   * Which role a query runs as therefore follows the same context the
   * tenant does, rather than being threaded through call sites. It has
   * to: `role.service` and `utility-readiness.service` are each imported
   * by both a platform route and a tenant route, so a client passed by
   * hand would have to be passed differently to the same function
   * depending on who called it.
   */
  it("runs platform work as a role that may cross tenants, and tenant work as one that may not", async () => {
    const { runAsTenant, runAsPlatform } = await import("../../lib/tenant-context.js");
    const whoami = async () => {
      const [{ u }] = await prismaImports.prisma.$queryRaw<{ u: string }[]>`
        SELECT current_user AS u`;
      return u;
    };
    expect(await runAsPlatform(whoami)).toBe("cis_platform");
    expect(await runAsTenant(utilityId, whoami)).toBe("cis_app");
  });

  /*
   * The point of the role, stated as what it can see. Asserted on a
   * tenant-scoped table with two tenants' rows in it, so "crosses
   * tenants" is a count and not a claim.
   */
  it("lets platform work read every tenant's rows, and a tenant's only its own", async () => {
    const { runAsTenant, runAsPlatform } = await import("../../lib/tenant-context.js");
    const tenantsVisible = async () => {
      const rows = await prismaImports.prisma.$queryRaw<{ utility_id: string }[]>`
        SELECT DISTINCT utility_id::text FROM account`;
      return rows.map((r) => r.utility_id).sort();
    };
    expect(await runAsPlatform(tenantsVisible)).toEqual([utilityId, otherUtility].sort());
    expect(await runAsTenant(utilityId, tenantsVisible)).toEqual([utilityId]);
  });
});
