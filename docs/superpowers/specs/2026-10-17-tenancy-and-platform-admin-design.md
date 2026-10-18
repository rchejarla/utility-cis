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

`seed.js` defines it among the preset roles (it was also defined in
`packages/shared/src/modules/constants.ts` as `PRESET_ROLES`, which had
no consumer and has since been deleted — the seed is now the only
definition):

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

**There is also nothing to create.** Checked 2026-10-18: there is no
`Utility` or `Tenant` model in `schema.prisma`, and no such table in the
database — the only tenant-named tables are `utility_config`,
`utility_module`, `utility_theme` and `utility_setting`, each of which
describes a tenant without being one. `utility_id` carries **zero
foreign-key constraints** anywhere in the schema.

So a tenant is an uncontrolled UUID repeated across every table. It has
no name, no status, no created-at, and nothing distinguishes a new
tenant from a typo. Tenants cannot be listed except by
`SELECT DISTINCT utility_id` over an arbitrary table. Every statement
elsewhere in this document about "a tenant" is, today, a statement about
a value in a column.

Consequences, both already observed:

- Onboarding a second tenant means a developer running SQL.
- A freshly migrated and seeded database answers **403** on every gated
  route, because `utility_module` rows do not exist. Integration suites
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

### 1.7 Tenant separation is predicate-based, and the predicates have holes

RLS is inert today — the application role is a superuser and owns the
tables — so the `utility_id` predicates in application code are the only
thing separating tenants (`lib/prisma.ts:43-45`, architecture doc §7.1).
That is already documented. What was not known until it was checked is
how reliably those predicates are actually present.

Auditing the two queues that run several tenants' jobs concurrently in
one process — `imports` (concurrency 4) and `delinquency-tenant` (5) —
the workers came back clean: `processBatch` and `evaluateAll` both verify
ownership once at the entry and derive the rest from the proved id, and
all 13 database accesses in the five import handlers carry `utility_id`.
The shared service both call did not: `notification.service.ts` took
`utilityId` and spent it on one query while seven lookups read by primary
key alone, two of them reachable from routes that accept the id from the
request body. Fixed the same day; detail and the audit lesson are in
architecture doc §7.1.

**Why this belongs in a document about a platform actor.** Q2 and Q3 ask
where the platform identity lives and how RLS treats it. §1.7 is the
reason Q3's second option — an actor that still sets
`app.current_utility_id` per operation and may set it to any tenant — is
the right one, and it sharpens the argument beyond auditability: an
identity *not* scoped by `utility_id` would be entering a codebase where
scoping is a convention each query opts into, and where a seven-instance
lapse survived in a service called from two workers and three routes.
Under those conditions the mechanism that enforces isolation should be
the one that cannot be forgotten at a call site.

That also makes **build order step 5 — the platform actor — depend on
more than Q2 and Q3**: the
`utilityId`-parameter-that-scopes-nothing shape is worth sweeping for
deliberately before an unscoped identity exists, not after.

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

### D6. A tenant has to exist as a thing before anything can sit above it

Agreed 2026-10-18. §1.5 is not "provisioning is missing" — it is that a
tenant is a UUID in a column with no row, no name, no status and no
foreign key. An actor above tenants presupposes tenants as objects, so
the entity precedes the actor and precedes provisioning, which has
nothing to write without it.

**The actor's scope is tenant lifecycle, and that is these six things:**

| # | Responsibility | Why it has no other home |
|---|---|---|
| 1 | Create a tenant — identity, display name, status, created-at | Nothing represents a tenant at all |
| 2 | Enable and disable its modules | `utility_module` has no writer outside tests; a fresh database answers 403 on every gated route |
| 3 | Apply a config profile — commodities, UOMs, cycles, tariffs | Q4; this is configuration, not demo data |
| 4 | Create its first admin | A tenant with no user cannot be administered into existence |
| 5 | Suspend and reactivate | `isActive` exists on users, not on tenants |
| 6 | List tenants | Today this is `SELECT DISTINCT utility_id` over an arbitrary table |

