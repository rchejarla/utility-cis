# RLS Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostgreSQL row-level security actually refuse a cross-tenant read, so tenant isolation no longer rests solely on every query remembering its `utility_id` predicate.

**Architecture:** Three database roles in place of one. `cis` keeps the schema and runs migrations; a new non-owning `cis_app` runs the application and is subject to RLS; a new `cis_platform` holds `BYPASSRLS` and serves only the paths that cross tenants by design. `FORCE ROW LEVEL SECURITY` on every policied table so ownership can never silently reopen the hole. Tenant context reaches the database through a Prisma driver adapter that sets `app.current_utility_id` when a connection is checked out and resets it on release, with the tenant carried in `AsyncLocalStorage` — because middleware cannot pin a pooled connection to a request, and 432 call sites cannot each be rewritten to thread a transaction.

**Tech Stack:** PostgreSQL 16 + TimescaleDB, **Prisma 7** + `@prisma/adapter-pg`, Fastify, BullMQ, Vitest (testcontainers for integration).

> **Prisma 7 is a precondition, discovered during execution.** Prisma 6's
> query engine is a boundary that drops AsyncLocalStorage: the checkout hook
> in Task 5 read `null` no matter who the caller was acting for, measured
> both through `$queryRaw` and `$transaction`. Tasks 3–5 were attempted on
> 6.19, reverted, and the upgrade was done on its own branch and merged
> (`7b63972`, tagged `pre-prisma-7`). Prisma 7 runs the query compiler in
> process and the context survives — verified on every path this codebase
> uses before the upgrade was begun. Do not attempt connection-level tenant
> context on Prisma 6.

**Spec:** `docs/design/utility-cis-architecture.md` §7.1 "Current gaps". It is the authority for this plan: it already names both bypasses, the role-split-or-FORCE choice, the per-transaction context requirement, and the policy fail-mode inconsistency. Where this plan and §7.1 disagree, §7.1 wins and the plan is wrong.

## Measured starting state

Verified against the running dev database on 2026-10-24, not inferred:

| Fact | Value |
|---|---|
| App role | `cis` — `rolsuper = true`, owns all 64 public tables |
| Tables with RLS enabled | 62 of 64 (`_prisma_migrations` and `import_row` have none — see Task 2b) |
| Tables with both `id` and `utility_id` | 60 |
| `utility` | `id` only — it **is** the tenant, so its policy keys on `id` |
| `service_request_counter` | `utility_id` only, composite PK `(utility_id, year)`, policied |
| `import_row` | `id` only, no tenant column, no policy |
| Tables with `relforcerowsecurity` | **0** |
| Policies | 62, all `FOR ALL`, all on `utility_id = current_setting('app.current_utility_id')::uuid` |
| Policy failure mode | 36 one-arg (raises when unset) / 26 two-arg — but see the breakdown below, which is what matters |
| `withTenant` call sites | 5 |
| Bare `prisma.<model>.<op>(` call sites, non-test | 432 across 83 files |
| `tx.<model>.<op>(` call sites, non-test | 162 |
| Raw SQL call sites, non-test | 31 |
| Routes declaring `{ platform: true }` | 24 |
| Queues marked `all-tenants` | 6 |

Proof the policies themselves are sound — same table, same statement, two roles:

```
as cis (superuser+owner):  Seq Scan on account              -- no Filter
as an ordinary role:       Seq Scan on account
                             Filter: (utility_id = (current_setting('app.current_utility_id'))::uuid)
```

So this plan mostly changes **who connects**, not what the policies say. The
exceptions are below, and they are not the ones a count of one-arg versus
two-arg suggests.

### How every policy is created

All of it comes from migrations. There is no manual step and no standalone
script: `setup_db.bat` starts the containers and runs `prisma migrate deploy`,
and the 8 migrations on disk are the whole database. The 62 `ENABLE ROW LEVEL
SECURITY` statements, the 62 `CREATE POLICY` statements and the 35 CHECK
constraints all live in one 394-line file,
`20261018150001_database_features/migration.sql`, hand-written as literal DDL
per table — `schema.prisma` cannot express any of it, which is why
`prisma migrate dev` is forbidden here.

