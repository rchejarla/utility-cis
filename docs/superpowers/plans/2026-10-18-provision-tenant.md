# provisionTenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One idempotent function that brings a tenant into existence — utility row, enabled modules, preset roles, first admin — so onboarding a second utility stops being a developer running SQL.

**Architecture:** A service function in the API package, one transaction, callable from a script with no UI. The preset roles return to `packages/shared` as the single definition, because provisioning is the consumer whose absence made the previous copy dead code. `seed.js` stops defining roles and modules and delegates to the script, so demo data depends on a provisioned tenant rather than re-implementing one.

**Tech Stack:** Fastify/TypeScript API, Prisma 6, `tsx` for the script, Vitest (unit + testcontainers integration).

**Spec:** `docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md` — decision D1, D6's six lifecycle responsibilities, build-order step 3, and open question Q4.

## Global Constraints

- **Lifecycle only, and only the part with no other home.** Create, enable modules, apply a profile, create the first admin. Suspend/reactivate and list are D6 responsibilities that need no new machinery (a status column and a query); impersonation, purge, per-tenant credentials and cross-tenant reporting are deferred out of v1 and must not appear here.
- **No UI and no route.** D1: "Idempotent, callable from a script, **no UI**." A platform actor to call it through is build-order step 5, and Q2/Q3's consequences are unbuilt.
- **Idempotent.** Running it twice must be a no-op, not a duplicate or an error. Six integration files and every fresh database depend on re-runnability.
- **One transaction.** A half-provisioned tenant — a utility row with no roles — is indistinguishable from a valid one and would pass every existence check.
- **`TENANCY_MODE` is not in scope.** It is step 4, and nothing branches on it yet.
- **Never `prisma migrate dev`** against this schema; see CLAUDE.md.
- Dev tenant id stays `00000000-0000-4000-8000-000000000001`, named "City of Bozeman".

## Review Focus

1. **Called twice** — the second call must change nothing and must not throw, including when a role's permission map has since been edited by hand (Task 2).
2. **Called for an existing utility under a different name** — silently renaming someone's tenant is worse than refusing; the caller gets told (Task 2).
3. **A module key in `utility_module` that is no longer in `MODULES`** — provisioning must not leave a tenant enabled for a module the code no longer has, and must not delete rows it did not create either (Task 2).
4. **A first-admin email that already exists in that tenant** — `@@unique([utilityId, email])` makes this a constraint violation surfaced as a crash unless it is handled as the ordinary case it is (Task 2).
5. **Failure partway through** — a crash after the utility row but before the roles must leave no tenant at all, not a shell that later reads as provisioned (Task 2).

---

### Task 1: The preset roles return to shared, with provisioning as their consumer

`PRESET_ROLES` was deleted from `packages/shared` on 2026-10-18 (`55c668b`) because nothing imported it and it had drifted four modules from `seed.js`. The deletion was right then and re-adding is right now: the reason it was dead is that no code provisioned a tenant, and this plan builds that code. One definition, two consumers, no drift to reconcile.

**Files:**
- Create: `packages/shared/src/modules/role-presets.ts`
- Modify: `packages/shared/src/modules/index.ts` (or wherever the package re-exports `MODULES`) to export it
- Test: `packages/shared/src/modules/__tests__/role-presets.test.ts`

**Interfaces:**
- Consumes: `MODULES` and `PermissionMap` from `packages/shared/src/modules/constants.ts`.
- Produces: `PRESET_ROLES: ReadonlyArray<{ name: string; description: string; isSystem: true; permissions: PermissionMap }>` — the six roles currently defined in `seed.js:843-932`, copied verbatim, in that order.

- [ ] **Step 1: Write the failing test**

```ts
it("grants Utility Admin every module, but settings at VIEW only", () => {
  const admin = PRESET_ROLES.find((r) => r.name === "Utility Admin")!;
  expect(Object.keys(admin.permissions)).toHaveLength(MODULES.length);
  expect(admin.permissions.settings).toEqual(["VIEW"]);
});

it("names every module it grants", () => {
  // The drift that killed the previous copy: a role granting a module
  // that no longer exists, or MODULES growing without the presets.
  for (const role of PRESET_ROLES) {
    for (const key of Object.keys(role.permissions)) {
      expect(MODULES).toContain(key);
    }
  }
});

it("defines the six roles seed.js defines, in order", () => {
  expect(PRESET_ROLES.map((r) => r.name)).toEqual([
    "System Admin", "Utility Admin", "CSR", "Field Technician", "Read-Only", "Portal Customer",
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/modules/__tests__/role-presets.test.ts`
Expected: FAIL — cannot resolve `role-presets`.

