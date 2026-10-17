# Tenancy Modes and the Platform Admin — Design

**Status:** design, nothing built.
**Prompted by:** Rao, 2026-10-17 — "we have two modes platform mode and a
self serve mode… i don't think we have system admin currently. System
admin gets to modify some of the global configs." Then, on being told
there is no such actor: "but in multi tenant mode, a system admin is
required. isn't it to see health etc and modify globals?"

---

## 1. What exists today

Everything in this section was checked against the code. Where a claim is
a judgement rather than a fact, §3 says so.

### 1.1 There are no tenancy modes

`PLATFORM_MODE`, `SELF_SERVE`, `SINGLE_TENANT`, `MULTI_TENANT`,
`TENANCY`, `DEPLOYMENT_MODE` — none appear in `packages/api/src/config.ts`
or anywhere in `packages/shared/src`. The phrase "self-serve" in
`docs/specs/15-customer-portal.md` refers to *customers* self-serving on
their own account; `docs/specs/12-solid-waste.md`'s "single tenant-scoped"
describes one Prisma query. The two-mode split is design intent that has
never reached code or specs.

What the code does assume, everywhere, is **one tenant per request**:
every entity carries `utility_id`, PostgreSQL RLS enforces isolation at
the database, and the API sets `app.current_utility_id` per request from
JWT claims.

### 1.2 "System Admin" is a tenant role, not a platform actor

`packages/shared/src/modules/constants.ts:112` defines it in
`PRESET_ROLES`:

| Preset | Permissions |
|---|---|
| **System Admin** | every module, plus `settings: [VIEW, CREATE, EDIT, DELETE]` |
| **Utility Admin** | every module, but `settings: [VIEW]` |

The only thing that pair distinguishes is who may change **this tenant's
own settings**. Both are rows in that tenant's `role` table carrying its
`utility_id`. **No actor exists above a tenant.** The name misleads: it
reads as a platform role and is not one.

### 1.3 Global reference rows exist and are read-only to every tenant

Five tables ship rows with `utility_id = NULL`, all global, none
tenant-scoped (counted in the dev database):

| Table | Global rows |
|---|---|
| `account_type_def` | 5 (Residential, Commercial, Industrial, Municipal, Government) |
| `premise_type_def` | 5 |
| `measure_type_def` | 6 |
| `rate_component_kind` | 11 |
| `rate_assignment_role` | 5 |

They arrive by **migration `INSERT`**, not by the seed, and no migration
hardcodes the dev tenant UUID — so any deployment running
`prisma migrate deploy` gets them. Reads union the global set with the
tenant's own: `OR: [{ utilityId: null }, { utilityId }]` in
`account-type-def.service.ts:47`, `measure-type-def.service.ts:44`,
`premise-type-def.service.ts:49`, `service-request-type-def.service.ts:41`
and `suspension-type-def.service.ts:46`.

**Mutation is already blocked**, and deliberately: every update does
`findFirst({ where: { id, utilityId } })`
(`account-type-def.service.ts:102`), and a global row's `utility_id` is
`NULL`, so a tenant admin — System Admin included — gets *"not found or
not owned by this tenant"*. `service-request-type-def.service.ts` exposes
no update at all. So today the only thing that changes a global row is a
migration.

### 1.4 Two of those tables are not configuration

`rate_component_kind` and `rate_assignment_role` look like config and are
not. The rate engine **dispatches on their codes**: `rate-engine/rate.ts`
branches on `kindCode === "minimum_bill"` (`:51`, `:88`) and excludes
`"tax"` and `"credit"` when summing (`:117`). Adding a row named
`storm_fee` yields a row and no behaviour. They are the engine's
vocabulary, stored relationally so tariffs can reference them by FK.

This distinction matters for any future admin UI: four of the five tables
are genuinely extensible, two of them are constants in a table and must
not be offered as editable.

### 1.5 There is no way to create a tenant

`utility.create`, `utility.upsert`, `tenantModule.create`,
`tenantModule.upsert`, `tenantModule.createMany` — **zero occurrences**
outside tests, across the API and the seed.

Consequences, both already observed:

- Onboarding a second tenant means a developer running SQL.
- A freshly migrated and seeded database answers **403** on every gated
  route, because `tenant_module` rows do not exist. Integration suites
  create them inline and invalidate the RBAC cache
  (`billing-run.integration.test.ts:89` and six other suites) — they are
  working around a missing provisioning path, not testing one.

### 1.6 An ops surface is already borrowing a tenant permission

`packages/api/src/app.ts:196` mounts Bull Board at `/admin/queues` behind
`BULL_BOARD_ENABLED`, with a `preHandler` requiring **`tenant_profile:EDIT`**
(`:214`). It registers `ALL_QUEUE_NAMES` (`:208`) — the shared BullMQ
queues, which are **not** tenant-scoped.