One correction to CLAUDE.md while we are here: it describes `setup_db.bat` as
"start containers + push schema + apply RLS". There is no `db push` and no
separate RLS step; it is `migrate deploy` and nothing else.

### The four kinds of policy, which is what Task 2 acts on

Classifying all 62 by what they actually do when `app.current_utility_id` is
unset:

| Group | Count | Form | Verdict |
|---|---|---|---|
| Tenant tables, one-arg | 33 | `utility_id = current_setting(…)` | **Correct** — raises `22023` |
| Tenant tables, two-arg, no NULL branch | 21 | `utility_id = current_setting(…, true)` | **Wrong** — NULL comparison yields no rows and no error. `bill`, `ledger_entry`, `billing_run`, `utility`, `user_role` among them |
| Global reference, two-arg **with** `utility_id IS NULL OR …` | 5 | `account_type_def`, `measure_type_def`, `premise_type_def`, `rate_assignment_role`, `rate_component_kind` | **Correct as written** — a global row matches through the NULL branch regardless, so an unset context yields the globals rather than an error. Do **not** convert these |
| Global reference, one-arg with a NULL branch | 2 | `service_request_type_def`, `suspension_type_def` | Raises where the five above return globals. Harmless but inconsistent |

The naive reading — "unify all 26 two-arg policies on the fail-loud form" —
would break the five global reference tables by making a legitimate read of
rows that belong to no tenant raise. **The scope is the 21 tenant tables.**

### A defect this classification found: the platform actor is invisible to itself

`cis_user` has a nullable `utility_id`, and the platform actor is *defined* as
the row where it is null. Its policy is:

```sql
CREATE POLICY tenant_isolation ON cis_user
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
```

No `IS NULL` branch. So the moment RLS binds, `getPlatformActor` cannot read
the row that authorises every platform route, and all 24 of them answer 403 —
for a reason that has nothing to do with the role split in Task 6 and would
look exactly like it. Task 2a fixes this, and it must land before Task 8.

## Global Constraints

- **Never run `prisma migrate dev` against this schema** (CLAUDE.md). It would generate a migration reverting the 35 CHECK constraints, 6 generated columns, 62 RLS policies, hypertable, trigger, exclusion constraint and 6 partial indexes that `schema.prisma` cannot express. Hand-write migrations; verify with `migrate diff` read line by line.
- Migrations are forward-only. Recreating the dev database is the supported reset (CLAUDE.md), and losing the data is the intent.
- No vendor credential belongs in this codebase. The new roles' passwords are dev-only in `docker/init-cis-user.sh`; production credentials come from the deployment environment and are never committed.
- Integration tests must not enqueue into the dev Redis (CLAUDE.md) — mock `enqueueSafely`.
- Integration tests that care *which* permissions a subject holds must `cacheDel` the `rbac.service` keys after seeding; Postgres is a fresh container each run and Redis database 9 is not.
- Every entity has `utility_id`; it is nullable on exactly seven global reference tables plus `cis_user`, and `schema-invariants.integration.test.ts` pins that set.
- The platform actor is a `CisUser` with a **null** `utility_id` and holds no `user_role` row.

## Review Focus

Input classes and failure modes the spec implies that no task's tests exercise directly. Each line's test is added to the owning task.

