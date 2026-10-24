# RLS Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostgreSQL row-level security actually refuse a cross-tenant read, so tenant isolation no longer rests solely on every query remembering its `utility_id` predicate.

**Architecture:** Three database roles in place of one. `cis` keeps the schema and runs migrations; a new non-owning `cis_app` runs the application and is subject to RLS; a new `cis_platform` holds `BYPASSRLS` and serves only the paths that cross tenants by design. `FORCE ROW LEVEL SECURITY` on every policied table so ownership can never silently reopen the hole. Tenant context reaches the database through a Prisma driver adapter that sets `app.current_utility_id` when a connection is checked out and resets it on release, with the tenant carried in `AsyncLocalStorage` — because middleware cannot pin a pooled connection to a request, and 432 call sites cannot each be rewritten to thread a transaction.

**Tech Stack:** PostgreSQL 16 + TimescaleDB, Prisma 6.2.1 (`driverAdapters` preview + `@prisma/adapter-pg`), Fastify, BullMQ, Vitest (testcontainers for integration).

**Spec:** `docs/design/utility-cis-architecture.md` §7.1 "Current gaps". It is the authority for this plan: it already names both bypasses, the role-split-or-FORCE choice, the per-transaction context requirement, and the policy fail-mode inconsistency. Where this plan and §7.1 disagree, §7.1 wins and the plan is wrong.

## Measured starting state

Verified against the running dev database on 2026-10-24, not inferred:

| Fact | Value |
|---|---|
| App role | `cis` — `rolsuper = true`, owns all 64 public tables |
| Tables with RLS enabled | 62 of 64 (`_prisma_migrations` and `import_row` have none) |
| Tables with `relforcerowsecurity` | **0** |
| Policies | 62, all `FOR ALL`, all on `utility_id = current_setting('app.current_utility_id')::uuid` |
| Policy failure mode | **36 one-arg** (raises when unset) / **26 two-arg** (returns NULL — silently filters every row) |
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

So this plan changes **who connects**, not what the policies say.

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

1. **A query that runs with no tenant context at all.** 26 policies return NULL when `app.current_utility_id` is unset and so filter every row away silently; an empty result reads as "nothing is wrong". Task 2 unifies the form and Task 9 asserts the refusal is loud.
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
- Produces: every policy on the one-argument `current_setting('app.current_utility_id')::uuid` form, which raises `22023` when unset.

§7.1: *"fail-loud is the safer of the two for a table whose emptiness would be read as 'nothing is wrong'"*. The 26 two-argument policies are all `ledger_*`, which is exactly where an empty result is most dangerous.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses loudly, not emptily, when no tenant is set", async () => {
  await expect(
    asRole("cis_app", (c) => c.query("SELECT id FROM ledger_entry")),
  ).rejects.toMatchObject({ code: "22023" }); // unrecognized configuration parameter
});

it("uses one failure mode across every policy", async () => {
  const [{ two_arg }] = await prisma.$queryRaw<{ two_arg: bigint }[]>`
    SELECT count(*) AS two_arg FROM pg_policies
    WHERE schemaname = 'public' AND qual LIKE '%, true)%'`;
  expect(Number(two_arg)).toBe(0); // fails at 26 today
});
```

- [ ] **Step 2: Run it** — Expected: FAIL, `expected 26 to be 0`.
- [ ] **Step 3: Write the migration** — `DROP POLICY` / `CREATE POLICY` per affected table, generated from `pg_policies` where the qual contains the two-argument form. Keep the policy name `tenant_isolation`.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(db): one failure mode for every tenant policy, and it is loud`

---

