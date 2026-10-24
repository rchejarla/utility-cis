import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * The boot gate, against real roles.
 *
 * Task 9 of `docs/superpowers/plans/2026-10-24-rls-enforcement.md`.
 * `rls-boot-guard.test.ts` covers the verdict; this covers the two
 * catalog queries that produce it, which is the half a unit test cannot
 * reach and the half that goes stale. `pg_policy`, `relforcerowsecurity`
 * and `rolbypassrls` are the facts the whole plan turns on, and a guard
 * that queried them wrongly would report a clean deployment forever.
 *
 * Each case loads `lib/prisma.ts` afresh, because `config.ts` reads the
 * environment once at module load — which is also why the production
 * case cannot simply flip a variable mid-test.
 */

const utilityId = TENANT_A;

let pgContainer: StartedPostgreSqlContainer;
let dbUrl: string;

const asRoleUrl = (role: string) => dbUrl.replace(/\/\/[^@]+@/, `//${role}:probe@`);

/**
 * Load `assertRlsEnforced` against a given environment.
 *
 * The module registry is reset first so `config.ts` re-reads, and the
 * pools it opens are handed back so the case can close them — an open
 * pool outlives the container and surfaces as 57P01 after a green run.
 */
async function guardUnder(env: Record<string, string>) {
  vi.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const mod = await import("../../lib/prisma.js");
  Object.assign(process.env, saved);
  return {
    assertRlsEnforced: mod.assertRlsEnforced,
    close: () => mod.pool.end().catch(() => {}),
  };
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId] });
  pgContainer = booted.container;
  dbUrl = booted.dbUrl;

  const superuserPool = new pg.Pool({ connectionString: dbUrl });
  try {
    await superuserPool.query(`ALTER ROLE cis_app LOGIN PASSWORD 'probe'`);
    await superuserPool.query(`ALTER ROLE cis_platform LOGIN PASSWORD 'probe'`);
  } finally {
    await superuserPool.end();
  }
}, 240_000);

afterAll(async () => {
  await pgContainer?.stop().catch(() => {});
});

describe("the boot gate", () => {
  /*
   * The arrangement the migrations produce and a deployment is meant to
   * use. If this ever fails, the guard has started reporting a correct
   * deployment as broken — which would get it removed, so it is the
   * first case.
   */
  it("passes on the deployment the migrations produce", async () => {
    const guard = await guardUnder({
      DATABASE_URL: asRoleUrl("cis_app"),
      DATABASE_URL_PLATFORM: asRoleUrl("cis_platform"),
      NODE_ENV: "production",
    });
    try {
      await expect(guard.assertRlsEnforced()).resolves.toBeUndefined();
    } finally {
      await guard.close();
    }
  });

  /*
   * And the regression it exists for: one `ALTER ROLE ... SUPERUSER`, or
   * a deployment that simply kept using the owner. `cis` is both
   * superuser and table owner here, which is exactly the state §7.1
   * described and the state this plan left behind.
   */
  /*
   * Note on `rolsuper OR rolbypassrls`: no case here can tell the two
   * apart, because PostgreSQL reports `rolbypassrls` as true for a
   * superuser. Measured by mutation — narrowing the check to
   * `rolbypassrls` alone leaves every case green. The `rolsuper` half
   * stays because it says what is meant, not because a test holds it.
   */
  it("refuses to start in production as the owner role", async () => {
    const guard = await guardUnder({
      DATABASE_URL: dbUrl,
      DATABASE_URL_PLATFORM: asRoleUrl("cis_platform"),
      NODE_ENV: "production",
    });
    try {
      await expect(guard.assertRlsEnforced()).rejects.toThrow(/bypasses row-level security/);
    } finally {
      await guard.close();
    }
  });

  /*
   * The same database, outside production: a dev stack on a superuser is
   * a normal thing to have, since `migrate deploy` needs one. It warns
   * and continues, because a gate that blocked it would be switched off
   * rather than read.
   */
  it("warns and continues on the same database in development", async () => {
    const guard = await guardUnder({
      DATABASE_URL: dbUrl,
      DATABASE_URL_PLATFORM: asRoleUrl("cis_platform"),
      NODE_ENV: "development",
    });
    try {
      await expect(guard.assertRlsEnforced()).resolves.toBeUndefined();
    } finally {
      await guard.close();
    }
  });

  /*
   * Not a bypass — the opposite, and the failure mode that looks like a
   * working screen with nothing on it. A confined role with no platform
   * connection means every cross-tenant read returns zero rows and
   * reports success.
   */
  it("refuses a confined role with no platform connection", async () => {
    const guard = await guardUnder({
      DATABASE_URL: asRoleUrl("cis_app"),
      DATABASE_URL_PLATFORM: "",
      NODE_ENV: "production",
    });
    try {
      await expect(guard.assertRlsEnforced()).rejects.toThrow(/DATABASE_URL_PLATFORM is unset/);
    } finally {
      await guard.close();
    }
  });

  /*
   * The catalog query, pinned on a change rather than on today's
   * schema: a policied table that stops FORCEing is named. Asserted by
   * turning FORCE off on one table and back on, because a list of
   * table names written here would pass by agreeing with itself.
   */
  it("names a policied table whose owner is exempt from its policy", async () => {
    const superuserPool = new pg.Pool({ connectionString: dbUrl });
    try {
      await superuserPool.query(`ALTER TABLE account NO FORCE ROW LEVEL SECURITY`);
      const guard = await guardUnder({
        DATABASE_URL: asRoleUrl("cis_app"),
        DATABASE_URL_PLATFORM: asRoleUrl("cis_platform"),
        NODE_ENV: "production",
      });
      try {
        /*
         * "1 table(s)", not just "names account": a query that dropped
         * the `NOT` lists every policied table, and a regex looking only
         * for the name would match that too. Counted, so the mutation
         * fails here rather than passing by saying more.
         */
        await expect(guard.assertRlsEnforced()).rejects.toThrow(
          /1 table\(s\) carry a policy[\s\S]*: account\./,
        );
      } finally {
        await guard.close();
      }
    } finally {
      await superuserPool.query(`ALTER TABLE account FORCE ROW LEVEL SECURITY`);
      await superuserPool.end();
    }
  });
});