1. **A query that runs with no tenant context at all.** 21 tenant-table policies return NULL when `app.current_utility_id` is unset and so filter every row away silently; an empty result reads as "nothing is wrong". Task 2 makes those raise — and its second case stops the fix reaching the 7 policies where a NULL branch is the correct answer.
1b. **A read of rows that belong to no tenant.** The global reference tables and the platform actor's own `cis_user` row are legitimately tenant-less. Task 2's second case and Task 2a cover them; getting this wrong fails closed and looks like a role problem.
2. **A connection returned to the pool still carrying a tenant.** This is the leak §7.1 measured and had removed; the driver adapter reintroduces the shape and must reset on release. Task 5.
3. **An all-tenants worker sweeping under `cis_app`.** Six queues pass over every tenant in one process; under RLS they would return zero rows and report success. Task 7.
4. **A platform route under `cis_app`.** 24 routes list or act across tenants; the console would render empty rather than error. Task 6.
5. **A nested transaction inside a request that already set the GUC.** `withTenant` and `auditCreate`/`auditUpdate` both open transactions; a `SET LOCAL` in an inner one must not clear the outer's value on commit. Task 5.

---

### Task 1: Split the role, and prove the bypass is real before closing it

**Files:**
- Create: `packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts`
- Modify: `docker/init-cis-user.sh`
- Create: `packages/shared/prisma/migrations/20261024100000_rls_roles/migration.sql`

**Interfaces:**
- Produces: roles `cis_app` (NOSUPERUSER, no ownership, DML only) and `cis_platform` (NOSUPERUSER, no ownership, `BYPASSRLS`); `cis` unchanged as owner/migrator.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test** — a characterisation test that pins today's behaviour so the change is visible.

```ts
it("lets the application role read another tenant's rows today", async () => {
  const { prisma } = prismaImports;
  await seedTwoTenants(prisma); // TENANT_A and TENANT_B, one account each
  const rows = await prisma.$queryRaw<{ utility_id: string }[]>`
    SELECT set_config('app.current_utility_id', ${TENANT_A}, true);
    SELECT utility_id::text FROM account`;
  // The defect, stated as the expectation so the fix flips it.
  expect(rows.map((r) => r.utility_id)).toContain(TENANT_B);
});

it("has no table on which ownership cannot reopen the hole", async () => {
  const [{ unforced }] = await prisma.$queryRaw<{ unforced: bigint }[]>`
    SELECT count(*) AS unforced FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity`;
  expect(Number(unforced)).toBe(0); // fails at 62 today
});
```

- [ ] **Step 2: Run it** — `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-enforcement.integration.test.ts`. Expected: the first case PASSES (the bypass is real), the second FAILS with `expected 62 to be 0`.
- [ ] **Step 3: Write the migration** creating both roles idempotently (`DO $$ ... IF NOT EXISTS (SELECT 1 FROM pg_roles ...)`), granting `USAGE ON SCHEMA public` and `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` plus `USAGE ON ALL SEQUENCES` to each, and `ALTER DEFAULT PRIVILEGES FOR ROLE cis IN SCHEMA public GRANT ... TO cis_app, cis_platform` so tables added by later migrations are covered without a second grant pass. `ALTER ROLE cis_platform BYPASSRLS`. No password in the migration — set in `init-cis-user.sh` for dev and by the environment in production.
- [ ] **Step 4: Add `FORCE ROW LEVEL SECURITY`** to every policied table in the same migration, generated from `pg_class` rather than a hand-typed list of 62.
- [ ] **Step 5: Run the test** — Expected: the second case PASSES. The first still passes, because `cis` is still superuser; it is Task 8 that flips it.
- [ ] **Step 6: Commit**

```bash
git add docker/init-cis-user.sh packages/shared/prisma/migrations/20261024100000_rls_roles packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts
git commit -m "feat(db): a non-owning application role, and FORCE on every policied table"
```

---

### Task 2: One failure mode for all 62 policies

**Files:**
- Create: `packages/shared/prisma/migrations/20261024110000_rls_fail_loud/migration.sql`
- Modify: `packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts`

**Interfaces:**
- Consumes: the roles from Task 1.
- Produces: all 54 tenant-table policies on the one-argument form, which raises `22023` when unset. The 7 global reference policies keep a NULL branch and stay silent-but-correct.

