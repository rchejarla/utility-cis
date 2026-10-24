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