### Task 3: Enable driver adapters

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` (generator `previewFeatures`)
- Modify: `packages/shared/package.json`, `packages/api/package.json` (`@prisma/adapter-pg`, `pg`)
- Modify: `packages/api/src/lib/prisma.ts`

**Interfaces:**
- Produces: `prisma` still exported from `lib/prisma.ts` with an unchanged type, now constructed over a `pg` Pool this codebase owns. Every one of the 432 call sites keeps working untouched.

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

### Task 4: Carry the tenant in AsyncLocalStorage

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

### Task 5: Set the GUC on checkout, reset it on release

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

- [ ] **Step 1: Invert Task 1's characterisation test** — "lets the application role read another tenant's rows today" becomes **"refuses another tenant's rows"**, asserting an empty result for a scoped read and `22023` for an unscoped one.
- [ ] **Step 2: Run it** — Expected: FAIL while the app still connects as `cis`.
- [ ] **Step 3: Point the application at `cis_app`** and migrations at `cis`. Keep `ALTER ROLE cis SUPERUSER` for the owner only.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Run every suite** — full API unit, every `*.integration.test.ts`, and the web suite. Expected: this is where a query that never had tenant context surfaces, as an empty result or a `22023`. Each one found is a real defect of the kind §7.1 describes, not a test to adjust: fix the query, and record it in the commit.
- [ ] **Step 6: Commit** — `feat(db): the application connects as a role RLS applies to`

---

### Task 9: Refuse to boot with a bypassing role in production

**Files:**
- Modify: `packages/api/src/app.ts`, `packages/api/src/worker.ts`
- Create: `packages/api/src/__tests__/app/rls-boot-guard.test.ts`

**Interfaces:**
- Produces: `assertRlsEnforced(): Promise<void>` in `lib/prisma.ts`.

The whole plan is undone by one `ALTER ROLE ... SUPERUSER` in a deployment script. This makes that a startup failure rather than a silent regression, which is the same reason `schema-invariants.integration.test.ts` exists.

- [ ] **Step 1: Write the failing test** — that boot throws when `current_user` is `rolsuper` or `rolbypassrls`, or when any policied table lacks `relforcerowsecurity`, and that in development it warns and continues instead.
- [ ] **Step 2: Run it** — Expected: FAIL, function not defined.
- [ ] **Step 3: Implement** — one query against `pg_roles` and `pg_class`; throw in production, `logger.warn` otherwise.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): refuse to start in production as a role that bypasses RLS`

---

### Task 10: Say what is true now

**Files:**
- Modify: `docs/design/utility-cis-architecture.md` §7.1 and the §86 / §126 cross-references
- Modify: `CLAUDE.md` (Multi-tenancy section)
- Modify: `docs/specs/19-rbac.md`

- [ ] **Step 1: Rewrite §7.1's "RLS does not currently enforce"** as what was wrong, what was done and what the reader must not undo — the two bypasses, the role split, FORCE, the unified fail-loud form, and the two deliberate `BYPASSRLS` paths with the list of what uses them.
- [ ] **Step 2: Correct the three places that say isolation rests only on application predicates** (architecture line 86, line 126, CLAUDE.md's Multi-tenancy paragraph). They are accurate today and must not be left behind as the reason someone re-reads this as unsolved.
- [ ] **Step 3: Record the two tables with no policy** — `_prisma_migrations` (not tenant data) and `import_row` (scope inherited from its batch; confirm and state which).
- [ ] **Step 4: Commit** — `docs: RLS enforces, and here is what not to undo`

---

## Self-review

**Spec coverage.** §7.1 names: superuser bypass (Task 8), owner bypass (Task 1 FORCE + role split), `CREATEDB` for the shadow database (not applicable — `migrate dev` is forbidden here, noted in Global Constraints), per-transaction context (Tasks 4–5), the policy fail-mode split (Task 2), and that `withTenant` being a sweep rather than a switch is why the adapter exists (Task 3–5). The audit of seven unscoped queries is the *reason* for the plan, not a task.

**Interface consistency.** `runAsTenant` / `runAsPlatform` / `currentTenant` are produced in Task 4 and consumed in 5, 6 and 7 under those exact names. `pool` is produced in 3 and consumed in 5. `prismaPlatform` is produced in 6 and consumed in 7.

**Proportion.** The plan is longer than any one task's diff and shorter than the change; the length is in decisions — which role, which fail mode, where context lives — not in transcribed bodies.

**The open risk, stated rather than hidden.** Task 8 step 5 is the step that cannot be sized in advance: 432 call sites have never run under an enforcing policy, and the ones that never establish context will fail there. That is the plan working — each is a real cross-tenant defect — but the count is unknown until it runs, and it may be large enough to want its own plan. Do not "fix" them by widening a policy or wrapping a query in `runAsPlatform`; that converts a found defect into a permanent hole.

**Alternative considered and rejected.** Threading `withTenant` through all 432 call sites is the obvious reading of §7.1's "that is a sweep, not a switch". Rejected because it changes every service signature, makes every read a transaction, and leaves the invariant where it is today — in application code remembering something. The adapter puts it in the connection, where forgetting is not possible. The cost is a `pg` pool this repo now owns and a driver-adapter preview feature.
