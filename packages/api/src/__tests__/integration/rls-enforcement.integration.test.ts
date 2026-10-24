import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, TENANT_A, TENANT_B } from "./_effective-dating-fixtures.js";

/**
 * Whether row-level security actually refuses a cross-tenant read.
 *
 * Plan: `docs/superpowers/plans/2026-10-24-rls-enforcement.md`.
 * Spec: `docs/design/utility-cis-architecture.md` §7.1.
 *
 * The policies have been real since the schema was squashed and have
 * never once been applied: `cis` is a SUPERUSER *and* owns every table,
 * and PostgreSQL exempts both independently. So these cases start by
 * characterising the hole — asserting the bypass as it is — and the
 * later tasks in the plan invert them one at a time.
 *
 * Everything here talks to Postgres through `SET LOCAL ROLE` rather than
 * a second connection string, because the roles are created by migration
 * and a test that needed its own DATABASE_URL per role could not run in
 * the same container as the rest of the suite.
 */

const utilityId = TENANT_A;
const otherUtility = TENANT_B;

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

/**
 * Run SQL as another role on a connection of its own, and hand back
 * whatever happened.
 *
 * Separate from `asRole` because a statement a policy *refuses* aborts
 * its transaction, and an aborted transaction on the shared client makes
 * the next case fail for reasons of its own — which is exactly what
 * happened: asserting the raise on `ledger_entry` broke the global
 * reference read that followed it, and the read passed again the moment
 * it ran alone. A throwaway client cannot reach the next case.
 */
async function asRoleExpectingRefusal(role: string, sql: string): Promise<Error> {
  const { PrismaClient } = await import("@utility-cis/shared/src/generated/prisma");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const pg = (await import("pg")).default;
  // Prisma 7 has no engine of its own, so even a throwaway client is
  // built over an adapter — `new PrismaClient()` with no options now
  // refuses to connect at all.
  const throwawayPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = new PrismaClient({ adapter: new PrismaPg(throwawayPool) });
  try {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
      await tx.$queryRawUnsafe(sql);
    });
    throw new Error(`expected ${role} to be refused, but the statement succeeded`);
  } catch (err) {
    return err as Error;
  } finally {
    await client.$disconnect().catch(() => {});
    await throwawayPool.end().catch(() => {});
  }
}

/**
 * Run SQL as another role, in a transaction that also carries a tenant.
 *
 * `SET LOCAL ROLE` so the change dies with the transaction — a bare
 * `SET ROLE` would outlive it on a pooled connection and silently
 * re-label every later query in the suite.
 */
async function asRole<T>(
  role: string,
  sql: string,
  opts: { tenant?: string } = {},
): Promise<T[]> {
  const { prisma } = prismaImports;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    if (opts.tenant) {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_utility_id', '${opts.tenant}', true)`,
      );
    }
    return tx.$queryRawUnsafe<T[]>(sql);
  });
}

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtility] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");

  const { prisma } = prismaImports;
  // One account per tenant, so "another tenant's rows" is a real set.
  for (const [uid, number] of [
    [utilityId, "RLS-A-001"],
    [otherUtility, "RLS-B-001"],
  ] as const) {
    const cycle = await prisma.billingCycle.create({
      data: {
        utilityId: uid,
        name: "R1",
        cycleCode: "R01",
        readDayOfMonth: 1,
        billDayOfMonth: 15,
        frequency: "MONTHLY",
      },
    });
    await prisma.account.create({
      data: {
        utilityId: uid,
        accountNumber: number,
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: cycle.id,
      },
    });
  }

  /*
   * The platform actor and one tenant's staff, as fixtures rather than
   * as side effects of the cases that read them. A case that creates
   * what a later case asserts on makes the suite order-dependent, and
   * ordering is exactly what went wrong the first time these were
   * written inline.
   */
  await prisma.cisUser.create({
    data: {
      utilityId: null,
      email: "operator@platform.test",
      name: "Platform Operator",
      isActive: true,
    },
  });
  await prisma.cisUser.create({
    data: {
      utilityId: otherUtility,
      email: "staff@b.test",
      name: "B Staff",
      isActive: true,
    },
  });
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("the application role's exemption from RLS", () => {
  /*
   * Characterisation, not an aspiration. This passes today and Task 8
   * inverts it; until then it is the proof that the policies are inert,
   * stated as a test so the change is visible rather than argued.
   */
  it("reads another tenant's rows while the role is a superuser", async () => {
    const { prisma } = prismaImports;
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${utilityId}, true)`;
      return tx.$queryRaw<{ utility_id: string }[]>`SELECT utility_id::text FROM account`;
    });
    expect(rows.map((r) => r.utility_id)).toContain(otherUtility);
  });

  it("is a superuser and owns the tables, which are two exemptions, not one", async () => {
    const { prisma } = prismaImports;
    const [role] = await prisma.$queryRaw<{ super: boolean; owns: bigint }[]>`
      SELECT r.rolsuper AS super,
             (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND pg_get_userbyid(c.relowner) = current_user) AS owns
        FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role.super).toBe(true);
    expect(Number(role.owns)).toBeGreaterThan(0);
  });
});

