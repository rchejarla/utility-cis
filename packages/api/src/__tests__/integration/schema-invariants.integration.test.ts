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
  await prismaImports?.prisma.$disconnect().catch(() => {});
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
