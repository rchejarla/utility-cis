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
├── 13-notifications.md              — Templates, email + SMS (no postal channel)
├── 14-service-requests.md           — SR lifecycle, SLAs
├── 15-customer-portal.md            — Self-service portal (Phase 4.1 MVP complete)
├── 20-custom-fields.md              — Custom fields (Phase 1+2 complete)
├── 21-saaslogic-billing.md          — SaaSLogic payment collection (design; unblocked, needs vendor answers)
├── 23-accounts-receivable.md        — AR ledger, posting, balance (slice 1 complete)
├── 16-special-assessments.md        — Districts, parcel assessments
├── 17-reporting-and-audit.md        — Audit log, reports
├── 18-theme-and-configuration.md    — Tenant theme, settings
├── 19-rbac.md                       — Roles, permissions, preset roles
├── 22-import-infrastructure.md      — ImportBatch, ImportRow, the imports queue
├── 24-platform-worker-control.md    — Worker lifecycle across nodes (step 1 built)
├── 25-platform-console.md           — Platform actor's console: tenants + cluster (shipped)
├── 26-time-of-use-rates.md          — TOU calendars, seasons, interval data (proposed; nothing built)
└── 27-job-scheduling.md             — Scheduler visibility, queue pause, the billing dispatcher (proposed; nothing built)
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
- **Integrations:** apptor-connect (see below)

## Integrations

**Everything that leaves this process goes through apptor-connect** (`c:\development\apptor-connect`, HTTP surface `apptor-connect-service`, configured by `APPTOR_CONNECT_URL` + `APPTOR_CONNECT_API_KEY`). Email, SMS, postal mail, object storage, GIS, meter-reading systems, work-order systems, payment collection — all of it. Four planes:

| Plane | Use it for |
|---|---|
| `proxy` — `POST /proxy/v1/{integration}` | Calling a vendor's API. The service injects auth and applies timeouts, retries and per-tenant rate limits. |
| `files` — `/files/v1/*` | S3, Azure Blob, GCS, SFTP. Mint a link, stream the bytes, keep a pointer. |
| `events` — `POST /events/v1/{token}` | Verified, deduplicated inbound webhooks, read by cursor. The return path for vendor callbacks. |
| `resolve` — `POST /v1/resolve` | Connection details plus a short-lived token, when a caller genuinely must talk to a vendor directly. |

Its ownership hierarchy is `PLATFORM ⊃ TENANT ⊃ CUSTOMER ⊃ SUBJECT`, which maps onto `utility_id`. The `mail`, `sendgrid`, `s3`, `azure-blob`, `gcs`, `sftp`, `rest` and `kafka` connectors exist already.

**The rule this imposes: no vendor credential belongs in this codebase.** apptor-connect holds it and never hands it out — not in `.env`, not in `UtilityConfig.settings`, not in a new encrypted-secrets table. **One standing exception:** `NEXT_PUBLIC_MAPBOX_TOKEN`, the premise map's tile token, which is public by design, restricted by referrer at Mapbox, and has to reach the browser — no server-side proxy can hold a key the browser must present. Anything a *server* sends outward has no such excuse. A tenant-level integration setting names *which integration to use*, the way bill storage does; it never carries a key, a bucket, a region or a base URL. Before writing an HTTP client for anything external, check whether a connector already covers it: `packages/api/src/lib/apptor-connect/files-client.ts` is the shape to copy — one module owns the conversation, errors map to a 502 naming the integration, and a minted link is consumed internally and never persisted, because it is a bearer credential that needs no login.

**Payment collection is SaaSLogic** (`docs/specs/21-saaslogic-billing.md`), reached over this rail like any other vendor. CIS is the system of record for what is owed — rating, taxes, the bill, the ledger, the balance — and SaaSLogic is told an amount and reports whether it was paid. Card data, the hosted payment page and settlement are theirs, which is what keeps PCI scope at effectively zero. Payments also arrive as cash, cheque and lockbox and never touch SaaSLogic, which is why the ledger is ours.

## Commands