describe("the policies themselves", () => {
  /*
   * The distinction the whole plan rests on: nothing is wrong with the
   * 62 policies. Same table, same statement, a role that is neither
   * superuser nor owner — and the predicate appears.
   */
  it("apply to a role that is neither superuser nor owner", async () => {
    const rows = await asRole<{ utility_id: string }>(
      "cis_app",
      "SELECT utility_id::text FROM account",
      { tenant: utilityId },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.utility_id === utilityId)).toBe(true);
  });

  it("leave no table on which ownership could reopen the hole", async () => {
    const { prisma } = prismaImports;
    const [{ unforced }] = await prisma.$queryRaw<{ unforced: bigint }[]>`
      SELECT count(*) AS unforced FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity`;
    expect(Number(unforced)).toBe(0);
  });

  /*
   * How a policy fails when no tenant is set is not a detail. A tenant
   * table answering emptily reads as "nothing is wrong" — and 21 of them
   * did, because they used the two-argument `current_setting`, which
   * returns NULL rather than raising, and `utility_id = NULL` matches no
   * row. The ledger tables were among them, where an empty result is the
   * most dangerous possible answer.
   */
  it("refuses loudly, not emptily, when a tenant table is read with no tenant", async () => {
    const err = await asRoleExpectingRefusal("cis_app", "SELECT id FROM ledger_entry");
    expect(err.message).toContain("app.current_utility_id");
  });

  /*
   * And the other side, which is why this is 21 tables and not 26: a row
   * that belongs to no tenant is readable without one. Converting these
   * would make a legitimate read of global reference data raise.
   */
  it("still serves rows that belong to no tenant, with no tenant set", async () => {
    const rows = await asRole<{ code: string }>(
      "cis_app",
      "SELECT code FROM account_type_def WHERE utility_id IS NULL",
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it("leaves no tenant table able to answer emptily", async () => {
    const { prisma } = prismaImports;
    const [{ silent }] = await prisma.$queryRaw<{ silent: bigint }[]>`
      SELECT count(*) AS silent FROM pg_policies
       WHERE schemaname = 'public'
         AND qual LIKE '%, true)%'
         AND qual NOT LIKE '%IS NULL%'`;
    expect(Number(silent)).toBe(0);
  });

  /*
   * The platform actor IS the cis_user row whose utility_id is null, and
   * its policy had no NULL branch — so the moment RLS binds, the query
   * that authorises all 24 platform routes finds nothing and every one
   * of them answers 403, for a reason that looks exactly like the role
   * split failing.
   */
  it("can still find the platform actor", async () => {
    // Read with a tenant set, which is how `getPlatformActor` runs: the
    // claim is that the tenant-less row is visible *alongside* a
    // tenant's, not that it is readable with no context at all.
    const rows = await asRole<{ id: string }>(
      "cis_app",
      "SELECT id::text FROM cis_user WHERE utility_id IS NULL",
      { tenant: utilityId },
    );
    expect(rows).toHaveLength(1);
  });

  it("does not thereby expose another tenant's staff", async () => {
    const rows = await asRole<{ utility_id: string | null }>(
      "cis_app",
      "SELECT utility_id::text FROM cis_user",
      { tenant: utilityId },
    );
    // Widened by exactly one row shape: the tenant-less one.
    expect(rows.every((r) => r.utility_id === null || r.utility_id === utilityId)).toBe(true);
    expect(rows.some((r) => r.utility_id === null)).toBe(true);
  });

  it("give the platform role a way past, since some reads cross tenants", async () => {
    // 24 routes and 6 all-tenants queues need this; Tasks 6 and 7 route
    // them to it. Here it only has to exist and work.
    const rows = await asRole<{ utility_id: string }>(
      "cis_platform",
      "SELECT utility_id::text FROM account",
    );
    expect(new Set(rows.map((r) => r.utility_id)).size).toBe(2);
  });
});