§7.1: *"fail-loud is the safer of the two for a table whose emptiness would be read as 'nothing is wrong'"*. That applies to a **tenant** table. It does not apply to a table whose rows legitimately belong to no tenant, where the NULL branch is the answer and raising would be the bug — which is why the scope here is 21 tables and not 26. See "The four kinds of policy" above.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses loudly, not emptily, when a tenant table is read with no tenant set", async () => {
  await expect(
    asRole("cis_app", (c) => c.query("SELECT id FROM ledger_entry")),
  ).rejects.toMatchObject({ code: "22023" });
});

it("still serves rows that belong to no tenant, with no tenant set", async () => {
  // The five global reference tables are not a bug to be unified away.
  const rows = await asRole("cis_app", (c) =>
    c.query("SELECT code FROM account_type_def WHERE utility_id IS NULL"));
  expect(rows.rowCount).toBeGreaterThan(0);
});

it("leaves no tenant table able to answer emptily", async () => {
  const [{ silent }] = await prisma.$queryRaw<{ silent: bigint }[]>`
    SELECT count(*) AS silent FROM pg_policies
    WHERE schemaname = 'public' AND qual LIKE '%, true)%' AND qual NOT LIKE '%IS NULL%'`;
  expect(Number(silent)).toBe(0); // fails at 21 today
});
```

- [ ] **Step 2: Run it** — Expected: the third case FAILS with `expected 21 to be 0`; the second already passes and is there to stop the fix overreaching.
- [ ] **Step 3: Write the migration** — `DROP POLICY` / `CREATE POLICY` for the 21 tables whose qual has the two-argument form **and no `IS NULL` branch**, generated from `pg_policies` with exactly that predicate so the five global ones cannot be swept up. Keep the name `tenant_isolation`. `utility`'s policy is keyed on `id`, not `utility_id` — preserve that.
- [ ] **Step 4: Run it** — Expected: PASS, all three.
- [ ] **Step 5: Commit** — `fix(db): a tenant table may not answer emptily when no tenant is set`

---

### Task 2a: Let the platform actor be read

**Files:**
- Create: `packages/shared/prisma/migrations/20261024120000_rls_platform_actor/migration.sql`
- Modify: `packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts`

**Interfaces:**
- Produces: `cis_user`'s policy admitting the row whose `utility_id` is null.

Found while classifying the policies for Task 2, and it must land before Task 8 or Task 6 fails for the wrong reason. The platform actor *is* the `cis_user` row with a null `utility_id`; the current policy has no NULL branch and so hides it from the query that authorises all 24 platform routes.

- [ ] **Step 1: Write the failing test**

```ts
it("can still find the platform actor once RLS binds", async () => {
  await seedPlatformActor(prisma); // utility_id: null, is_active: true
  const rows = await asRole("cis_app", (c) =>
    c.query("SELECT id FROM cis_user WHERE utility_id IS NULL"));
  expect(rows.rowCount).toBe(1);
});