- [ ] **Step 3: Write `PRESET_ROLES` in `packages/shared/src/modules/role-presets.ts`**

Copy the six role objects from `seed.js:843-932` exactly — including `Read-Only` being computed as every module except `settings`, `theme` and `portal_*`, and `Portal Customer` holding only the four `portal_*` keys. Do not re-derive the permission sets; transcribe them, then let the tests above check them against `MODULES`.

- [ ] **Step 4: Run to verify it passes**

Run: as Step 2. Expected: PASS, 3 tests. Then `cd packages/shared && npx tsc --noEmit` — expect 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/modules
git commit -m "feat(shared): preset roles return, with a consumer this time"
```

---

### Task 2: `provisionTenant`

**Files:**
- Create: `packages/api/src/services/provisioning.service.ts`
- Test: `packages/api/src/__tests__/integration/provisioning.integration.test.ts`

**Interfaces:**
- Consumes: `PRESET_ROLES` (Task 1), `MODULES` from shared, `prisma` from `../lib/prisma.js`.
- Produces:

```ts
export interface ProvisionTenantInput {
  utilityId: string;
  name: string;
  firstAdmin?: { email: string; name: string };
  /** Named set of reference configuration. Q4 is otherwise unanswered. */
  profile?: "minimal";
  /**
   * Do everything, report it, write nothing. Implemented by rolling the
   * transaction back at the end rather than by a second code path that
   * predicts the outcome — a dry run that never reaches the constraints
   * cannot tell you about the collision that will stop the real one.
   */
  dryRun?: boolean;
}

export interface UtilitySummary {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  moduleCount: number;
  roleCount: number;
  userCount: number;
}

/** D6 responsibility 6. Needs no platform actor: one table, read-only. */
export async function listUtilities(): Promise<UtilitySummary[]>;

export interface ProvisionTenantResult {
  utilityId: string;
  created: boolean;        // false when the utility row already existed
  modulesEnabled: number;  // rows created this call, not rows present
  rolesCreated: number;
  adminCreated: boolean;
}

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult>;
```

- [ ] **Step 1: Write the failing tests**

Against a real database — this is about constraints and transactions, which a mocked client cannot show. Follow `utility-entity.integration.test.ts` for the container shape; call `bootPostgres()` with no `utilities`, since this function is what creates them.

```ts
it("creates a utility, its modules, and the preset roles", async () => {
  const r = await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  expect(r).toMatchObject({ created: true, rolesCreated: 6, adminCreated: false });
  expect(r.modulesEnabled).toBe(MODULES.length);
  expect(await prisma.utility.findUniqueOrThrow({ where: { id: NEW_TENANT } })).toMatchObject({
    name: "City of Example", status: "ACTIVE",
  });
});

it("is a no-op when run twice", async () => {            // Review Focus 1
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  const second = await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  expect(second).toMatchObject({ created: false, modulesEnabled: 0, rolesCreated: 0 });
  expect(await prisma.role.count({ where: { utilityId: NEW_TENANT } })).toBe(6);
  expect(await prisma.utilityModule.count({ where: { utilityId: NEW_TENANT } })).toBe(MODULES.length);
});

it("refuses to rename an existing utility", async () => {  // Review Focus 2
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  await expect(
    provisionTenant({ utilityId: NEW_TENANT, name: "Something Else" }),
  ).rejects.toMatchObject({ code: "UTILITY_NAME_MISMATCH" });
});

it("leaves no tenant behind when provisioning fails partway", async () => {  // Review Focus 5
  // A role name already taken forces a unique violation after the utility
  // row is written. @@unique([utilityId, name]) on role.
  await prisma.utility.create({ data: { id: OTHER, name: "Pre-existing" } });
  await prisma.role.create({ data: { utilityId: OTHER, name: "CSR", description: "x", permissions: {} } });
  await expect(provisionTenant({ utilityId: OTHER, name: "Pre-existing" })).rejects.toThrow();
  expect(await prisma.role.count({ where: { utilityId: OTHER } })).toBe(1);
  expect(await prisma.utilityModule.count({ where: { utilityId: OTHER } })).toBe(0);
});

