# Utility Entity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tenant a row — a `Utility` entity with a foreign key from every `utility_id` — so that provisioning and the platform actor have something to operate on.

**Architecture:** Three commits, in an order that keeps the database legal at every point. First the four `Tenant*` models are renamed to `Utility*`, so the new entity lands in a schema that uses one word. Then `Utility` is added and the seed and test fixtures create its row, while nothing yet depends on it. Only then does the foreign key go on, so the constraint is added to data that already satisfies it.

**Tech Stack:** Prisma 6 (PostgreSQL + TimescaleDB), Fastify, Vitest (unit + testcontainers integration suites), plain-JS `seed.js`.

**Spec:** `docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md` — build-order step 2 and decision D6.

## Global Constraints

- **No backfill, no compatibility path.** The product is in development; data that does not fit the new shape is reseeded, not migrated. Migrations are `CREATE TABLE`/`ALTER TABLE` plus constraints with no data-repair step.
- **One noun for the thing: `Utility`.** "Tenant"/"tenancy" survives only where it names a property or mechanism — `TENANCY_MODE`, "tenant isolation", `withTenant()`, `tenantMiddleware`, `app.current_utility_id`. Those keep their names: they are the isolation mechanism, not the entity.
- **Scope is the entity only.** Provisioning (`provisionTenant`), `TENANCY_MODE`, and the platform actor are build-order steps 3, 4 and 5. No route, no UI, no permission module in this plan.
- **Dev tenant id stays `00000000-0000-4000-8000-000000000001`.** Integration fixtures keep `TENANT_A = 00000000-0000-4000-8000-0000000000aa` and `TENANT_B = ...00bb`.
- **RLS policies live in migrations**, following `20260423021700_rls_policies/migration.sql`: `ENABLE ROW LEVEL SECURITY` plus a policy comparing against `current_setting('app.current_utility_id')`. They are inert today because the app role is a superuser that owns the tables (§1.7); add them anyway for consistency.
- Migration directories are `packages/shared/prisma/migrations/YYYYMMDDHHMMSS_name/migration.sql`.
- **The rename in Task 1 is exactly four models and nothing else.** `makeTenantFixture`, `TenantFixture`, `TENANT_A`/`TENANT_B` and `withTenant` keep their names — they name the isolation fixture and mechanism, not the entity. Renaming them is not in scope and would bury the schema change in 57 test files.

## Review Focus

1. **A write naming a utility that does not exist** must be refused by the database, not silently create a phantom tenant — this is the whole point of the key (Task 3).
2. **Deleting a utility that still has rows** must be refused rather than cascading, or one mistaken call erases a customer (Task 3).
3. **`resetDb` truncating `utility`** would cascade-wipe every fixture; `makeTenantFixture` must create the row it then depends on, or all 62 container files fail at once (Task 2).
4. **Two utilities in one test file** — `makeTenantFixture` is called for both `TENANT_A` and `TENANT_B` in the same `beforeEach`, so creating the row must not collide on the second call (Task 2).
5. **Re-running the seed** must not fail on the foreign key: `seed.js` deletes a fixed list of tables, and any child table missing from that list will hold rows that block deleting the utility (Task 3).

---

### Task 1: Rename the four `Tenant*` models to `Utility*`

A pure rename with no behaviour change, so its test is the existing suites staying green — there is nothing new to assert, and a test written here would prove only that a rename renamed something.

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — models `TenantTheme`, `TenantModule`, `TenantConfig`, `TenantSetting` and their `@@map` names
- Create: `packages/shared/prisma/migrations/20261018120000_rename_tenant_tables_to_utility/migration.sql`
- Modify: 293 references across `packages/api`, `packages/web`, `packages/shared`, and 5 in `seed.js`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma clients `prisma.utilityConfig`, `prisma.utilityModule`, `prisma.utilityTheme`, `prisma.utilitySetting`, replacing the `tenant*` names. Tables `utility_config`, `utility_module`, `utility_theme`, `utility_setting`.

- [ ] **Step 1: Record the baseline**

Run: `cd packages/api && npx vitest run` and `cd packages/web && npx vitest run`
Expected: api 612 passed / 4 skipped, web 227 passed. Note the real numbers; they are the gate for Step 5.

- [ ] **Step 2: Rename in the schema**