Job payloads carry `utilityId`, account ids, run ids, import batch ids and
file names. So under multi-tenancy, one tenant's admin can inspect — and,
with Bull Board's default controls, retry or remove — another tenant's
jobs. Nothing is exposed today: the flag is off by default and there is
one tenant. It is latent, and it exists **because** no platform actor
exists: the queue UI had to borrow the nearest tenant permission, since
that is all the model offers.

This is the concrete case for a platform actor. The rest of this document
is about keeping that actor as small as possible.

---

## 2. Decisions

### D1. The platform actor's job is tenant lifecycle. Not health, not editing globals.

Create a utility, enable its modules, load its config profile, create its
first admin, deactivate it. That is the set with no other home (§1.5), and
it is required the day a second tenant is onboarded without a developer.

### D2. Health stays outside the application

`/health` is unauthenticated by design, returns 200 even when the cache is
down, and reports `cache` (the client's connection state) for a monitor to
read. An in-app health screen is unhealthy exactly when it is needed — the
page that would tell you the API is broken is served by the broken API.
Platform health belongs to probes, alerts and dashboards.

Bull Board is the cautionary example rather than the counterexample: an
ops surface wired into tenant RBAC, which is how §1.6 happened.

### D3. Global rows change by migration or by tenant override — never by a live console

A write to a `utility_id = NULL` row changes behaviour for every tenant at
once, unreviewed, with no rollback. The two mechanisms already in place
are both safer, and between them they cover the need:

- **Migration** — versioned, reviewed, deployed deliberately. Right for a
  value that genuinely should change for everyone.
- **Tenant override** — a row with the tenant's own `utility_id`. Blast
  radius of one. Right for "this city calls it something else".

A platform console that mutates shared rows is the most dangerous of the
three and the least necessary. If one is ever built it should write a
migration, not a row.

### D4. Bull Board moves behind the platform actor, or out of the app

Before multi-tenancy ships, `/admin/queues` must either require the
platform actor or be removed from the API and run as a separate ops
service. `tenant_profile:EDIT` is the wrong gate for a surface that shows
every tenant's work.

### D5. The mode is deployment configuration, not a runtime toggle

A single `TENANCY_MODE` (`self_serve` | `platform`), read at boot,
defaulting to `self_serve`. Not a per-tenant row and not switchable at
runtime, because the two modes differ in **security model** rather than in
features: platform mode introduces an identity that is not scoped by
`utility_id`, which is precisely what RLS is built to prevent. A runtime
toggle would mean both code paths live in every deployment, including the
single-tenant ones that have no use for the second.

In `self_serve`, tenant admin **is** system admin: the provisioning
service runs once at install, and no platform actor exists at runtime.
That is the mode every current deployment is in, and it needs none of
§2's machinery beyond D1's script.

---

## 3. Open questions

These need answers before implementation, and none is settled here.

**Q1 — Does a tenant row override a global row of the same code?**
Unverified. The reads in §1.3 union both sets; nothing has been checked
about collision resolution. If a tenant adding `RESIDENTIAL` yields two
rows rather than a shadowed one, D3's "override by addition" does not
actually work yet and needs building. *Check this first — it decides
whether customisation is already solved.*

**Q2 — Where does the platform actor's identity live?**
Three candidates: a column on `CisUser` with `utility_id` nullable; a
separate `platform_user` table; or outside the CIS entirely, in apptorID,
with the API trusting a claim. The third keeps the CIS free of a second
user model but puts the trust boundary in a token.

**Q3 — How does RLS treat it?**
Either a database role that bypasses RLS, or an actor that still sets
`app.current_utility_id` per operation and simply may set it to any
tenant. The second is far more auditable and keeps one enforcement
mechanism; it also means the platform actor can never read two tenants in
one query, which is a feature.

**Q4 — Who chooses a tenant's seed profile at provisioning time?**
Related to the seed-profile split (commodities, UOMs, cycles and tariffs
are tenant *configuration*, not demo data). Provisioning needs to name a
profile; where that list lives is undecided.

---

## 4. Build order

Deliberately ordered so the risky part is last and the useful part is
first.

1. **Answer Q1.** One grep and one test. It may remove the need for parts
   of this document.
2. **Provisioning service** — `provisionTenant(...)`: utility row,
   `tenant_module` rows, preset roles, first admin, config profile.
   Idempotent, callable from a script, **no UI**. This is the piece with
   value in both modes, and it closes the 403-on-a-fresh-database trap
   that every integration suite currently works around.
3. **`TENANCY_MODE` in config**, defaulting to `self_serve`, read at boot.
   Nothing branches on it yet.
4. **Platform actor** (Q2, Q3), and move `/admin/queues` behind it (D4).
5. **A platform console UI** — only if operating the above through
   scripts proves genuinely insufficient. Not before.

---

## 5. What this does not cover

- Billing, rating and AR are untouched by any of it.
- No schema change is proposed here; Q2 will propose one.
- Per-tenant branding, theme and settings already work and are not part of
  this question.
