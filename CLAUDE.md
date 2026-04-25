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
- `seed_db.bat` — Seed test data
- `node seed.js` — Alternative seed (no tsx needed)
- `start_prod.bat` — Build + run in production mode

## Multi-tenancy

Every entity has `utility_id`. PostgreSQL RLS enforces tenant isolation at DB level. The API sets `app.current_utility_id` per request via JWT claims. Dev tenant UUID: `00000000-0000-4000-8000-000000000001`.

## Portal

Customer portal lives at `/portal/*` as a route segment in the web app. Unified JWT format shared with admin — portal tokens carry a `customer_id` claim. Portal users are `CisUser` rows with a `customerId` FK to `Customer` and a `Portal Customer` role with `portal_*` module permissions. Admin chrome (sidebar/topbar) is skipped for `/portal/*`, `/login`, and `/dev` routes.

**Portal API routes:** `/portal/api/auth/register`, `/portal/api/auth/login`, `/portal/api/dashboard`, `/portal/api/accounts`, `/portal/api/accounts/:id`, `/portal/api/agreements/:id/usage`, `/portal/api/profile` (GET + PATCH).

**Dev test credentials:** `jane.smith@example.com` and `robert.j@example.com` (seeded via `seed_db.bat`). Login at `/login` and click the portal customer quick-login pills.
