import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, TENANT_A } from "./_effective-dating-fixtures.js";

/**
 * Invariants that must hold for every tenant-scoped table, asserted
 * against the database rather than against the schema file.
 *
 * Three sweeps during this branch each missed a file that wrote
 * tenant-scoped rows without declaring its tenant, every time in a form
 * the previous sweep could not see: a constant declared inside a test
 * body, an inline literal, an id computed with
 * `TENANT_A.replace(/d1$/, "e1")`, and finally a file outside both
 * globs in vitest.integration.config.ts. Searching source text was the
 * wrong instrument. These ask Postgres instead, so the next model added
 * with a `utilityId` and no relation fails here rather than in whatever
 * feature happens to touch it first.
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");

/** Carries a tenant but is not itself scoped by one. */
const UTILITY_TABLE = "utility";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
}, 180_000);

afterAll(async () => {
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

describe("every tenant-scoped table", () => {
  it("has a foreign key from utility_id to utility(id)", async () => {
    const { prisma } = prismaImports;

    const missing = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT c.table_name
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.column_name = 'utility_id'
        AND NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage k
            ON k.constraint_name = tc.constraint_name
          WHERE tc.constraint_schema = 'public'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_name = c.table_name
            AND k.column_name = 'utility_id'
        )
      ORDER BY 1`;

    expect(missing.map((r) => r.table_name)).toEqual([]);
  });

  /**
   * The blind spot in the policy check below: it derives "tenant-scoped"
   * from *having* a `utility_id`, so a table that ought to carry one and
   * does not is invisible to it — no column, therefore not in the set,
   * therefore never asked whether it has a policy.
   *
   * `import_row` sat in exactly that hole. It holds `raw_data` — the
   * imported CSV, so customer names, addresses and meter readings — and
   * reached a tenant only through `import_batch_id`. Every read derived
   * from a batch whose ownership the caller had proved, so it was safe;
   * but caller discipline is the thing RLS is meant to stop being the
   * only defence, and with no column no policy could back it up.
   *
   * Pinned by name rather than derived, like the nullable set below: a
   * table without a tenant column is a claim that its rows belong to
   * nobody, and that claim should have to be made out loud.
   */
  it("gives every table holding a tenant's data a column to be scoped by", async () => {
    const { prisma } = prismaImports;

    // `_prisma_migrations` is Prisma's own bookkeeping and holds no
    // tenant data. `utility` IS the tenant: its primary key is the id
    // every other table points at, which is what its policy uses.
    const EXEMPT = ["_prisma_migrations", UTILITY_TABLE];

    const untenanted = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'utility_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
        )
      ORDER BY 1`;

    expect(untenanted.map((r) => r.table_name).filter((t) => !EXEMPT.includes(t))).toEqual([]);
  });

  it("has row-level security enabled, with a policy", async () => {
    const { prisma } = prismaImports;

    // Tables that carry a tenant: every utility_id column, plus `utility`
    // itself, whose primary key is the tenant.
    const unprotected = await prisma.$queryRaw<{ table_name: string; why: string }[]>`
      WITH tenant_scoped AS (
        SELECT DISTINCT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'utility_id'
        UNION
        SELECT ${UTILITY_TABLE}
      )
      SELECT t.table_name,
             CASE WHEN NOT c.relrowsecurity THEN 'rls disabled' ELSE 'no policy' END AS why
      FROM tenant_scoped t
      JOIN pg_class c ON c.relname = t.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE NOT c.relrowsecurity
         OR NOT EXISTS (
           SELECT 1 FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = t.table_name
         )
      ORDER BY 1`;

    expect(unprotected.map((r) => `${r.table_name} (${r.why})`)).toEqual([]);
  });

  /**
   * A nullable `utility_id` means "belongs to no tenant", and that is
   * meaningful for exactly two reasons: a global reference row every
   * tenant reads (§1.3), and the platform actor, whose entire definition
   * is having no tenant (Q2).
   *
   * Any other table acquiring a nullable `utility_id` is a table whose
   * rows escape every tenant predicate in the codebase — the predicates
   * are what separate tenants while RLS is inert (§1.7), and
   * `utility_id = $1` does not match NULL. So the set is pinned by name
   * rather than counted: a new name here should fail this test and make
   * someone say why that table has rows belonging to nobody.
   */
  it("allows a null utility_id only where belonging to no tenant is meaningful", async () => {
    const { prisma } = prismaImports;

    const nullable = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'utility_id'
        AND is_nullable = 'YES'
      ORDER BY 1`;

    expect(nullable.map((r) => r.table_name)).toEqual([
      "account_type_def",
      // The platform actor. Not a global reference row — the one
      // identity in the system that sits above tenants.
      "cis_user",
      "measure_type_def",
      "premise_type_def",
      "rate_assignment_role",
      "rate_component_kind",
      "service_request_type_def",
      "suspension_type_def",
    ]);
  });
});
