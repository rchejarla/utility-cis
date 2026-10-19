# Platform Actor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An identity that legitimately sits above tenants — a `CisUser` with no `utility_id` — so tenant lifecycle stops borrowing a tenant admin's permissions, a suspended tenant actually stops working, and the queue UI stops being authorized by `tenant_profile:EDIT`.

**Architecture:** The platform identity is a second *kind* of authenticated request, not a widening of the existing one. `request.user` keeps its non-nullable `utilityId` and all 243 of its read sites are untouched; a platform token populates a separate `request.platformActor` instead, and the authorization middleware refuses each kind on the other's routes — so `request.user` is only ever read where it is set. Platform routes declare `{ platform: true }` rather than a module and permission, because being the platform actor *is* the authority; there is no platform permission matrix. Tenant suspension is enforced in the same middleware pass that already checks enabled modules, from the same cache.

**Tech Stack:** Fastify/TypeScript API, Prisma 6 + PostgreSQL 16, hand-written SQL migration, Redis-backed RBAC cache, Next.js 14 app router, Vitest (unit + testcontainers integration).

**Spec:** `docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md` — D4, D6, Q2, Q3, §1.2, §1.6, §1.7, and build-order step 5.

## Global Constraints

- **Scope is D6's six lifecycle responsibilities and nothing else.** Impersonation, hard delete/purge, per-tenant integration credentials and cross-tenant reporting are deferred out of v1 by name and must not appear. The sizing principle: this is the only identity that can cross the tenant boundary, so it holds only what cannot live anywhere else.
- **Platform authorization is identity-only — no permission matrix.** The simpler alternative is the one being taken: a route asks "is this the platform actor", answered by one cached lookup. The alternative is `role` rows with a null `utility_id` and `platform_*` modules, reusing the RBAC machinery; its only benefit is granularity nobody has asked for, which is the "future flexibility" CLAUDE.md's checklist rules out. When a second class of platform actor appears (read-only support, say), that is when a matrix is earned.
- **`request.user.utilityId` stays `string`, not `string | null`.** 243 sites read it. Nullability would make every one of them a site that must prove it meant a tenant, which is the opposite of §1.7's lesson.
- **Q3 is settled as a decision, not as code.** With no tenant context, `current_setting('app.current_utility_id', true)` is NULL and every policy filters every row out, so a lifecycle operation would see nothing. The resolution: when RLS is enforced for real, policies admit an explicit platform context — a second setting the policy ORs in — rather than the alternative of a `BYPASSRLS` role, which would need a second connection pool and credentials and would exempt *all* of that role's queries rather than the lifecycle ones. **No policy is changed in this plan**: all 62 are inert today because the application role is a superuser that owns the tables (§1.7), the change is mechanical when it is needed, and building it now is 62 policy rewrites that nothing reads. Record the decision in `docs/design/utility-cis-architecture.md` §7.1 (Task 1 Step 6).
- **Q1's prerequisite does not gate this step.** Build-order step 1 says "before step 5, give the shadow rule one home" — the global-versus-tenant reference-row resolution that exists as five inline loops plus two hand-written queries. Read Q1's own wording for the condition: *"before adding a platform actor that can write these rows"*. D3 decided this actor never writes them (globals change by migration or by tenant override, never by a live console) and D6's six responsibilities exclude them, so those five copies are not on this plan's path. Giving them one home is a real change worth making on its own merits, not a gate here. **If any task below ends up reading or writing a global reference row, stop** — the prerequisite has become live and this reasoning no longer holds.
- **No backfill.** Existing rows that do not fit a new shape are reseeded, never migrated.
- **Never `prisma migrate dev`** against this schema — see CLAUDE.md. The migration in Task 2 is hand-written and applied with `migrate deploy`.
- Dev tenant id stays `00000000-0000-4000-8000-000000000001`, named "City of Bozeman".
- The console is **not** fenced to development. Every other admin route is equally reachable, so fencing one buys nothing; and the platform gate is a positive database lookup, which makes it stricter than any tenant route today (see Task 8).

## Review Focus