Plus exactly one thing that is not lifecycle and still belongs, because
nothing else can own it: **the cross-tenant queue surface** (D4). §1.6 is
the concrete case — Bull Board borrowed `tenant_profile:EDIT` for queues
that are not tenant-scoped, because a tenant permission was all the
model offered.

**Deferred out of v1**, agreed 2026-10-18. Each is a real need; none is
lifecycle, and each would widen the one identity in the system that can
cross the tenant boundary:

- **Impersonation** ("log in as this tenant's admin"). The standard
  support answer and the largest single expansion of this actor. If it
  ever lands it needs to be time-boxed and written into the *tenant's*
  own audit log.
- **Hard delete and data export.** Offboarding splits into suspend
  (reversible, #5) and purge (irreversible). They must not be one
  capability.
- **Per-tenant integration credentials.** Still open from the
  bill-production work: one deployment-level apptor-connect key versus
  one per utility. If per-tenant, provisioning owns minting it.
- **Cross-tenant billing and usage reporting.** Spec 21's SaaSLogic
  integration means the vendor bills the utilities, which is a read
  across all tenants — a different shape from lifecycle, and probably a
  separate concern with its own identity.

**The principle this scope is sized by.** The platform actor is the only
thing in the system that can cross the tenant boundary, so it holds only
what cannot live anywhere else. Every capability added to it is a
capability that can reach every customer's data.

---

## 3. Open questions

These need answers before implementation, and none is settled here.

**Q1 — Does a tenant row override a global row of the same code?**
**Answered 2026-10-17: yes in the list path, and it was honoured nowhere
else.** All five services run an identical shadow pass — rows collected
into a `Map` keyed by code, a tenant row replacing a global one
(`account-type-def.service.ts:51`, and byte-for-byte the same in the
other four). `@@unique([utilityId, code])` lets both rows coexist, and
the DTO exposes `isGlobal` so a UI can tell them apart. So D3's "override
by addition" works.

The rule's five copies are inline loops, reusable by nothing, and both
consumers outside those services got it wrong:

- `bill-message.service.ts` required a targeted `accountTypeDefId` to
  *belong to* the tenant. Every account type is global, so Settings →
  Bill Messages offered five options and answered 404 to all five —
  account-type targeting had never worked, while Req 137 was recorded as
  shipped in two documents. Fixed: the check now asks whether the tenant
  may target the row, and still refuses another tenant's.
- `bill-presentation.service.ts` resolved the type by code over both sets
  with an unordered `findFirst`, so with an override present the winner
  was whatever Postgres returned first — on the path that decides what a
  customer's bill says. Fixed: ordered `utilityId` descending, nulls
  last.

**The lesson for anything built on §2.** The resolution rule is policy,
and it currently lives as five copies of a loop plus two hand-written
queries. A sixth consumer will get it wrong the same way. Before adding a
platform actor that can write these rows, give the rule one home — a
`resolveDefByCode(table, utilityId, code)` helper, or a database view that
applies the shadow — so a caller inherits it instead of reimplementing
it.

**Q2 — Where does the platform actor's identity live?**
**Answered 2026-10-18: `CisUser`, with `utility_id` nullable — and
apptorID eventually, for every identity rather than this one.** The
third candidate (identity outside the CIS, the API trusting a claim) is
the destination, but it is the destination for tenant users and portal
users too, so it is not a decision this actor should force on its own.
Until then a null `utility_id` means "not a tenant's user", which is
exactly what a platform actor is, and it needs no second user model.

Two consequences this answer creates, neither settled by it:

- `CisUser.utilityId` is currently NOT NULL and, since 2026-10-18, a
  foreign key to `utility`. Making it nullable follows the pattern the
  seven global-reference tables already use, so the mechanics are
  known — but it means every query reading `cis_user` by tenant has to
  mean it, because a null row now exists and belongs to nobody.
- `@@unique([utilityId, email])` stops constraining platform users:
  Postgres treats nulls as distinct, so two platform actors could share
  an email address. A partial unique index on `email WHERE utility_id IS
  NULL` is the fix, and it is the same shape as the five partial indexes
  the migration squash turned up.

**Q3 — How does RLS treat it?**
**Answered 2026-10-18: split by operation.** Tenant *lifecycle*
operations run outside `utility_id` — creating, listing, suspending a
utility, enabling its modules, loading its profile, creating its first
admin. Every other operation sets `app.current_utility_id` exactly as
today. So this is not a role that bypasses RLS wholesale, and the actor
still cannot read two tenants in one ordinary query.

The consequence to settle before step 5: with no tenant context,
`current_setting('app.current_utility_id', true)` is NULL, and every
policy compares `utility_id = NULL`, which is NULL, which filters the
row out. A lifecycle operation would therefore see nothing. It needs
either a role exempt from RLS for those operations only, or policies
that admit an explicit platform context — a second setting the policy
ORs in. The question is live but not urgent: the policies are inert
today because the application role is a superuser that owns the tables
(§1.7).

**Q4 — Who chooses a tenant's seed profile at provisioning time?**
Related to the seed-profile split (commodities, UOMs, cycles and tariffs
are tenant *configuration*, not demo data). Provisioning needs to name a
profile; where that list lives is undecided.

---

## 4. Build order

Deliberately ordered so the risky part is last and the useful part is
first.

1. ~~**Answer Q1.**~~ Done 2026-10-17. Override-by-addition works; two
   consumers that ignored it are fixed. Before step 5, give the shadow
   rule one home — see Q1 for why a sixth consumer will otherwise repeat
   the same mistake.
2. **The tenant entity** (D6). A `Utility` model with id, display name,
   status and created-at, and a foreign key from `utility_id` to it.
   Inserted ahead of provisioning on 2026-10-18, because provisioning has
   nothing to write without it and every "per tenant" claim in this
   document is currently a claim about a value in a column (§1.5).

   **No backfill.** The product is in development and no deployment holds
   data worth preserving, so existing rows that do not fit the new shape
   are not migrated — `seed.js` creates the utility row first and the
   database is recreated. That keeps the migration a plain `CREATE TABLE`
   plus constraints, with no data-repair step to get wrong, and it is the
   rule for this whole document: where a change does not fit the data,
   change the seed.

   The foreign key is still the load-bearing part — `utility_id` appears
   on every entity with no constraint anywhere today — but it costs a
   reseed rather than a repair.
3. **Provisioning service** — `provisionTenant(...)`: utility row,
   `utility_module` rows, preset roles, first admin, config profile.
   Idempotent, callable from a script, **no UI**. This is the piece with
   value in both modes, and it closes the 403-on-a-fresh-database trap
   that every integration suite currently works around.
4. **`TENANCY_MODE` in config**, defaulting to `self_serve`, read at boot.
   Nothing branches on it yet.
5. **Platform actor** — a `CisUser` with a null `utility_id` (Q2), whose
   lifecycle operations run outside `utility_id` while everything else
   sets `app.current_utility_id` (Q3) — and move `/admin/queues` behind
   it (D4). Both answers landed 2026-10-18; each left one consequence to
   settle first, recorded with them: a partial unique index on platform
   emails, and how a lifecycle operation reads past a policy that
   compares against a NULL setting.
   Preceded by a deliberate sweep for the `utilityId`-parameter-that-
   scopes-nothing shape — see §1.7 for why this one is a prerequisite
   rather than hygiene.
6. **A platform console UI** — only if operating the above through
   scripts proves genuinely insufficient. Not before.

---

## 5. What this does not cover

- Billing, rating and AR are untouched by any of it.
- No schema change is proposed here; Q2 will propose one.
- Per-tenant branding, theme and settings already work and are not part of
  this question.
