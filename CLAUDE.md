# Utility CIS — Project Guidelines

## Architectural decision discipline

Before recommending OR implementing any pattern with a recognizable name (outbox, event bus, CQRS, saga, queue, abstraction layer, indirection, hexagonal, BFF, "decoupling X from Y", "adding a layer for future flexibility"), apply this checklist. **Skipping it has produced real over-engineering in this codebase before** (the EventEmitter audit pipeline is one example — solves nothing it claims to solve, costs an extra transaction per audit, breaks atomicity).

1. **State the simpler alternative first.** Write down what the direct, synchronous, in-process, in-transaction version would do. If you can't articulate the simple version, you don't understand the problem yet.

2. **Name the concrete cost the pattern pays.** "Decoupling" and "flexibility" are not costs — they're vague benefits with no measurable outcome. State the specific consequence: "closes atomicity gap on crash between mutation and audit," "isolates request latency from third-party API failure," "lets schedulers and API write to the same table without two code paths." If you can't name a concrete cost, the pattern isn't earning its keep.

3. **Verify the conditions that justify the pattern hold.** Patterns from textbooks assume specific conditions (multiple consumers, slow/flaky external dispatch, high concurrent load, async-tolerant timing). If those conditions aren't present in this codebase right now, the pattern is speculative scaffolding.

4. **Default to direct.** Reach for the complex pattern only when the simple one demonstrably fails — not when it might fail later, not when a textbook says it could fail at scale, but when you can name the specific scenario that breaks the simple version today.

5. **"Future flexibility" is not a justification.** YAGNI. Add the indirection when the second consumer arrives, not before.

6. **Steelman existing code before replacing it.** If existing code is "non-idiomatic," check whether it's solving a real constraint first. Cleaner-looking code that loses correctness or performance is worse than ugly correct code.

**Trigger phrases that should make you STOP and apply this checklist:**
- "Best practice is..."
- "The textbook pattern is..."
- "We should decouple X from Y"
- "Let's add an event bus / outbox / queue / abstraction"
- "This gives us flexibility for the future"
- "It's the canonical way to..."

## Documentation Maintenance

**IMPORTANT:** When making changes to the data model, API, or UI, you MUST update the corresponding functional spec and design document.

### Functional Specs (one per module)

Location: `docs/specs/`

Each module has its own spec covering entities, API endpoints, business rules, UI pages, and phase roadmap:

```
docs/specs/
├── 00-data-model-overview.md        — Master entity reference
├── 01-customer-management.md        — Customer, Contact, BillingAddress
├── 02-premise-management.md         — Premise, property types, owner
├── 03-meter-management.md           — Meter, MeterRegister, inventory
├── 04-account-management.md         — Account, deposits, status
├── 05-service-agreement.md          — ServiceAgreement, meter assignments
├── 06-commodity-and-uom.md          — Commodity, UnitOfMeasure
├── 07-rate-management.md            — RateSchedule, rate types, versioning
├── 08-meter-reading.md              — MeterRead, imports, exceptions
├── 09-billing.md                    — BillingCycle, billing execution
├── 10-payments-and-collections.md   — Payments, late fees, payment plans
├── 11-delinquency.md                — Rules, notices, shut-off
├── 12-solid-waste.md                — Container, cart management
├── 13-notifications.md              — Templates, email/SMS/mail
├── 14-service-requests.md           — SR lifecycle, SLAs
├── 15-customer-portal.md            — Self-service portal (Phase 4.1 MVP complete)
├── 20-custom-fields.md              — Custom fields (Phase 1+2 complete)
├── 21-saaslogic-billing.md          — SaaSLogic billing integration (Phase 3 design)
├── 23-accounts-receivable.md        — AR ledger, posting, balance (slice 1 complete)
├── 16-special-assessments.md        — Districts, parcel assessments
├── 17-reporting-and-audit.md        — Audit log, reports
├── 18-theme-and-configuration.md    — Tenant theme, settings
```

### Master Design Document

Location: `docs/design/utility-cis-architecture.md`

Single overarching architecture and data model reference for the entire system (all phases). Update entity counts, field definitions, and API endpoints when the schema changes.