1. **A platform token presented to a tenant route, and a tenant token to a platform route** — each must be refused, because `request.user` is undefined on the first and `request.platformActor` on the second; a missed check is a crash or a bypass, not a 403 (Task 4).
2. **A platform user deactivated or deleted after its token was issued** — the token stays valid for its lifetime, so the per-request lookup must refuse it, and must never reach the "no `CisUser` row ⇒ allow" branch that waves `...099` through every tenant route (Task 4).
3. **A token carrying both `utility_id` and `platform: true`** — ambiguous, and silently picking one is how an identity gets more authority than it was issued; refused at the middleware (Task 3).
4. **A tenant suspended after its users' tokens were minted** — enforcement at login only would leave every existing session working, so it belongs in the per-request pass, with the cache invalidated by the suspend itself (Task 5).
5. **Two platform users sharing an email or an `external_id`** — `@@unique([utilityId, …])` stops constraining when `utility_id` is NULL because Postgres treats nulls as distinct, so the partial unique indexes are the only thing refusing the second row (Task 2).

---

### Task 1: The sweep for `utilityId` parameters that scope nothing

The spec makes this a prerequisite rather than hygiene (§1.7, step 5): an identity *not* scoped by `utility_id` is about to enter a codebase where scoping is a convention each query opts into, and where a seven-instance lapse in `notification.service.ts` survived in a service called from two workers and three routes. Sweep deliberately before the unscoped identity exists, not after.

**Files:**
- Modify: whichever services the sweep implicates (unknown until run — that is the point)
- Modify: `docs/design/utility-cis-architecture.md` §7.1 (record the audit and the Q3 decision)
- Test: one `*-tenancy.integration.test.ts` per hole found, modelled on `packages/api/src/__tests__/integration/notification-tenancy.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in code. Produces the audit table §7.1 carries, and whatever fixes it forces.

- [ ] **Step 1: Enumerate every candidate**

```bash
grep -rn "utilityId: string\|utilityId,$" --include=*.ts packages/api/src/services \
  | tee "$SCRATCH/utility-id-candidates.txt"
```

Every exported function taking a utility id is a candidate. Record the list; it is the denominator and it goes in the audit.

- [ ] **Step 2: For each candidate, classify every database access in its body**

Three verdicts, and the function's name plus the verdict go in the table:
- **scoped** — every Prisma call carries `utilityId` in its `where`, or derives from a row whose ownership was proved at the entry.
- **entry-proved** — ownership is checked once at the top and the rest derives from the proved id (`processBatch` and `evaluateAll` are the two known-good examples).
- **hole** — at least one access reads by primary key alone, and the id can reach it from a request body or a job payload.

- [ ] **Step 3: For each hole, write the failing two-tenant test first**

Shape it on `notification-tenancy.integration.test.ts`: two utilities, the same logical record in both, call the function as tenant A naming tenant B's row. The test asserts the refusal. Run it before fixing anything.

Expected: FAIL — the leak reproduced, with tenant B's data in the assertion output.

- [ ] **Step 4: Fix each hole, then re-run**

Add the predicate at the query, not a check at the caller — a check at the caller is what the next caller forgets.

Expected: PASS, and the leak assertion now shows the refusal.

- [ ] **Step 5: Run the whole unit suite for the touched packages**

Run: `cd packages/api && npx vitest run`
Expected: PASS, no regression in count against the pre-sweep baseline.

- [ ] **Step 6: Record the audit and the Q3 decision in the architecture doc**

§7.1 already holds the `notification.service.ts` lesson. Append: the candidate count, the three-verdict table, and the Q3 resolution from Global Constraints (platform context as a second setting OR'd into the policies, when RLS is enforced; not now, and why).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src docs/design/utility-cis-architecture.md
git commit -m "audit(tenancy): sweep for utilityId parameters that scope nothing"
```

---

### Task 2: `CisUser.utilityId` becomes nullable, with partial unique indexes

Q2's first consequence. A null `utility_id` means "not a tenant's user", which is exactly what a platform actor is, and it needs no second user model. Its second consequence is the indexes: Postgres treats nulls as distinct, so `@@unique([utilityId, email])` stops constraining the moment `utility_id` is NULL — two platform actors could share an address.