it("creates a first admin with the System Admin role when asked", async () => {
  const r = await provisionTenant({
    utilityId: NEW_TENANT, name: "City of Example",
    firstAdmin: { email: "admin@example.gov", name: "Pat Admin" },
  });
  expect(r.adminCreated).toBe(true);
  const user = await prisma.cisUser.findFirstOrThrow({
    where: { utilityId: NEW_TENANT, email: "admin@example.gov" },
  });
  const assignment = await prisma.userRole.findFirstOrThrow({
    where: { userId: user.id, accountId: null },
    include: { role: { select: { name: true } } },
  });
  expect(assignment.role.name).toBe("System Admin");
});

it("reports an existing admin rather than failing on the unique index", async () => {  // Review Focus 4
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example",
    firstAdmin: { email: "admin@example.gov", name: "Pat Admin" } });
  const again = await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example",
    firstAdmin: { email: "admin@example.gov", name: "Pat Admin" } });
  expect(again.adminCreated).toBe(false);
  expect(await prisma.cisUser.count({ where: { utilityId: NEW_TENANT } })).toBe(1);
});

it("writes nothing on a dry run, but reports what it would do", async () => {
  const planned = await provisionTenant({
    utilityId: NEW_TENANT, name: "City of Example",
    firstAdmin: { email: "admin@example.gov", name: "Pat Admin" },
    dryRun: true,
  });
  expect(planned).toMatchObject({ created: true, rolesCreated: 6, adminCreated: true });
  expect(planned.modulesEnabled).toBe(MODULES.length);
  // Nothing persisted — the row the result claims to have created is absent.
  expect(await prisma.utility.findUnique({ where: { id: NEW_TENANT } })).toBeNull();
  expect(await prisma.role.count({ where: { utilityId: NEW_TENANT } })).toBe(0);
});

it("reports a dry run against an existing tenant as the no-op it would be", async () => {
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  const planned = await provisionTenant({
    utilityId: NEW_TENANT, name: "City of Example", dryRun: true,
  });
  expect(planned).toMatchObject({ created: false, modulesEnabled: 0, rolesCreated: 0 });
});

it("lists every utility with what it holds", async () => {
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example",
    firstAdmin: { email: "admin@example.gov", name: "Pat Admin" } });

  const all = await listUtilities();
  const mine = all.find((u) => u.id === NEW_TENANT)!;
  expect(mine).toMatchObject({
    name: "City of Example", status: "ACTIVE",
    moduleCount: MODULES.length, roleCount: 6, userCount: 1,
  });
});