- `setup_db.bat` — First-time DB setup (start containers + push schema + apply RLS)
- `start_db.bat` — Start PostgreSQL + Redis containers
- `stop_db.bat` — Stop containers (data preserved)
- `migrate_db.bat` — Apply pending Prisma migrations to the dev DB (forward-only; some add enum values PostgreSQL cannot remove)
- `seed_db.bat` — Seed test data
- `node seed.js` — Alternative seed (CommonJS, so no `tsx` to run it — but it shells out to `scripts/provision-tenant.ts` for the tenant, and resolves `tsx` from the pnpm store, so a non-pnpm install fails here)
- `start_prod.bat` — Build + run in production mode
- `pnpm --filter @utility-cis/api dev:worker` — the BullMQ worker process. **`start_dev.bat` does not start it**, so by default every queue fills up and nothing in it ever runs: the repeatable schedulers go overdue, and enqueued billing runs and imports sit in `waiting` indefinitely. That is why `/platform/cluster/queues` reports worker attachment per queue — zero workers and a healthy-looking set of counts are the same picture otherwise. `WORKER_QUEUES=<comma-list>` serves a subset; **starting it will run whatever has accumulated**, so check what is waiting first — the five cron queues go overdue as soon as nothing is attached, and `notification-send` dispatches outward while `audit-retention` deletes rows. The platform console's Workers page (`/platform/cluster/workers`) can also start and stop it (`WORKER_CONTROL_ENABLED`, on by default outside production), which spawns the same process detached and records it in the `platform:workers` Redis hash so a `tsx watch` reload does not lose it.
- `node packages/api/scripts/grant-db-logins.mjs` — **the production step that makes `cis_app` and `cis_platform` connectable.** The `rls_roles` migration creates both NOLOGIN with no password on purpose: a password in a migration is a password in every clone of the repo forever. Dev gets throwaway logins from `scripts/grant-dev-db-logins.sql` (run by `setup_db.bat`); production runs this instead, after `migrate deploy` and before the app starts.

  Reads three environment variables, all deployment secrets: `ADMIN_DATABASE_URL` (a connection that may `ALTER ROLE` — the owner or a superuser, deliberately *not* `DATABASE_URL`, which by then names `cis_app`), `CIS_APP_PASSWORD` and `CIS_PLATFORM_PASSWORD`. Idempotent, so it is also how a password is rotated.

  **It computes the SCRAM-SHA-256 verifier locally and sends that, never the cleartext.** `ALTER ROLE … PASSWORD 'secret'` puts the password in a statement, which is visible in `pg_stat_activity` while it runs and is written to the server log under `log_statement = ddl` or `all` — a setting plenty of production databases use for audit, which would leave a database credential sitting in a log file. Passwords must be printable ASCII: PostgreSQL applies SASLprep before deriving its own verifier, and SASLprep is a no-op only for that range, so anything else would leave a role with a password nobody can use. The script refuses rather than hand back a credential that silently does not work.

  It also refuses to proceed if the roles are not shaped the way the migration left them — `cis_app` holding SUPERUSER or BYPASSRLS, `cis_platform` holding neither, or either role being a *member* of the other (it could then `SET ROLE` and inherit the bypass, leaving the split decorative while every attribute still looked right). `assertRlsEnforced` catches the first of those at startup; this catches all three while someone is still watching a terminal. Covered by `grant-db-logins.integration.test.ts`, which proves the credential it sets can actually log in.

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
express. Since 2026-10-25 add the 64 **tenant-scoped foreign keys** to
that list: every key between two tenant-scoped tables is
`(utility_id, <fk>) -> parent (utility_id, id)`, so a row in one tenant
cannot reference a row in another — which RLS cannot enforce, because a
referential-integrity check is not a row read. Prisma cannot express 17
of them (it requires every referencing field of a `SetNull` relation to
be optional, and `utility_id` is not), so all 64 stay in SQL and
`schema-invariants.integration.test.ts` fails if any regresses to a
single column. The 2026-10-25 collections work added two more
(`delinquency_rule.fee_reason_id`, `delinquency_action.fee_entry_id`),
declared as bare scalar columns in `schema.prisma` with the key itself
in the migration, plus a **partial unique index**
(`delinquency_action_one_live_per_rule`) that Prisma cannot express
either. `migrate dev` compares the database against the model, finds
all of it undescribed, and generates a migration *reverting* it. It
reads as a routine drift fix and would silently drop the ledger's
invariants and full-text search. Use `migrate deploy`; write schema
changes by hand, or generate with `migrate diff` and read the output
line by line before keeping it.

