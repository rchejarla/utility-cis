# Utility CIS — Project Guidelines

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
├── 15-customer-portal.md            — Self-service portal
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