In `schema.prisma`, rename each model and its `@@map`: `TenantTheme` → `UtilityTheme` (`@@map("utility_theme")`), `TenantModule` → `UtilityModule` (`utility_module`), `TenantConfig` → `UtilityConfig` (`utility_config`), `TenantSetting` → `UtilitySetting` (`utility_setting`). Leave every `utilityId` field untouched.

- [ ] **Step 3: Write the rename migration**

```sql
ALTER TABLE tenant_theme   RENAME TO utility_theme;
ALTER TABLE tenant_module  RENAME TO utility_module;
ALTER TABLE tenant_config  RENAME TO utility_config;
ALTER TABLE tenant_setting RENAME TO utility_setting;
```

Postgres carries indexes, constraints and RLS policies through a table rename, so nothing else is needed. Rename the policies too only if a later migration refers to them by name — check before adding.

- [ ] **Step 4: Rename every reference**

`prisma.tenantConfig` → `prisma.utilityConfig` and the same for the other three, across `packages/**` and `seed.js`. Case-sensitive whole-word replacement; the type names (`TenantConfig`) move with them. Then `npx prisma generate` from `packages/shared`.

- [ ] **Step 5: Verify nothing changed but the names**

Run: `npx tsc --noEmit` in `packages/shared`, `packages/api`, `packages/web`, then both unit suites.
Expected: zero TS errors; the same counts recorded in Step 1. A changed count means something other than a name moved.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/prisma packages/api packages/web seed.js
git commit -m "refactor(schema): one noun for the thing — Tenant* models become Utility*"
```

---

### Task 2: The `Utility` entity, created by the seed and by the fixtures

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — new `Utility` model and `UtilityStatus` enum
- Create: `packages/shared/prisma/migrations/20261018130000_utility_entity/migration.sql`
- Modify: `seed.js` — create the dev utility before anything referencing it
- Modify: `packages/api/src/__tests__/integration/_effective-dating-fixtures.ts` — `makeTenantFixture` creates the utility row
- Test: `packages/api/src/__tests__/integration/utility-entity.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's `prisma.utilityConfig` etc.
- Produces: `prisma.utility` with fields `id: string`, `name: string`, `status: UtilityStatus`, `createdAt: Date`, `updatedAt: Date`; `UtilityStatus` = `ACTIVE | SUSPENDED`. `makeTenantFixture(prisma, utilityId, opts)` keeps its signature and now creates the utility row first.

- [ ] **Step 1: Write the failing test**

```ts
// utility-entity.integration.test.ts
// `fix` is reused by Task 3's tests, which need a real billingCycleId.
let fix: TenantFixture;

it("gives a fixture tenant a utility row", async () => {
  fix = await makeTenantFixture(prisma, TENANT_A);
  const utility = await prisma.utility.findUniqueOrThrow({ where: { id: TENANT_A } });
  expect(utility.status).toBe("ACTIVE");
  expect(utility.name).toContain("00aa");
  expect(fix.utilityId).toBe(TENANT_A);
});

it("creates a second utility without colliding with the first", async () => {
  await makeTenantFixture(prisma, TENANT_A);
  await makeTenantFixture(prisma, TENANT_B);
  expect(await prisma.utility.count()).toBe(2);
});
```

Covers Review Focus 3 and 4.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/utility-entity.integration.test.ts`
Expected: FAIL — `prisma.utility` is not a property of the client.

- [ ] **Step 3: Add the model and enum**

In `schema.prisma`:

```prisma
model Utility {
  id        String        @id @default(uuid()) @db.Uuid
  name      String        @db.VarChar(255)
  status    UtilityStatus @default(ACTIVE)
  createdAt DateTime      @default(now()) @map("created_at") @db.Timestamptz
  updatedAt DateTime      @updatedAt @map("updated_at") @db.Timestamptz

  @@map("utility")
}

enum UtilityStatus {
  ACTIVE
  SUSPENDED