**Files:**
- Modify: `packages/shared/prisma/schema.prisma` (`model CisUser`, ~line 1096)
- Create: `packages/shared/prisma/migrations/20261018160000_platform_actor_identity/migration.sql`
- Modify: `packages/api/src/__tests__/integration/schema-invariants.integration.test.ts` (its nullable-`utility_id` set gains `cis_user`)
- Test: `packages/api/src/__tests__/integration/platform-identity.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `cis_user` row with `utility_id IS NULL` is now legal and unique by `email`, and by `external_id` where present.

- [ ] **Step 1: Write the failing test**

```ts
it("admits a user that belongs to no tenant", async () => {
  const actor = await prisma.cisUser.create({
    data: { utilityId: null, email: "platform@example.gov", name: "Platform Operator", isActive: true },
  });
  expect(actor.utilityId).toBeNull();
});

it("refuses a second platform user with the same email", async () => {
  await prisma.cisUser.create({ data: { utilityId: null, email: "dupe@example.gov", name: "First" } });
  await expect(
    prisma.cisUser.create({ data: { utilityId: null, email: "dupe@example.gov", name: "Second" } }),
  ).rejects.toMatchObject({ code: "P2002" });
});

it("refuses a second platform user with the same external_id", async () => {
  // apptorID is the destination for every identity (Q2), so external_id
  // is the claim that will carry it; duplicates there are the same bug.
  await prisma.cisUser.create({ data: { utilityId: null, email: "a@example.gov", name: "A", externalId: "idp-1" } });
  await expect(
    prisma.cisUser.create({ data: { utilityId: null, email: "b@example.gov", name: "B", externalId: "idp-1" } }),
  ).rejects.toMatchObject({ code: "P2002" });
});