## Multi-tenancy

Every entity has `utility_id`, and since 2026-10-18 it is a **foreign key to `utility(id)`** (`ON DELETE RESTRICT`) — a tenant is a row, so a write naming one that does not exist is refused. It is nullable on seven global reference tables, where NULL means "belongs to no tenant". PostgreSQL RLS enforces tenant isolation at DB level, and since 2026-10-24 it genuinely does: the app connects as **`cis_app`**, a non-owning role with no bypass, while `cis` stays the owner for migrations and `cis_platform` holds BYPASSRLS for work that crosses tenants by design. Every policied table FORCEs RLS, so the owner exemption is closed too. Dev tenant UUID: `00000000-0000-4000-8000-000000000001`.

**The acting tenant travels in AsyncLocalStorage, not in a parameter.** `runAsTenant(utilityId, fn)` / `runAsPlatform(fn)` (`lib/tenant-context.ts`) declare which authority the work runs under; `lib/prisma.ts` owns the `pg` pool and applies `app.current_utility_id` once per connection checkout, and picks the tenant or platform pool from the same context. Requests get their scope from a Fastify hook, queue jobs from `QUEUE_TENANCY` via `scopedJob`. Three things follow:

- **`await` inside the callback.** `runAsTenant(id, () => prisma.x.findFirst(…))` is a bug: a `PrismaPromise` is lazy, so returning one out of the scope executes it after the scope has exited. The scope covers the whole handler, not one query.
- **An unscoped read of a tenant table raises**, it does not return zero rows — `''::uuid` is a 22P02, which surfaces as a 400 `PRISMA_P2007`. That is deliberate: an empty result reads as "nothing is wrong". The eight policies that admit tenant-less rows are `nullif(…, '')` guarded.
- **A cross-tenant sweep needs `cis_platform`** or it finds nothing and reports success. That is why `/platform/cluster/queues` and `queue-scope.ts` exist in the shape they do.

`assertRlsEnforced` refuses to start in production on a bypassing role, an unFORCEd policied table, or a confined `DATABASE_URL` with no `DATABASE_URL_PLATFORM`; outside production it warns, since a dev superuser is normal. Full account, including what would undo it: `docs/design/utility-cis-architecture.md` §7.1.

**The platform actor** is a `CisUser` with a **null `utility_id`** — the one identity that sits above tenants (tenancy design note Q2). It holds no `user_role` row: being the platform actor *is* the authority, so platform routes declare `{ config: { platform: true } }` instead of a module and permission, and `getPlatformActor` gates them on a real row with `utility_id IS NULL` and `is_active`. A tenant's own System Admin is refused there, which is the point — it holds every permission a *tenant* can grant, which is not the same authority.

Consequences worth knowing before touching `cis_user`:
- `utility_id` being nullable means a query reading users by tenant has to mean it: a platform row matches no `utility_id = $1`. `schema-invariants.integration.test.ts` pins which tables may have a null `utility_id` (the seven global reference tables, plus `cis_user`), so widening that set fails a test on purpose.
- Both `@@unique([utility_id, …])` constraints stop constraining a platform row, since Postgres treats NULLs as distinct. Two **partial unique indexes** cover it (`email`, and `external_id` where present) and exist only in SQL — Prisma cannot express them, so `migrate dev` would propose dropping them.
- `request.user` is **not** set on a platform request; `request.platformActor` is, and the authorization middleware refuses each kind on the other's routes. That is deliberate: `request.user.utilityId` stays a non-nullable string at all 243 of its read sites.