### When to Update

- **Adding/modifying a Prisma model** → Update the relevant functional spec + design doc data model section
- **Adding/modifying an API endpoint** → Update the relevant functional spec + design doc API section
- **Adding/modifying a UI page** → Update the relevant functional spec UI section
- **Adding a new entity** → Update `00-data-model-overview.md` + relevant module spec + master design doc

## Tech Stack

- **Monorepo:** Turborepo + pnpm
- **API:** Fastify (TypeScript) on port 3001
- **Web:** Next.js 14+ on port 3000
- **Database:** PostgreSQL 16+ with TimescaleDB, Prisma ORM, Row-Level Security
- **UI:** Tailwind CSS, Font Awesome Pro icons
- **Auth:** NextAuth.js with JWT
- **Validation:** Zod (shared between API and UI)

## Commands

- `setup_db.bat` — First-time DB setup (start containers + push schema + apply RLS)
- `start_db.bat` — Start PostgreSQL + Redis containers
- `stop_db.bat` — Stop containers (data preserved)
- `migrate_db.bat` — Apply pending Prisma migrations to the dev DB (forward-only; some add enum values PostgreSQL cannot remove)
- `seed_db.bat` — Seed test data
- `node seed.js` — Alternative seed (CommonJS, so no `tsx` to run it — but it shells out to `scripts/provision-tenant.ts` for the tenant, and resolves `tsx` from the pnpm store, so a non-pnpm install fails here)
- `start_prod.bat` — Build + run in production mode
- `pnpm --filter @utility-cis/api dev:worker` — the BullMQ worker process. **`start_dev.bat` does not start it**, so by default every queue fills up and nothing in it ever runs: the repeatable schedulers go overdue, and enqueued billing runs and imports sit in `waiting` indefinitely. That is why `/platform/queues` reports worker attachment per queue — zero workers and a healthy-looking set of counts are the same picture otherwise. `WORKER_QUEUES=<comma-list>` serves a subset; **starting it will run whatever has accumulated**, so check what is waiting first.
- `npx tsx scripts/provision-tenant.ts --list` — list tenants with their module, role and user counts
- `npx tsx scripts/provision-tenant.ts --name "<name>" [--dry-run]` — create a tenant: utility row, all 32 modules, the six preset roles, optionally a first admin (`--admin-email`, `--admin-name`). On Windows `tsx` resolves at `node_modules/.pnpm/node_modules/.bin/tsx.cmd`.

  **Idempotency is keyed on the id, not the name.** `--utility-id <uuid> --name "<same name>"` re-runs as a no-op reporting zeros, which is what `seed.js` relies on. Without `--utility-id` each run invents one, so the same name twice would be two tenants — refused with `UTILITY_NAME_TAKEN` (409) instead, case-insensitively. A different name for an id that exists is refused too (`UTILITY_NAME_MISMATCH`): renaming is its own operation. `--dry-run` does everything and writes nothing, so both refusals land before you commit to the run.

### Recreating the database after the 2026-10-18 migration squash

The 54 incremental migrations were collapsed into three files
(`baseline`, `database_features`, `reference_data`). Any database created
before that holds 48–51 applied migrations that no longer exist on disk,
so **`migrate_db.bat` will refuse to run** — Prisma reports them missing
rather than applying anything. This is expected, not a fault.

Recreate instead. From the repo root, with the containers up:

```
docker exec utility-cis-db-1 psql -U cis -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='utility_cis';"
docker exec utility-cis-db-1 psql -U cis -d postgres -c "DROP DATABASE utility_cis;" -c "CREATE DATABASE utility_cis;"
cd packages/shared && npx prisma migrate deploy && cd ../..
node seed.js
```

Stop the API first, or the drop fails with "There is 1 other session
using the database" — and a `migrate deploy` attempted after a failed
drop leaves an unfinished row in `_prisma_migrations` that blocks later
runs until the database is dropped anyway.

**Also re-run `pnpm --filter @utility-cis/shared exec prisma generate`.**
The generated client is gitignored and nothing regenerates it on install,
so a stale one still describes `tenant_config` and `tenant_module` —
tables the squash renamed out of existence. Symptom: `Cannot read
properties of undefined (reading 'upsert')`, or a query against a
relation that does not exist.