it("does not thereby expose another tenant's staff", async () => {
  // The NULL branch must widen the policy by exactly one row shape.
  await asRole("cis_app", (c) =>
    c.query("SELECT set_config('app.current_utility_id', $1, false)", [TENANT_A]));
  const rows = await asRole("cis_app", (c) => c.query("SELECT utility_id FROM cis_user"));
  expect(rows.rows.every((r) => r.utility_id === null || r.utility_id === TENANT_A)).toBe(true);
});
```

- [ ] **Step 2: Run it** — Expected: the first FAILS with `expected 0 to be 1`.
- [ ] **Step 3: Write the migration** — recreate `cis_user`'s policy as `utility_id IS NULL OR utility_id = current_setting('app.current_utility_id')::uuid`, matching the shape the global reference tables already use.
- [ ] **Step 4: Run it** — Expected: PASS, both.
- [ ] **Step 5: Commit** — `fix(db): the platform actor is a row RLS was hiding from the query that reads it`

---

### Task 2b: Give `import_row` a tenant to be scoped by — **DONE 2026-10-24**

**Files:**
- Create: `packages/shared/prisma/migrations/20261024130000_import_row_tenant/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma` (`ImportRow`)
- Modify: `packages/api/src/services/imports.service.ts` (the one `createMany`)
- Modify: `packages/api/src/__tests__/integration/schema-invariants.integration.test.ts`

**Interfaces:**
- Produces: `import_row.utility_id`, NOT NULL, FK to `utility(id)` `ON DELETE RESTRICT`, with RLS enabled, forced, and a `tenant_isolation` policy like every other tenant table's.

`import_row` is the one tenant-bearing table with **no `utility_id`, no policy, and RLS not even enabled**. It holds `raw_data jsonb` — the imported CSV content, so customer names, addresses and meter data — and reaches a tenant only through `import_batch_id → import_batch.utility_id`.

It is safe today, and the way it is safe is the problem: every read derives from a batch whose ownership the caller proved first (`imports.service.ts:441` is the good example — `findFirstOrThrow({ where: { id: batchId, utilityId } })` before anything else). That is caller discipline, which is precisely what this plan exists to stop being the only defence. With no `utility_id` column, no policy can back it up — not even after Task 8.

Denormalising the column is the right fix rather than a policy that joins through the batch: a subquery in a `USING` clause runs per row, and this table holds one row per imported CSV line.

- [x] **Step 1: Write the failing test** — in `schema-invariants`, assert that every table carrying tenant data has a `utility_id` and a `tenant_isolation` policy, with `_prisma_migrations` and `utility` as the only exemptions (`utility` because its own `id` *is* the tenant id, which its policy already uses).
- [x] **Step 2: Run it** — FAILED with `expected [ 'import_row' ] to deeply equal []`.
- [x] **Step 3: Write the migration** — add the column nullable, `UPDATE import_row r SET utility_id = b.utility_id FROM import_batch b WHERE b.id = r.import_batch_id`, then `SET NOT NULL`, add the FK, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and the one-argument `tenant_isolation` policy.
- [x] **Step 4: Set it on write** — `imports.service.ts:170`'s `createMany` is the only creator; it already has the batch in hand.
- [x] **Step 5: Run it** — invariants 4/4, imports integration 28/28. The 4 `update` sites addressed rows by id and needed nothing.
- [x] **Step 6: Commit** — `fix(db): import_row carries the tenant whose data it holds`

---

### Task 3: Enable driver adapters — **SATISFIED BY THE PRISMA 7 MERGE**

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` (generator `previewFeatures`)
- Modify: `packages/shared/package.json`, `packages/api/package.json` (`@prisma/adapter-pg`, `pg`)
- Modify: `packages/api/src/lib/prisma.ts`

**Interfaces:**
- Produces: `prisma` still exported from `lib/prisma.ts` with an unchanged type, now constructed over a `pg` Pool this codebase owns. Every one of the 432 call sites keeps working untouched.

**Nothing to do.** Prisma 7 removed the built-in engine, so a driver adapter
is mandatory rather than opt-in, and `lib/prisma.ts` on `main` already
constructs over an owned `pg` pool and exports it. The `previewFeatures =
["driverAdapters"]` step below is obsolete: the feature is GA and declaring
it only earns a deprecation warning.

- [ ] **Step 1: Write the failing test** — `packages/api/src/__tests__/lib/prisma-adapter.test.ts`

```ts
it("runs on a pool this process owns, so connection lifecycle is ours to hook", async () => {
  const { pool } = await import("../../lib/prisma.js");
  expect(pool).toBeDefined();
  expect(typeof pool.on).toBe("function");
});
```