it("enables only modules the code still has", async () => {   // Review Focus 3
  await provisionTenant({ utilityId: NEW_TENANT, name: "City of Example" });
  const keys = (await prisma.utilityModule.findMany({
    where: { utilityId: NEW_TENANT }, select: { moduleKey: true },
  })).map((m) => m.moduleKey);
  expect(keys.filter((k) => !MODULES.includes(k as never))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/provisioning.integration.test.ts`
Expected: FAIL — `provisioning.service.js` does not resolve.

- [ ] **Step 3: Implement `provisionTenant` in `packages/api/src/services/provisioning.service.ts`**

Everything inside one `prisma.$transaction`. Shape:

- Read the utility by id. If it exists and `name` differs, throw an error carrying `code: "UTILITY_NAME_MISMATCH"` — renaming is a lifecycle operation of its own, not a side effect of re-provisioning. If it exists with the same name, `created: false` and carry on.
- Modules: `createMany` over `MODULES` with `skipDuplicates`, so a re-run adds only what is missing and never deletes. Count what it created. Do not reconcile rows for keys no longer in `MODULES` — removing a module is its own operation and silently deleting a tenant's enablement is worse than leaving it.
- Roles: for each of `PRESET_ROLES`, create when absent by `(utilityId, name)`. Never update an existing role's permissions: a tenant may have edited them, and re-provisioning must not quietly revert that.
- First admin, when given: find by `(utilityId, email)`; if present, `adminCreated: false` and leave it alone. Otherwise create the `CisUser` and one `UserRole` with `accountId: null` pointing at the System Admin role created above.
- `profile` accepts only `"minimal"` in v1, which adds nothing beyond the above. Q4 — who chooses a profile and where the list lives — is unanswered in the spec, so this parameter exists to keep the signature stable when it is answered, and the function must reject any other value rather than ignore it.
- `dryRun` runs the identical body and then throws a module-private sentinel to roll the transaction back, catching it outside and returning the result it had assembled. Do not branch the logic on `dryRun`: the point is that a dry run meets the same constraints the real run will, so a name mismatch or a role collision surfaces before anyone commits to it.
- `listUtilities()` returns every utility with its module, role and user counts, ordered by name. Deliberately unscoped by tenant — it is the one read whose whole purpose is to cross tenants, which is why D6 lists it and why the platform actor at step 5 will be its eventual caller. It takes no arguments and writes nothing.

- [ ] **Step 4: Run to verify they pass**

Run: as Step 2. Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/provisioning.service.ts packages/api/src/__tests__/integration/provisioning.integration.test.ts
git commit -m "feat(tenancy): provisionTenant — a tenant can be created without SQL"
```

---

### Task 3: The script, and `seed.js` stops duplicating it

**Files:**
- Create: `scripts/provision-tenant.ts`
- Modify: `seed.js` — remove the preset-role array (`:843-932`) and the module loop (`:938-941`), delegate instead
- Modify: `CLAUDE.md` — document the script under Commands

**Interfaces:**
- Consumes: `provisionTenant` (Task 2).
- Produces, exit 0 on success and exit 1 with the error's message on failure:

```
npx tsx scripts/provision-tenant.ts --utility-id <uuid> --name <name>
                                    [--admin-email <email> --admin-name <name>]
                                    [--dry-run]
npx tsx scripts/provision-tenant.ts --list
```

The script is the whole operator interface at this step: D1 says no UI, and
the build order puts a console at step 6 "only if operating the above
through scripts proves genuinely insufficient." `--dry-run` and `--list`
are what make that true rather than merely asserted — seeing what exists,
and seeing what a run would change before it changes it, are the two things
an operator would otherwise open a console for.

- [ ] **Step 1: Write the script**

Argument parsing with `node:util`'s `parseArgs`; no new dependency. It prints the `ProvisionTenantResult` fields as one line each so a reader can see what a re-run actually did. No test of its own: the function it calls is covered by Task 2, and a test of `parseArgs` would be a test of Node.

- [ ] **Step 2: Verify the three modes against the dev database**

Run, against the dev database:

```bash
npx tsx scripts/provision-tenant.ts --utility-id 00000000-0000-4000-8000-0000000000f1 --name "Test City"
```

Expected: `created: true`, `rolesCreated: 6`, `modulesEnabled: 32`. Run it a second time: `created: false`, both counts 0.

Then `--dry-run` against a fresh id: it must report `created: true` with
full counts, and `--list` must then **not** show that id. And `--list`
alone must show the dev tenant with `32 modules, 6 roles, 7 users`.

Then remove the test tenant:
`docker exec utility-cis-db-1 psql -U cis -d utility_cis -c "DELETE FROM user_role WHERE utility_id='...f1'; DELETE FROM role WHERE utility_id='...f1'; DELETE FROM cis_user WHERE utility_id='...f1'; DELETE FROM utility_module WHERE utility_id='...f1'; DELETE FROM utility WHERE id='...f1';"`

- [ ] **Step 3: Make `seed.js` delegate**

`seed.js` is CommonJS and cannot import the TypeScript service, so it shells out the way six integration files already shell out to `prisma/seed.ts`:
`execSync('npx tsx scripts/provision-tenant.ts --utility-id ' + UID + ' --name "City of Bozeman"')`, before the first row that carries `UID`, replacing both its `utility.upsert` and the role and module blocks. The five admin users it creates for dev login stay — they are demo data, not provisioning.

This is the point of the task: those role definitions existed in two places once before and drifted four modules apart. Now there is one.

- [ ] **Step 4: Verify a full reseed still works**

Run: recreate and reseed per CLAUDE.md, then
`docker exec utility-cis-db-1 psql -U cis -d utility_cis -At -c "SELECT (SELECT count(*) FROM role)||' roles, '||(SELECT count(*) FROM utility_module)||' modules, '||(SELECT count(*) FROM cis_user)||' users';"`
Expected: `6 roles, 32 modules, 7 users` — the same counts as before this plan.

- [ ] **Step 5: Verify the suites**

Run: `tsc --noEmit` in all three packages; the three unit suites. Expected: shared 221+3, api 612, web 227, zero TS errors. **Ask before running the full container suite** — targeted files first.

- [ ] **Step 6: Commit**

```bash
git add scripts/provision-tenant.ts seed.js CLAUDE.md
git commit -m "feat(tenancy): a script provisions a tenant, and the seed stops duplicating it"
```