Losing the data is the intent: this product is in development and data
that does not fit a new design is reseeded, never migrated.

**Never run `prisma migrate dev` against this schema.** The
`database_features` migration holds 35 CHECK constraints, 6 generated
columns, 62 RLS policies, a hypertable, a trigger, an exclusion
constraint and 6 partial indexes — none of which `schema.prisma` can
express. `migrate dev` compares the database against the model, finds
all of it undescribed, and generates a migration *reverting* it. It
reads as a routine drift fix and would silently drop the ledger's
invariants and full-text search. Use `migrate deploy`; write schema
changes by hand, or generate with `migrate diff` and read the output
line by line before keeping it.

## Multi-tenancy

Every entity has `utility_id`, and since 2026-10-18 it is a **foreign key to `utility(id)`** (`ON DELETE RESTRICT`) — a tenant is a row, so a write naming one that does not exist is refused. It is nullable on seven global reference tables, where NULL means "belongs to no tenant". PostgreSQL RLS enforces tenant isolation at DB level, though the policies are inert while the app role is a superuser that owns the tables. The API sets `app.current_utility_id` per request via JWT claims. Dev tenant UUID: `00000000-0000-4000-8000-000000000001`.

**The platform actor** is a `CisUser` with a **null `utility_id`** — the one identity that sits above tenants (tenancy design note Q2). It holds no `user_role` row: being the platform actor *is* the authority, so platform routes declare `{ config: { platform: true } }` instead of a module and permission, and `getPlatformActor` gates them on a real row with `utility_id IS NULL` and `is_active`. A tenant's own System Admin is refused there, which is the point — it holds every permission a *tenant* can grant, which is not the same authority.

Consequences worth knowing before touching `cis_user`:
- `utility_id` being nullable means a query reading users by tenant has to mean it: a platform row matches no `utility_id = $1`. `schema-invariants.integration.test.ts` pins which tables may have a null `utility_id` (the seven global reference tables, plus `cis_user`), so widening that set fails a test on purpose.
- Both `@@unique([utility_id, …])` constraints stop constraining a platform row, since Postgres treats NULLs as distinct. Two **partial unique indexes** cover it (`email`, and `external_id` where present) and exist only in SQL — Prisma cannot express them, so `migrate dev` would propose dropping them.
- `request.user` is **not** set on a platform request; `request.platformActor` is, and the authorization middleware refuses each kind on the other's routes. That is deliberate: `request.user.utilityId` stays a non-nullable string at all 243 of its read sites.

**Suspending a tenant** sets `Utility.status` and is enforced on every request, in the same authorization pass that checks enabled modules — a token minted before the suspension would otherwise keep working for its lifetime. It deletes nothing; purge is a separate, deferred capability.

**Anything writing tenant-scoped rows must ensure the utility row exists first.** Integration tests declare their tenants at `bootPostgres({ utilities: [...] })`, or call `ensureUtilities(prisma, [...])` if they boot their own container; `schema-invariants.integration.test.ts` guards the shape.

## Portal

Customer portal lives at `/portal/*` as a route segment in the web app. Unified JWT format shared with admin — portal tokens carry a `customer_id` claim. Portal users are `CisUser` rows with a `customerId` FK to `Customer` and a `Portal Customer` role with `portal_*` module permissions. Admin chrome (sidebar/topbar) is skipped for `/portal/*`, `/login`, `/dev` and `/platform/*` routes.

**Portal API routes:** `/portal/api/auth/register`, `/portal/api/auth/login`, `/portal/api/dashboard`, `/portal/api/accounts`, `/portal/api/accounts/:id`, `/portal/api/agreements/:id/usage`, `/portal/api/profile` (GET + PATCH), `/portal/api/bills/:id/document` (GET — the customer's own bill PDF, streamed through the API).

**Dev test credentials:** `jane.smith@example.com` and `robert.j@example.com` (seeded via `seed_db.bat`). Login at `/login` and click the portal customer quick-login pills.