- [ ] **Step 2: Run it** — Expected: FAIL, `pool` is not exported.
- [ ] **Step 3: Add `previewFeatures = ["driverAdapters"]`**, install `@prisma/adapter-pg` and `pg`, and construct `new PrismaClient({ adapter: new PrismaPg(pool) })` in `lib/prisma.ts`, exporting `pool`. Regenerate the client.
- [ ] **Step 4: Run the whole API suite** — `npx vitest run` in `packages/api`. Expected: 789 passed, 1 skipped. A driver-adapter swap changes the transport under every query; if anything here moves, stop and read it rather than proceeding.
- [ ] **Step 5: Run the integration suites that exercise real SQL** — `billing-run`, `ledger-*`, `bill-document`. Expected: all pass. These carry the raw SQL and the hypertable.
- [ ] **Step 6: Commit** — `refactor(db): own the connection pool, so tenant context has somewhere to live`

---

### Task 4: Carry the tenant in AsyncLocalStorage — **DONE**

**Files:**
- Create: `packages/api/src/lib/tenant-context.ts`
- Create: `packages/api/src/__tests__/lib/tenant-context.test.ts`

**Interfaces:**
- Produces:
  - `runAsTenant<T>(utilityId: string, fn: () => Promise<T>): Promise<T>`
  - `runAsPlatform<T>(fn: () => Promise<T>): Promise<T>`
  - `currentTenant(): { kind: "tenant"; utilityId: string } | { kind: "platform" } | null`

- [ ] **Step 1: Write the failing tests** — that a tenant set in one async branch is invisible to a sibling branch; that nesting restores the outer value on exit; that `currentTenant()` is `null` outside any scope.
- [ ] **Step 2: Run them** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** over `node:async_hooks` `AsyncLocalStorage`.
- [ ] **Step 4: Run them** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): carry the acting tenant across async boundaries`

---

### Task 5: Set the GUC on checkout, reset it on release — **DONE**

**Files:**
- Modify: `packages/api/src/lib/prisma.ts`
- Modify: `packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts`

**Interfaces:**
- Consumes: `pool` (Task 3), `currentTenant()` (Task 4).
- Produces: nothing new; behaviour only.

This is Review Focus 2 and 5, and the task most likely to be subtly wrong. §7.1 measured the residue this shape produces when it is not reset.

- [ ] **Step 1: Write the failing tests**

```ts
it("leaves no tenant on a connection it returns to the pool", async () => {
  await runAsTenant(TENANT_A, () => prisma.account.findMany());
  // Same pool, no scope: the setting must be gone, not inherited.
  const [{ setting }] = await prisma.$queryRaw<{ setting: string | null }[]>`
    SELECT current_setting('app.current_utility_id', true) AS setting`;
  expect(setting).toBeNull();
});