  @@map("utility_status")
}
```

Fields are exactly D6's "identity, display name, status, created-at", plus `updatedAt` to match every other model here. No `code` or slug: provisioning (step 3) can add one when it needs one.

- [ ] **Step 4: Write the migration**

`CREATE TYPE utility_status`, `CREATE TABLE utility`, then RLS in the house style: `ALTER TABLE utility ENABLE ROW LEVEL SECURITY` and a policy `USING (id = current_setting('app.current_utility_id', true)::uuid)` — the policy keys on `id`, because this table's primary key *is* the tenant. Listing every utility is the platform actor's job and is deferred to step 5.

- [ ] **Step 5: Create the row in the fixture and the seed**

In `makeTenantFixture`, before `utilityConfig.create`, upsert the utility: `prisma.utility.upsert({ where: { id: utilityId }, update: {}, create: { id: utilityId, name: \`Test Utility ${suffix}\` } })`. Upsert rather than create, because `resetDb` does not truncate `utility` and a file calls this per test.

In `seed.js`, create the dev utility named "Bozeman" before the first row that carries its id.

- [ ] **Step 6: Run test to verify it passes**

Run: the command from Step 2.
Expected: PASS, 2 tests.

- [ ] **Step 7: Verify the whole container suite still boots**

Run: `npx vitest run -c vitest.integration.config.ts` in `packages/api`
Expected: 63 files passed. This is the step that catches a fixture change breaking files that never mention a utility — budget ~25 minutes, dev server stopped.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/prisma packages/api/src/__tests__ seed.js
git commit -m "feat(schema): a tenant is a row — the Utility entity"
```

---

### Task 3: The foreign key

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` — a `utility` relation on all 61 models carrying `utilityId`, and the matching back-relations on `Utility`
- Create: `packages/shared/prisma/migrations/20261018140000_utility_foreign_keys/migration.sql`
- Modify: `seed.js` — delete order
- Test: `packages/api/src/__tests__/integration/utility-entity.integration.test.ts` (extends Task 2's file)

**Interfaces:**
- Consumes: Task 2's `prisma.utility`.
- Produces: every `utilityId` is a foreign key to `utility.id`, `onDelete: Restrict`.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses a row naming a utility that does not exist", async () => {
  await expect(
    prisma.account.create({
      data: {
        utilityId: "99999999-9999-4999-8999-999999999999",
        accountNumber: "ACCT-ORPHAN",
        accountType: "RESIDENTIAL",
        status: "ACTIVE",
        billingCycleId: fix.billingCycleId,
        depositAmount: 0,
      },
    }),
  ).rejects.toMatchObject({ code: "P2003" });
});

it("refuses to delete a utility that still has rows", async () => {
  await expect(prisma.utility.delete({ where: { id: TENANT_A } })).rejects.toMatchObject({
    code: "P2003",
  });
});
```

Covers Review Focus 1 and 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/utility-entity.integration.test.ts`
Expected: FAIL — both writes succeed, because no constraint exists yet.

- [ ] **Step 3: Declare the relation on every model**

On each of the 61 models carrying `utilityId`, add `utility Utility @relation(fields: [utilityId], references: [id], onDelete: Restrict)`. On `Utility`, add the matching back-relation per model, named as the plural of the model in this file's existing style (`accounts Account[]`, `customers Customer[]`, …). No model currently has a field named `utility`, and nothing in `packages/**` or `seed.js` uses nested `connect:`, so writes passing `utilityId` as a scalar keep compiling.

`Restrict` rather than `Cascade` deliberately: a cascade would make one mistaken delete erase a customer's entire history.

- [ ] **Step 4: Write the migration**

61 × `ALTER TABLE <t> ADD CONSTRAINT <t>_utility_id_fkey FOREIGN KEY (utility_id) REFERENCES utility(id) ON DELETE RESTRICT ON UPDATE CASCADE;`. Generate it with `npx prisma migrate diff` rather than by hand, then read it before committing.

- [ ] **Step 5: Fix the seed's delete order**

`seed.js` clears a fixed list of tables. With the key in place, the utility cannot be deleted while any child row survives — and the list does not cover every child table. Either delete the utility first and let nothing else reference it, or leave the utility in place across reseeds (upsert). Prefer the upsert: it keeps the clear-down list unchanged.

- [ ] **Step 6: Run tests to verify they pass**

Run: the command from Step 2.
Expected: PASS, 4 tests.

- [ ] **Step 7: Verify the suites**

Run: `npx tsc --noEmit` in all three packages; both unit suites; then the full container suite.
Expected: zero TS errors, Task 1's counts, 63 files passed.

- [ ] **Step 8: Reseed a real database and check it comes up**

Run: `seed_db.bat`, then start the API and load any list page.
Expected: seeding completes and the page returns rows — the check that the constraint does not break the one path a developer uses every day.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/prisma packages/api/src/__tests__ seed.js
git commit -m "feat(schema): utility_id becomes a foreign key"
```