it("still refuses two users with one email inside a tenant", async () => {
  // The existing composite unique must survive the column going nullable.
  await prisma.cisUser.create({ data: { utilityId: TENANT, email: "staff@example.gov", name: "A" } });
  await expect(
    prisma.cisUser.create({ data: { utilityId: TENANT, email: "staff@example.gov", name: "B" } }),
  ).rejects.toMatchObject({ code: "P2002" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/platform-identity.integration.test.ts`
Expected: FAIL on the first test — Prisma rejects `utilityId: null` against a required field, before any database call.

- [ ] **Step 3: Make the column nullable in `schema.prisma`**

`utilityId String? @map("utility_id") @db.Uuid` and `utility Utility? @relation(fields: [utilityId], references: [id], onDelete: Restrict)`. Keep both existing `@@unique` attributes — they still constrain tenant users, and the partial indexes below cover what they stop covering. Prisma cannot express a partial index, so do not try to declare them here.

- [ ] **Step 4: Write the migration by hand**

`migration.sql`, with a header comment saying why the two indexes exist (nulls are distinct, so the composite uniques stop constraining):

```sql
ALTER TABLE cis_user ALTER COLUMN utility_id DROP NOT NULL;

CREATE UNIQUE INDEX cis_user_platform_email_key
  ON cis_user (email) WHERE utility_id IS NULL;

CREATE UNIQUE INDEX cis_user_platform_external_id_key
  ON cis_user (external_id) WHERE utility_id IS NULL AND external_id IS NOT NULL;
```

- [ ] **Step 5: Apply it and regenerate the client**

Run: `cd packages/shared && npx prisma migrate deploy && npx prisma generate`
Expected: one migration applied; `generate` succeeds. Stop the API first if `generate` reports EPERM — a half-regenerated client leaves the schema copy stale beside fresh types.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/platform-identity.integration.test.ts`
Expected: PASS 4/4.

- [ ] **Step 7: Add `cis_user` to the schema-invariants nullable set**

`schema-invariants.integration.test.ts` asks the database which tenant-carrying tables lack a required `utility_id`; `cis_user` is now the eighth legitimately-nullable one. Add it with a comment naming the platform actor, so the next person reading that list learns why rather than reverting it.

Run: `cd packages/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/schema-invariants.integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/prisma packages/api/src/__tests__/integration
git commit -m "feat(tenancy): a user can belong to no tenant"
```

---

### Task 3: The auth middleware learns a second kind of identity

`assignUser` currently throws "Missing required token fields" when `utility_id` is absent, so a platform token cannot authenticate at all. It gets a sibling rather than a relaxation: a token declares which kind it is, and a token that declares both or neither is refused — silently picking one is how an identity ends up with authority it was not issued.

**Files:**
- Modify: `packages/api/src/middleware/auth.ts`
- Test: `packages/api/src/__tests__/middleware/platform-auth.test.ts`

**Interfaces:**
- Consumes: `CisUser.utilityId` nullable (Task 2) — not at the type level, but the identity it makes meaningful.
- Produces:
  ```ts
  export interface PlatformActor { id: string; email: string; name: string }
  // declare module "fastify": interface FastifyRequest { user: AuthUser; platformActor?: PlatformActor }
  ```
  `AuthUser` is unchanged, `utilityId` still `string`. Exactly one of `request.user` / `request.platformActor` is set on an authenticated request.

- [ ] **Step 1: Write the failing test**

```ts
it("sets platformActor and leaves user unset for a platform token", async () => {
  const res = await app.inject({ method: "GET", url: "/__probe", headers: platformHeaders });
  expect(JSON.parse(res.body)).toEqual({ kind: "platform", id: PLATFORM_USER_ID, utilityId: null });
});

it("sets user and leaves platformActor unset for a tenant token", async () => {
  const res = await app.inject({ method: "GET", url: "/__probe", headers });
  expect(JSON.parse(res.body)).toMatchObject({ kind: "tenant", utilityId: TENANT });
});

it("refuses a token claiming both a tenant and the platform", async () => {
  // Ambiguous: whichever we picked, the token would carry authority it
  // was not issued. 401, not a silent choice.
  const res = await app.inject({ method: "GET", url: "/__probe", headers: bothHeaders });
  expect(res.statusCode).toBe(401);
});

it("refuses a token claiming neither", async () => {
  const res = await app.inject({ method: "GET", url: "/__probe", headers: neitherHeaders });
  expect(res.statusCode).toBe(401);
});
```

`/__probe` is a route registered by the test that reports which of the two is populated. The existing `createTestToken` helper gains a `platform: true` variant.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/middleware/platform-auth.test.ts`
Expected: FAIL — the platform token 401s with "Missing required token fields".

- [ ] **Step 3: Split `assignUser` by the token's declared kind**

In `auth.ts`: read `payload.platform === true` and `payload.utility_id ?? payload.utilityId`. Both present or both absent → throw, which the existing `catch` already turns into 401. Platform → set `request.platformActor` from `sub`/`email`/`name`. Tenant → today's `assignUser`, unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/middleware/platform-auth.test.ts`
Expected: PASS 4/4.

- [ ] **Step 5: Run the full API unit suite**

Run: `cd packages/api && npx vitest run`
Expected: PASS — no existing test's token shape changes meaning.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/middleware/auth.ts packages/api/src/__tests__
git commit -m "feat(auth): a token declares whether it is a tenant's or the platform's"
```

---

### Task 4: Platform authorization, and the two refusals that keep the kinds apart

**Files:**
- Modify: `packages/api/src/services/rbac.service.ts` (add `getPlatformActor`, `invalidatePlatformActorCache`)
- Modify: `packages/api/src/middleware/authorization.ts`
- Test: `packages/api/src/__tests__/middleware/platform-authorization.test.ts`

**Interfaces:**
- Consumes: `request.platformActor` (Task 3).
- Produces:
  ```ts
  export async function getPlatformActor(userId: string): Promise<{ id: string; email: string; name: string } | null>
  export async function invalidatePlatformActorCache(userId: string): Promise<void>
  ```
  Cache key `platform-actor:${userId}`, TTL 300 — the same shape as `getUserRole`. A route opts in with `{ config: { platform: true } }`.

- [ ] **Step 1: Write the failing test**

```ts
it("admits the platform actor to a platform route", async () => {
  expect((await get("/__platform", platformHeaders)).statusCode).toBe(200);
});

it("refuses a tenant admin on a platform route, System Admin included", async () => {
  // §1.2: System Admin is a tenant role. Holding every tenant permission
  // is not the same authority as being above tenants.
  const res = await get("/__platform", headers);
  expect(res.statusCode).toBe(403);
  expect(JSON.parse(res.body).error.code).toBe("PLATFORM_REQUIRED");
});

it("refuses the platform actor on a tenant route", async () => {
  // request.user is undefined here; without this check the route would
  // crash on user.utilityId rather than refuse.
  const res = await get("/__tenant", platformHeaders);
  expect(res.statusCode).toBe(403);
  expect(JSON.parse(res.body).error.code).toBe("TENANT_CONTEXT_REQUIRED");
});

it("refuses a platform token whose user row is gone", async () => {
  // The token outlives the row. This must NOT fall into the
  // "no CisUser row ⇒ allow" branch that tenant routes still have.
  mockPlatformActorMissing();
  expect((await get("/__platform", platformHeaders)).statusCode).toBe(403);
});

it("refuses a platform token whose user is deactivated", async () => {
  mockPlatformActorInactive();
  expect((await get("/__platform", platformHeaders)).statusCode).toBe(403);
});

it("refuses a platform token for a user that has a utility_id", async () => {
  // A tenant user whose id was minted into a platform-claiming token.
  // The lookup requires utility_id IS NULL, so the claim is not enough.
  mockPlatformActorIsTenantUser();
  expect((await get("/__platform", platformHeaders)).statusCode).toBe(403);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/middleware/platform-authorization.test.ts`
Expected: FAIL — `{ platform: true }` is not a thing the middleware reads, so the platform route falls through as an unprotected route and answers 200 for everyone.

- [ ] **Step 3: Implement `getPlatformActor` in `rbac.service.ts`**

`cisUser.findFirst({ where: { id: userId, utilityId: null, isActive: true }, select: { id: true, email: true, name: true } })`, through `cacheGet`/`cacheSet` exactly as `getUserRole` does. The `utilityId: null` and `isActive: true` predicates are the authorization; the token's claim only says which lookup to run.

- [ ] **Step 4: Branch the authorization middleware**

Before the module checks: if `routeConfig.platform` is true, require `request.platformActor` and a non-null `getPlatformActor` result, else 403 (`PLATFORM_REQUIRED` for the wrong kind, `FORBIDDEN` for a kind that is right but a row that is not). If a module is declared and `request.platformActor` is set, 403 `TENANT_CONTEXT_REQUIRED`. Leave the existing tenant path — including the `!userRole` branch — untouched; Task 8 decides that one.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/middleware/platform-authorization.test.ts`
Expected: PASS 6/6.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src
git commit -m "feat(auth): platform routes are authorized by being the platform actor"
```

---

### Task 5: Suspend and reactivate, enforced on every request

D6 responsibility 5, and the enum that has meant nothing since it landed. Enforcement goes in the per-request pass, not at login: a token minted before the suspension would otherwise keep working for its whole lifetime, which is the half of "suspended" that matters.

**Files:**
- Modify: `packages/api/src/services/provisioning.service.ts`
- Modify: `packages/api/src/services/rbac.service.ts` (status read + invalidation, alongside the module cache)
- Modify: `packages/api/src/middleware/authorization.ts`
- Test: `packages/api/src/__tests__/integration/suspension.integration.test.ts`, and the middleware case in `platform-authorization.test.ts`

**Interfaces:**
- Consumes: `getPlatformActor` and the route branch (Task 4).
- Produces:
  ```ts
  export async function suspendUtility(utilityId: string): Promise<UtilitySummary>
  export async function reactivateUtility(utilityId: string): Promise<UtilitySummary>
  export async function getUtilityStatus(utilityId: string): Promise<"ACTIVE" | "SUSPENDED" | null>
  ```
  No reason or `suspendedAt` column: the status column exists, nothing reads a reason, and inventing one is scope the spec does not ask for.

- [ ] **Step 1: Write the failing tests**

```ts
it("suspends and reactivates, reporting the status each way", async () => {
  expect((await svc.suspendUtility(TENANT)).status).toBe("SUSPENDED");
  expect((await svc.reactivateUtility(TENANT)).status).toBe("ACTIVE");
});

it("is idempotent in both directions", async () => {
  await svc.suspendUtility(TENANT);
  expect((await svc.suspendUtility(TENANT)).status).toBe("SUSPENDED");
});

it("refuses to suspend a utility that does not exist", async () => {
  await expect(svc.suspendUtility(ABSENT)).rejects.toMatchObject({ code: "UTILITY_NOT_FOUND" });
});
```

and, in the middleware test:

```ts
it("refuses a tenant route while the tenant is suspended", async () => {
  mockUtilityStatus("SUSPENDED");
  const res = await get("/__tenant", headers);
  expect(res.statusCode).toBe(403);
  expect(JSON.parse(res.body).error.code).toBe("TENANT_SUSPENDED");
});

it("lets the platform actor work while a tenant is suspended", async () => {
  // The actor has no tenant, so a tenant's status cannot gate it — and
  // it is who has to reactivate the thing.
  mockUtilityStatus("SUSPENDED");
  expect((await get("/__platform", platformHeaders)).statusCode).toBe(200);
});

it("reports the suspension before the module check", async () => {
  // "Module not enabled" for a suspended tenant sends the operator to
  // the wrong screen.
  mockUtilityStatus("SUSPENDED");
  const res = await get("/__tenant-disabled-module", headers);
  expect(JSON.parse(res.body).error.code).toBe("TENANT_SUSPENDED");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/suspension.integration.test.ts`
Expected: FAIL — `svc.suspendUtility is not a function`.

- [ ] **Step 3: Implement the three functions**

`suspendUtility` / `reactivateUtility` update `status` and return the same `UtilitySummary` shape `listUtilities` produces, throwing `UTILITY_NOT_FOUND` (statusCode 404) when the row is absent — the same `ProvisioningError` class, which already carries `statusCode` for the error handler. Each calls `invalidateUtilityStatusCache` after the write, or the suspension takes up to the TTL to bite.

`getUtilityStatus` caches under `utility-status:${utilityId}` beside `tenant-modules:${utilityId}`. Fold the read into the existing `Promise.all` in the middleware rather than adding a third await — that pass already fetches two things concurrently for a stated latency reason.

- [ ] **Step 4: Run both test files to verify they pass**

Run: `cd packages/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/suspension.integration.test.ts && npx vitest run src/__tests__/middleware/platform-authorization.test.ts`
Expected: PASS 3/3 and PASS 9/9.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "feat(tenancy): SUSPENDED means something"
```

---

### Task 6: The platform routes and the console at `/platform/tenants`

`routes/dev-tenants.ts` and `app/dev/tenants/page.tsx` were built at step 3 behind `!IS_PROD && ENABLE_DEV_AUTH_ENDPOINTS` because the authority they needed did not exist. It exists now, so the fence comes off and the route moves — which is what the route's own closing comment promised.

**Files:**
- Create: `packages/api/src/routes/platform-tenants.ts` (replaces `routes/dev-tenants.ts`, deleted)
- Delete: `packages/api/src/routes/dev-tenants.ts`, `packages/api/src/__tests__/integration/dev-tenants.test.ts`
- Create: `packages/api/src/__tests__/integration/platform-tenants.test.ts` (the fence cases become kind-of-identity cases)
- Modify: `packages/api/src/app.ts` (registration), `packages/api/src/routes/auth.ts` (`/auth/me` for a platform actor)
- Create: `packages/web/app/platform/tenants/page.tsx` (moved from `app/dev/tenants/page.tsx`, deleted)
- Modify: `packages/web/components/app-shell.tsx:15` (add `/platform` to the chrome exclusions)
- Modify: `packages/web/app/login/page.tsx` (a platform quick-login pill), `seed.js` (seed the platform actor)
- Modify: `CLAUDE.md` (the provisioning commands and the Multi-tenancy section)

**Interfaces:**
- Consumes: `{ platform: true }` (Task 4), `suspendUtility`/`reactivateUtility` (Task 5), `provisionTenant`/`listUtilities` (unchanged).
- Produces: `GET`/`POST /api/v1/platform/tenants`, `POST /api/v1/platform/tenants/:id/suspend`, `POST /api/v1/platform/tenants/:id/reactivate`.

- [ ] **Step 1: Write the failing test**

```ts
it("lists tenants for the platform actor", async () => {
  expect((await get("/api/v1/platform/tenants", platformHeaders)).statusCode).toBe(200);
});

it("refuses a tenant admin", async () => {
  expect((await get("/api/v1/platform/tenants", headers)).statusCode).toBe(403);
});

it("exists in a production build", async () => {
  // The inverse of the step-3 fence test: this route no longer
  // disappears, because the authority it needed now exists.
  const app = await buildAppWith({ NODE_ENV: "production" });
  expect(app.hasRoute({ method: "GET", url: "/api/v1/platform/tenants" })).toBe(true);
});

it("suspends and reactivates through the API", async () => {
  expect((await post(`/api/v1/platform/tenants/${TENANT}/suspend`, platformHeaders)).statusCode).toBe(200);
  expect((await post(`/api/v1/platform/tenants/${TENANT}/reactivate`, platformHeaders)).statusCode).toBe(200);
});

it("answers 404 for a tenant that does not exist", async () => {
  expect((await post(`/api/v1/platform/tenants/${ABSENT}/suspend`, platformHeaders)).statusCode).toBe(404);
});
```

Keep the step-3 body-validation cases — whitespace-only name, admin email without a name, a field the schema does not name — they are unchanged by the move.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/integration/platform-tenants.test.ts`
Expected: FAIL — 404 on every route; the module does not exist.

- [ ] **Step 3: Write the routes**

Same handlers as `dev-tenants.ts` with the fence and the `DEV_ENDPOINTS_ENABLED` early return deleted, `{ config: { module: "settings", permission: "EDIT" } }` replaced by `{ config: { platform: true } }`, and the two status routes added. Keep the `.strict()` body schema and the 200-for-a-dry-run status. Carry the header comment forward, rewritten: it explains what the authority *is* now, not what it is borrowing.

- [ ] **Step 4: Seed a platform actor and give it a login pill**

`seed.js` creates one `CisUser` with `utilityId: null` (`platform@utility.com`, "Platform Operator") and no `user_role` row — it has no tenant to hold a role in. `/api/v1/auth/dev-login` mints a platform token for it: the dev-login schema accepts a request with no `utilityId` and sets `platform: true` instead. `/login` gets a pill, visually separated from the tenant users, since it is a different kind of identity.

- [ ] **Step 5: Move the page and exclude `/platform` from admin chrome**

Move the file, update the two in-page references to `/dev`, and add `pathname.startsWith("/platform")` to `app-shell.tsx:15`. The page's "Requires System Admin" line becomes "Requires the platform operator". Add Suspend/Reactivate controls per row, each confirming first — suspending a tenant stops its staff working.

- [ ] **Step 6: Run the test to verify it passes, then type-check both packages**

Run: `cd packages/api && npx vitest run src/__tests__/integration/platform-tenants.test.ts && npx tsc --noEmit && cd ../web && npx tsc --noEmit`
Expected: PASS, and both type-checks clean.

- [ ] **Step 7: Verify the console by hand**

Reseed, sign in with the platform pill, and confirm: the list renders; Preview writes nothing; Create adds a tenant; Suspend flips the status and that tenant's own users then get `TENANT_SUSPENDED` on a tenant route; Reactivate restores them. Then sign in as a tenant admin and confirm `/platform/tenants` refuses.

- [ ] **Step 8: Update CLAUDE.md and commit**

```bash
git add packages/api packages/web seed.js CLAUDE.md
git commit -m "feat(platform): tenant onboarding leaves the dev fence"
```

---

### Task 7: Bull Board behind the platform actor

D4, and §1.6's concrete case: `app.ts:214` requires `tenant_profile:EDIT` for queues that are not tenant-scoped, so one tenant's admin can inspect — and with Bull Board's default controls retry or remove — another tenant's jobs. It borrowed a tenant permission because that was all the model offered. The model now offers the right one.

**Files:**
- Modify: `packages/api/src/app.ts` (the `preHandler` at ~`:214`)
- Test: `packages/api/src/__tests__/app/bull-board-authorization.test.ts`

**Interfaces:**
- Consumes: `getPlatformActor` (Task 4).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
it("refuses a tenant admin holding tenant_profile:EDIT", async () => {
  // The exact grant that used to be sufficient. ALL_QUEUE_NAMES are not
  // tenant-scoped and their payloads carry other tenants' ids.
  const app = await appWithBullBoard({ tenant_profile: ["VIEW", "EDIT"] });
  expect((await get(app, "/admin/queues", headers)).statusCode).toBe(403);
});

it("admits the platform actor", async () => {
  const app = await appWithBullBoard();
  expect((await get(app, "/admin/queues", platformHeaders)).statusCode).not.toBe(403);
});
```

`appWithBullBoard` builds the app with `BULL_BOARD_ENABLED=true` via `vi.stubEnv` + `vi.resetModules`, the same shape the step-3 fence test used.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/api && npx vitest run src/__tests__/app/bull-board-authorization.test.ts`
Expected: FAIL — the tenant admin is admitted (200 or a Bull Board redirect), because `tenant_profile:EDIT` is still the gate.

- [ ] **Step 3: Replace the preHandler's check**

Swap the `getUserRole` + `tenant_profile` lookup for `request.platformActor` + `getPlatformActor`. The 403 message stops naming a tenant permission.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/api && npx vitest run src/__tests__/app/bull-board-authorization.test.ts`
Expected: PASS 2/2.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src
git commit -m "fix(ops): the queue UI stops borrowing a tenant permission"
```

---

### Task 8: The "no `CisUser` row ⇒ allow" branch — decide it in the open

`authorization.ts:52-55` returns early when `getUserRole` finds nothing, commented "allow for now (backwards compatibility during migration)". The NextAuth credentials provider returns user `00000000-0000-4000-8000-000000000099`, which does not exist in the database (verified: `count = 0`), so every request authenticated through the web login form takes this branch and passes every permission check on every tenant route.

It is pre-existing and this plan's platform path does not use it. It is also the thing §1.7 warns about sitting next to a new identity, so it gets decided rather than inherited.

**Files:**
- Modify: `packages/api/src/middleware/authorization.ts`
- Test: `packages/api/src/__tests__/middleware/authorization.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Measure the blast radius before changing anything**

Run the whole unit and integration-style suite with the branch replaced by a 403 and record what fails:

Run: `cd packages/api && npx vitest run 2>&1 | tail -40`
Expected: a list. The question this answers is whether anything legitimate depends on it, or only the `...099` stub and tests that never seed a user.

- [ ] **Step 2: Write the failing test**

```ts
it("refuses a token for a user that does not exist", async () => {
  // The web login form's hardcoded ...099 takes this path today and is
  // granted every permission on every module.
  mockUserRoleMissing();
  const res = await get("/__tenant", headers);
  expect(res.statusCode).toBe(403);
  expect(JSON.parse(res.body).error.code).toBe("USER_NOT_PROVISIONED");
});
```

- [ ] **Step 3: Run it to verify it fails**

Expected: FAIL — 200, because the branch allows it.

- [ ] **Step 4: Replace the branch with a 403, and fix what Step 1 listed**

Tests that relied on an unseeded user get a seeded one; the web login stub is not this plan's to fix, and `/login`'s pills already mint tokens for real users. If Step 1 showed something legitimate depends on the branch, stop and ledger a ruling instead of forcing it.

- [ ] **Step 5: Run the full suite**

Run: `cd packages/api && npx vitest run`
Expected: PASS at or above the Step 1 baseline count.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src
git commit -m "fix(auth): an unknown user is refused, not waved through"
```

---

## Notes for whoever executes this

- **The web login form remains a stub** (`packages/web/lib/auth.ts:13-25` accepts any email with any password and returns a fixed user). That is out of scope here and is Q2's destination — apptorID for every identity, not just this one. Task 8 removes the thing that made the stub *powerful*; it does not make the stub a login. Do not claim production-ready authentication on the back of this plan.
- **Two of D6's six responsibilities are deliberately absent, and they are gaps rather than oversights.** #2's *disable* half: `utility_module.isEnabled` has a writer only for `true`, through provisioning, so there is no way to turn a module off. A toggle is a small addition, build-order step 5 does not ask for it, and it is not here. #3, the config profile, is blocked on Q4 — who chooses a profile and where the list lives — and `provisionTenant` already takes and validates the parameter, so the shape survives whatever Q4 answers.
- **Task 1 has an unknown-size outcome** by design. If it turns up more than a handful of holes, finish the sweep, ledger what it found, and raise the question of whether the remainder is its own branch before carrying on to Task 2.
- The integration suite takes ~24 minutes on an idle machine and is not in CI. Per-task runs are targeted files; ask before the full suite.