**Suspending a tenant** sets `Utility.status` and is enforced on every request, in the same authorization pass that checks enabled modules — a token minted before the suspension would otherwise keep working for its lifetime. It deletes nothing; purge is a separate, deferred capability.

**Anything writing tenant-scoped rows must ensure the utility row exists first.** Integration tests declare their tenants at `bootPostgres({ utilities: [...] })`, or call `ensureUtilities(prisma, [...])` if they boot their own container; `schema-invariants.integration.test.ts` guards the shape.

## Portal

Customer portal lives at `/portal/*` as a route segment in the web app. Unified JWT format shared with admin — portal tokens carry a `customer_id` claim. Portal users are `CisUser` rows with a `customerId` FK to `Customer` and a `Portal Customer` role with `portal_*` module permissions. Admin chrome (sidebar/topbar) is skipped for `/portal/*`, `/login`, `/dev` and `/platform/*` routes.

**Portal API routes:** `/portal/api/auth/register`, `/portal/api/auth/login`, `/portal/api/dashboard` (carries `amountDue`, summed from the customer's `Account.balance` rows), `/portal/api/accounts`, `/portal/api/accounts/:accountId`, `/portal/api/accounts/:accountId/bills`, `/portal/api/agreements/:id/usage`, `/portal/api/profile` (GET + PATCH), `/portal/api/bills/:id/document` (GET — the customer's own bill PDF, streamed through the API).

**Every portal route carries the ownership check in its query** (`requireCustomerId` plus `customerId` in the `where`), and that is why they exist at all rather than reusing the admin routes: the staff equivalents filter on tenant and account only, because a CSR may read any account. Granting a portal token `accounts:VIEW` would therefore let any signed-in customer read a stranger's data by passing their id. A miss is a **404, not a 403** — whether someone else's account exists is not the caller's to learn. The bills route additionally **withholds unposted bills**: a bill is a calculation until it is posted, so the customer does not owe it, and the staff Bills tab is where posting happens.

**Dev test credentials:** `jane.smith@example.com` and `robert.j@example.com` (seeded via `seed_db.bat`). Login at `/login` and click the portal customer quick-login pills.

## Platform console

Lives at `/platform/*` in the web app, behind the **platform actor** (see Multi-tenancy above). Full spec: `docs/specs/25-platform-console.md`.

Two nav sections, because they answer two different questions:

- **Platform** — tenant lifecycle: `/platform/utilities`, `/platform/utilities/new` (provision, with a dry-run Preview), `/platform/utilities/:id` (modules, roles, staff, readiness, from-outside history), `/platform/users` (the operators themselves).
- **Cluster** — the deployment: `/platform/cluster` (is anything wrong), `/platform/cluster/workers` (nodes and worker processes), `/platform/cluster/queues` (counts for the eight queues), `/platform/cluster/jobs` (the jobs behind a count, with retry/promote/replay).

Chrome is `components/platform-shell.tsx`. These screens mount **no `AuthPermissionProvider`** on purpose: `/auth/me` answers 403 for a platform token and the provider then falls back to granting every permission, so any gating it appeared to do here would be fabricated. The real gate is `{ config: { platform: true } }`, server-side.

**Workers are a separate Node process** (`packages/api/src/worker.ts`) and `start_dev.bat` does not start one, so the ordinary state of a dev stack is eight queues filling up with nothing attached. Start one from `/platform/cluster/workers`, or run `pnpm --filter @utility-cis/api dev:worker`. Worker control is allowed unless `NODE_ENV=production`, where `WORKER_CONTROL_ENABLED` must be set explicitly (`workerControlAllowed()`); a start lands on the node serving the request, and a stop is offered only where the pid is that node's to signal — cluster-wide control is steps 2–4 of `docs/specs/24-platform-worker-control.md`.

**Tests must not enqueue into the dev Redis.** Integration tests that exercise a route which enqueues mock `enqueueSafely`; without that, a test run leaves jobs behind that look like real stuck work on this console — which is exactly how 102 unrunnable dev jobs appeared.