it("restores the outer tenant when an inner transaction commits", async () => {
  await runAsTenant(TENANT_A, async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_utility_id', ${TENANT_A}, true)`;
    });
    const rows = await prisma.account.findMany();
    expect(rows.every((r) => r.utilityId === TENANT_A)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them** — Expected: the first FAILS (nothing sets or resets anything yet).
- [ ] **Step 3: Implement** — on `pool.on("connect")` nothing; on each acquisition set `app.current_utility_id` from `currentTenant()`, and on release issue `RESET app.current_utility_id`. Where `pg`'s pool does not expose acquisition directly, wrap `pool.connect` rather than reaching into internals, and say so in a comment.
- [ ] **Step 4: Run them** — Expected: PASS.
- [ ] **Step 5: Run the full API suite and the three real-SQL integration suites.** Expected: unchanged counts.
- [ ] **Step 6: Commit** — `feat(db): set the acting tenant on checkout and clear it on release`

---

### Task 6: Platform routes act as the platform role

**Files:**
- Modify: `packages/api/src/middleware/authorization.ts`
- Modify: `packages/api/src/lib/prisma.ts` (a second client over a `cis_platform` pool)
- Modify: `packages/api/src/__tests__/integration/platform-tenants.test.ts`

**Interfaces:**
- Consumes: `runAsPlatform` (Task 4), `cis_platform` (Task 1).
- Produces: `prismaPlatform`, used only where `{ config: { platform: true } }` is declared.

- [ ] **Step 1: Write the failing test** — that `GET /api/v1/platform/utilities` returns every tenant while `cis_app` is the application role and RLS is enforced, and that a tenant route cannot reach `prismaPlatform`.
- [ ] **Step 2: Run it** — Expected: FAIL (returns one tenant, or zero).
- [ ] **Step 3: Implement** — `getPlatformActor` wraps the handler in `runAsPlatform`; platform services take `prismaPlatform`. Keep the two clients distinguishable by type so a tenant route cannot pick up the wrong one by habit.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(platform): the console reads across tenants through a role that may`

---

### Task 7: All-tenant workers act as the platform role

**Files:**
- Modify: `packages/api/src/worker.ts`, the six handlers named by `QUEUE_TENANCY === "all-tenants"`
- Create: `packages/api/src/__tests__/integration/worker-tenancy-rls.integration.test.ts`

**Interfaces:**
- Consumes: `runAsPlatform`, `prismaPlatform`.

Review Focus 3. A sweep that returns zero rows reports success, so the test asserts work *done*, not absence of error.

- [ ] **Step 1: Write the failing test** — two tenants, each with one breached SLA; run the sweep under the application role; assert it flags **both**. Then assert `QUEUE_TENANCY` and the set of handlers wrapped in `runAsPlatform` agree, so a seventh all-tenants queue cannot be added without this.
- [ ] **Step 2: Run it** — Expected: FAIL once RLS binds; today it passes for the wrong reason, so run it after Task 8's flag is available and assert both tenants.
- [ ] **Step 3: Implement** — wrap each all-tenants handler in `runAsPlatform`. Per-tenant handlers (`imports`, `delinquency-tenant`, `billing-runs`) wrap in `runAsTenant` with the id from the job payload.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(worker): a cross-tenant sweep says which authority it sweeps with`

---

### Task 8: Flip the application to `cis_app`, behind a flag

**Files:**
- Modify: `packages/api/src/config.ts`, `.env.example`, `docker/init-cis-user.sh`
- Modify: `packages/api/src/__tests__/integration/rls-enforcement.integration.test.ts`

**Interfaces:**
- Produces: `DATABASE_URL` pointing at `cis_app`; `DATABASE_URL_PLATFORM` at `cis_platform`; `DATABASE_URL_MIGRATE` at `cis`.

- [x] **Step 1: Invert Task 1's characterisation test** — "lets the application role read another tenant's rows today" becomes **"refuses another tenant's rows"**, asserting an empty result for a scoped read and `22023` for an unscoped one.
- [x] **Step 2: Run it** — Expected: FAIL while the app still connects as `cis`.
- [x] **Step 3: Point the application at `cis_app`** and migrations at `cis`. Keep `ALTER ROLE cis SUPERUSER` for the owner only.
- [x] **Step 4: Run it** — Expected: PASS.
- [x] **Step 5: Run every suite** — full API unit, every `*.integration.test.ts`, and the web suite. Expected: this is where a query that never had tenant context surfaces, as an empty result or a `22023`. Each one found is a real defect of the kind §7.1 describes, not a test to adjust: fix the query, and record it in the commit.
- [x] **Step 6: Commit** — `feat(db): the application connects as a role RLS applies to`

---

### Task 9: Refuse to boot with a bypassing role in production

**Files:**
- Modify: `packages/api/src/app.ts`, `packages/api/src/worker.ts`
- Create: `packages/api/src/__tests__/app/rls-boot-guard.test.ts`

**Interfaces:**
- Produces: `assertRlsEnforced(): Promise<void>` in `lib/prisma.ts`.

The whole plan is undone by one `ALTER ROLE ... SUPERUSER` in a deployment script. This makes that a startup failure rather than a silent regression, which is the same reason `schema-invariants.integration.test.ts` exists.

- [x] **Step 1: Write the failing test** — that boot throws when `current_user` is `rolsuper` or `rolbypassrls`, or when any policied table lacks `relforcerowsecurity`, and that in development it warns and continues instead.
- [x] **Step 2: Run it** — Expected: FAIL, function not defined.
- [x] **Step 3: Implement** — one query against `pg_roles` and `pg_class`; throw in production, `logger.warn` otherwise.
- [x] **Step 4: Run it** — Expected: PASS.
- [x] **Step 5: Commit** — `feat(api): refuse to start in production as a role that bypasses RLS`

---

### Task 10: Say what is true now

**Files:**
- Modify: `docs/design/utility-cis-architecture.md` §7.1 and the §86 / §126 cross-references
- Modify: `CLAUDE.md` (Multi-tenancy section)
- Modify: `docs/specs/19-rbac.md`

- [x] **Step 1: Rewrite §7.1's "RLS does not currently enforce"** as what was wrong, what was done and what the reader must not undo — the two bypasses, the role split, FORCE, the unified fail-loud form, and the two deliberate `BYPASSRLS` paths with the list of what uses them.
- [x] **Step 2: Correct the three places that say isolation rests only on application predicates** (architecture line 86, line 126, CLAUDE.md's Multi-tenancy paragraph). They are accurate today and must not be left behind as the reason someone re-reads this as unsolved.
- [x] **Step 3: Record what is exempt and why** — `_prisma_migrations` (not tenant data) and `utility` (its own `id` is the tenant id, which its policy uses). `import_row` is no longer an exemption; Task 2b gave it a column.
- [x] **Step 4: Commit** — `docs: RLS enforces, and here is what not to undo`

---

## Self-review

**Spec coverage.** §7.1 names: superuser bypass (Task 8), owner bypass (Task 1 FORCE + role split), `CREATEDB` for the shadow database (not applicable — `migrate dev` is forbidden here, noted in Global Constraints), per-transaction context (Tasks 4–5), the policy fail-mode split (Task 2), and that `withTenant` being a sweep rather than a switch is why the adapter exists (Task 3–5). The audit of seven unscoped queries is the *reason* for the plan, not a task.

**Where this plan corrects §7.1.** §7.1 says the two-argument policies are "the `ledger_*` tables". They are 26 policies across four different situations, only 21 of which are wrong, and `ledger_*` is three of those 21. Task 2's scope comes from the classification above, not from that sentence. §7.1 also does not mention `cis_user`'s missing NULL branch, which is Task 2a and is the single defect here most likely to be misread as something else.

**Interface consistency.** `runAsTenant` / `runAsPlatform` / `currentTenant` are produced in Task 4 and consumed in 5, 6 and 7 under those exact names. `pool` is produced in 3 and consumed in 5. `prismaPlatform` is produced in 6 and consumed in 7.

**Proportion.** The plan is longer than any one task's diff and shorter than the change; the length is in decisions — which role, which fail mode, where context lives — not in transcribed bodies.

**The open risk, stated rather than hidden.** Task 8 step 5 is the step that cannot be sized in advance: 432 call sites have never run under an enforcing policy, and the ones that never establish context will fail there. That is the plan working — each is a real cross-tenant defect — but the count is unknown until it runs, and it may be large enough to want its own plan. Do not "fix" them by widening a policy or wrapping a query in `runAsPlatform`; that converts a found defect into a permanent hole.

**Alternative considered and rejected.** Threading `withTenant` through all 432 call sites is the obvious reading of §7.1's "that is a sweep, not a switch". Rejected because it changes every service signature, makes every read a transaction, and leaves the invariant where it is today — in application code remembering something. The adapter puts it in the connection, where forgetting is not possible. The cost is a `pg` pool this repo now owns and a driver-adapter preview feature.
