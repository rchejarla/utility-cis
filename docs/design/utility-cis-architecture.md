# Utility CIS — System Architecture & Design

**Last updated:** 2026-04-08
**Status:** Phase 1 complete, Phase 2 in progress

---

## 1. Overview

The Utility CIS (Customer Information System) is a multi-tenant SaaS platform for small-to-mid-market utilities (5,000–100,000 accounts). It manages the utility domain — customers, premises, meters, accounts, service agreements, rate schedules, and billing — while integrating with SaaSLogic for financial operations and ApptorFlow for workflow orchestration.

### Key Principle

**CIS owns the utility domain. SaaSLogic owns the money.** The handoff is a structured billing instruction. This boundary is non-negotiable.

### Service Boundaries

| Service | Owns | Integrates With |
|---------|------|-----------------|
| **Utility CIS** | Customers, premises, meters, accounts, service agreements, rate schedules, meter reads, billing instructions | SaaSLogic (billing), ApptorFlow (workflows) |
| **SaaSLogic** | Invoices, payments, payment plans, dunning, revenue recognition, financial ledger | CIS (receives billing instructions) |
| **ApptorFlow** | Workflow orchestration: start/stop service, collections, anomaly response, approvals | CIS (events), SaaSLogic (payment events) |

### Target Market

- Small-to-mid-market utilities (5,000–100,000 accounts)
- Multi-utility: water, electric, gas, sewer, solid waste, stormwater
- Modern SaaS alternative to Oracle CC&B and legacy municipal systems
- Configurable per tenant, not customizable per codebase

---

## 2. Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Monorepo | Turborepo + pnpm | Build orchestration, shared types |
| API | Fastify (TypeScript) | REST API on port 3001 |
| Admin UI | Next.js 14+ App Router | Admin UI on port 3000 |
| UI Components | Tailwind CSS + Font Awesome Pro | Styling and icons |
| ORM | Prisma | Type-safe DB client, migrations |
| Database | PostgreSQL 16+ | Relational data, RLS multi-tenancy |
| Time-Series | TimescaleDB (PG extension) | Meter read hypertables |
| Cache | Redis | Rate schedule caching, sessions |
| Auth | NextAuth.js + jose | JWT with utility_id claim, signature verification |
| Map | Mapbox GL JS + react-map-gl | Premises map view |
| Clustering | Supercluster | Client-side map clustering |
| Validation | Zod | Shared schemas between API and UI |
| Events | Node.js EventEmitter (Phase 1) | Internal domain events → audit log |
| Testing | Vitest | Unit + integration tests |

---

## 3. Architecture

### 3.1 Monorepo Structure

```
utility-cis/
├── packages/
│   ├── shared/              — Prisma schema, Zod validators, types, events
│   ├── api/                 — Fastify REST API (port 3001)
│   └── web/                 — Next.js Admin UI (port 3000)
├── docs/
│   ├── design/              — This document
│   └── specs/               — Module-level functional specs
├── turbo.json
├── docker-compose.yml       — PostgreSQL (TimescaleDB) + Redis
└── CLAUDE.md                — Project guidelines
```

### 3.2 Request Lifecycle

1. **Auth Middleware** — verifies JWT signature (jose + NEXTAUTH_SECRET), extracts user + utility_id
2. **Tenant Context** — validates utility_id is UUID, sets `SET app.current_utility_id` on DB connection
3. **RLS Enforcement** — PostgreSQL automatically filters all queries by utility_id
4. **Route Handler** — validates input (Zod), calls service layer
5. **Event Emission** — state changes fire internal events → audit log

### 3.3 Multi-Tenancy

Every entity is scoped by `utility_id`. Tenant isolation is enforced at the database level via PostgreSQL Row-Level Security policies.

```sql
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
```

The API validates utility_id as UUID format before interpolation (SQL injection prevention) and sets RLS context per-request.

### 3.4 Integration Contract: CIS → SaaSLogic

**Billing Instruction (CIS → SaaSLogic):** When billing cycle runs, CIS generates a billing instruction per service agreement and delivers to SaaSLogic via REST API.

**Payment Event (SaaSLogic → CIS):** When payment received, SaaSLogic fires webhook to CIS to update account standing.

### 3.5 Event Bus: CIS ↔ ApptorFlow

Every significant CIS state change emits a domain event. ApptorFlow subscribes and triggers workflows. Phase 1 uses internal EventEmitter; Phase 3+ will use Kafka or RabbitMQ.

---

## 4. Data Model

### 4.1 Entity Summary

**29 entities** across 9 categories:

| Category | Entities |
|----------|----------|
| **Customer** | Customer, Contact, BillingAddress |
| **Reference** | Commodity, UnitOfMeasure |
| **Core** | Premise, Meter, MeterRegister, Account |
| **Agreement** | ServiceAgreement, ServiceAgreementMeter (junction) |
| **Configuration** | RateSchedule, BillingCycle |
| **Operations** | MeterRead (TimescaleDB hypertable, composite PK on `(id, read_datetime)`), MeterEvent, ImportBatch, Attachment |
| **Solid Waste** | Container, ServiceSuspension, ServiceEvent |
| **System** | AuditLog, TenantTheme, UserPreference |
| **RBAC** | CisUser, Role, TenantModule |

### 4.2 Entity Relationship Diagram

```
Customer ──────┬──→ Account ──────→ ServiceAgreement ──→ ServiceAgreementMeter ──→ Meter
(person/org)   │   (billing)       (the core unit)      (junction, 1 or many)     (device)
               │       │                  │                                          │
               │       ├──→ Contact       ├──→ Premise ←────────────────────────────┘
               │       └──→ BillingAddress│   (location)                    (belongs to)
               │                          │
               └──→ Premise (as owner)    ├──→ Commodity ←──→ UnitOfMeasure
                                          ├──→ RateSchedule
                                          └──→ BillingCycle
                                          
Meter ──→ MeterRegister (1 or many channels)
MeterRead ──→ Meter + MeterRegister (optional) + ServiceAgreement
```

### 4.3 Customer

The person or organization who receives utility service.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| customer_type | ENUM | INDIVIDUAL, ORGANIZATION |
| first_name | VARCHAR(100) | Required for INDIVIDUAL |
| last_name | VARCHAR(100) | Required for INDIVIDUAL |
| organization_name | VARCHAR(255) | Required for ORGANIZATION |
| email | VARCHAR(255) | |
| phone | VARCHAR(20) | |
| alt_phone | VARCHAR(20) | |
| date_of_birth | DATE | |
| drivers_license | VARCHAR(50) | For ID verification |
| tax_id | VARCHAR(50) | For organizations |
| status | ENUM | ACTIVE, INACTIVE |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** [utility_id, last_name, first_name], [utility_id, email], [utility_id, phone]

### 4.4 Contact

People associated with an account, with defined roles.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| customer_id | UUID | Nullable FK → Customer |
| role | ENUM | PRIMARY, BILLING, AUTHORIZED, EMERGENCY |
| first_name | VARCHAR(100) | |
| last_name | VARCHAR(100) | |
| email | VARCHAR(255) | |
| phone | VARCHAR(20) | |
| is_primary | BOOLEAN | Default false |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 4.5 BillingAddress

Alternate bill-to address. Supports international addresses.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| address_line1 | VARCHAR(255) | |
| address_line2 | VARCHAR(255) | |
| city | VARCHAR(100) | |
| state | VARCHAR(50) | |
| zip | VARCHAR(20) | |
| country | VARCHAR(2) | Default "US" |
| is_primary | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 4.6 Commodity

Utility service types. Configurable per tenant — no hardcoded ENUM.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| code | VARCHAR(50) | e.g. "WATER", "ELECTRIC", unique per utility |
| name | VARCHAR(100) | e.g. "Potable Water" |
| default_uom_id | UUID | FK → UnitOfMeasure |
| is_active | BOOLEAN | Default true |
| display_order | INTEGER | |
| created_at | TIMESTAMPTZ | |

### 4.7 UnitOfMeasure

Measurement units per commodity with conversion factors.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| code | VARCHAR(20) | e.g. "GAL", "CCF", "KWH" |
| name | VARCHAR(100) | |
| commodity_id | UUID | FK → Commodity |
| conversion_factor | DECIMAL(15,8) | To base unit |
| is_base_unit | BOOLEAN | |
| is_active | BOOLEAN | |
| created_at | TIMESTAMPTZ | |

**Unique:** [utility_id, commodity_id, code]

### 4.8 Premise

Physical address where utility service is delivered. Permanent — outlives customers.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| owner_id | UUID | Nullable FK → Customer (property owner) |
| address_line1 | VARCHAR(255) | |
| address_line2 | VARCHAR(255) | |
| city | VARCHAR(100) | |
| state | CHAR(2) | |
| zip | VARCHAR(10) | |
| geo_lat | DECIMAL(9,6) | For map view |
| geo_lng | DECIMAL(9,6) | For map view |
| premise_type | ENUM | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| commodity_ids | UUID[] | FK → Commodity (which commodities served here) |
| service_territory_id | UUID | |
| municipality_code | VARCHAR(50) | |
| status | ENUM | ACTIVE, INACTIVE, CONDEMNED |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 4.9 Meter

Physical device measuring consumption. Retained across customer changes.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| premise_id | UUID | FK → Premise |
| meter_number | VARCHAR(100) | Unique per utility |
| commodity_id | UUID | FK → Commodity |
| meter_type | ENUM | AMR, AMI, MANUAL, SMART |
| uom_id | UUID | FK → UnitOfMeasure |
| dial_count | INTEGER | |
| multiplier | DECIMAL(10,4) | Default 1.0 |
| install_date | DATE | |
| removal_date | DATE | |
| status | ENUM | ACTIVE, REMOVED, DEFECTIVE, PENDING_INSTALL |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 4.10 MeterRegister

Multi-register/channel support. One physical meter can have multiple registers measuring different things.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| meter_id | UUID | FK → Meter |
| register_number | INTEGER | Position (1, 2, 3...) |
| description | VARCHAR(100) | e.g. "High Flow", "On-Peak kWh" |
| uom_id | UUID | FK → UnitOfMeasure |
| multiplier | DECIMAL(10,4) | Default 1.0 |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |

**Unique:** [meter_id, register_number]

### 4.11 Account

Billing relationship between a customer and the utility.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_number | VARCHAR(50) | Unique per utility |
| customer_id | UUID | FK → Customer |
| account_type | ENUM | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| status | ENUM | ACTIVE, INACTIVE, FINAL, CLOSED, SUSPENDED |
| credit_rating | ENUM | EXCELLENT, GOOD, FAIR, POOR, UNRATED |
| deposit_amount | DECIMAL(10,2) | |
| deposit_waived | BOOLEAN | |
| deposit_waived_reason | VARCHAR(255) | |
| language_pref | CHAR(5) | Default "en-US" |
| paperless_billing | BOOLEAN | |
| budget_billing | BOOLEAN | |
| saaslogic_account_id | UUID | FK into SaaSLogic |
| created_at | TIMESTAMPTZ | |
| closed_at | TIMESTAMPTZ | |

### 4.12 ServiceAgreement

The core billing unit. Links account + premise + commodity + rate schedule + billing cycle. Meters linked via junction table.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| agreement_number | VARCHAR(50) | Unique per utility |
| account_id | UUID | FK → Account |
| premise_id | UUID | FK → Premise |
| commodity_id | UUID | FK → Commodity |
| rate_schedule_id | UUID | FK → RateSchedule |
| billing_cycle_id | UUID | FK → BillingCycle |
| start_date | DATE | |
| end_date | DATE | Null = active |
| status | ENUM | PENDING, ACTIVE, FINAL, CLOSED |
| read_sequence | INTEGER | Order in reading route |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Status transitions:** PENDING → ACTIVE → FINAL → CLOSED (no skipping)

### 4.13 ServiceAgreementMeter (Junction)

Links one or more meters to an agreement. Most residential = 1 meter. Commercial/industrial may have multiple.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| meter_id | UUID | FK → Meter |
| is_primary | BOOLEAN | Default true |
| added_date | DATE | |
| removed_date | DATE | Null = currently linked |
| created_at | TIMESTAMPTZ | |

**Constraints:** A meter can only be in one active agreement per commodity at a time.

### 4.14 RateSchedule

Pricing rules for a commodity. Effective-dated and versioned.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(255) | |
| code | VARCHAR(50) | |
| commodity_id | UUID | FK → Commodity |
| rate_type | ENUM | FLAT, TIERED, TIME_OF_USE, DEMAND, BUDGET |
| effective_date | DATE | |
| expiration_date | DATE | |
| description | TEXT | |
| regulatory_ref | VARCHAR(100) | Docket/filing reference |
| rate_config | JSONB | Structure varies by rate_type |
| version | INTEGER | Default 1 |
| supersedes_id | UUID | Self-ref FK (version chain) |
| created_at | TIMESTAMPTZ | |

**Unique:** [utility_id, code, version]

**rate_config structures:** See module spec `docs/specs/07-rate-management.md`

### 4.15 BillingCycle

Defines when meters in a cycle are read and bills generate.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(255) | |
| cycle_code | VARCHAR(20) | Unique per utility |
| read_day_of_month | INTEGER | 1-28 |
| bill_day_of_month | INTEGER | 1-28 |
| frequency | ENUM | MONTHLY, BIMONTHLY, QUARTERLY |
| active | BOOLEAN | |

### 4.16 MeterRead

Every reading from a meter. TimescaleDB hypertable for interval data at scale.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| meter_id | UUID | FK → Meter |
| register_id | UUID | Nullable FK → MeterRegister |
| service_agreement_id | UUID | FK → ServiceAgreement |
| read_date | DATE | |
| read_datetime | TIMESTAMPTZ | Hypertable partition key |
| reading | DECIMAL(12,4) | Raw dial reading |
| prior_reading | DECIMAL(12,4) | |
| consumption | DECIMAL(12,4) | Calculated |
| read_type | ENUM | ACTUAL, ESTIMATED, CORRECTED, FINAL, AMI |
| read_source | ENUM | MANUAL, AMR, AMI, CUSTOMER_SELF, SYSTEM |
| exception_code | VARCHAR(50) | HIGH_USAGE, ZERO_USAGE, METER_DEFECT |
| reader_id | UUID | |
| created_at | TIMESTAMPTZ | |

### 4.17 AuditLog

All entity state changes via internal event emitter.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| entity_type | VARCHAR(100) | |
| entity_id | UUID | |
| action | ENUM | CREATE, UPDATE, DELETE |
| actor_id | UUID | |
| before_state | JSONB | Null on CREATE |
| after_state | JSONB | Null on DELETE |
| metadata | JSONB | |
| created_at | TIMESTAMPTZ | |

**Indexes:** [utility_id, entity_type, entity_id], [utility_id, created_at]

### 4.18 TenantTheme

Per-tenant UI theme with dark/light mode support.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Unique (one per tenant) |
| preset | VARCHAR(50) | midnight, daybreak, dusk, forest |
| colors | JSONB | `{ "dark": {...}, "light": {...} }` |
| typography | JSONB | `{ "body": "...", "display": "..." }` |
| border_radius | INTEGER | Pixels |
| logo_url | VARCHAR(500) | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 4.19 UserPreference

Per-user settings.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| user_id | UUID | |
| theme_mode | ENUM | DARK, LIGHT, SYSTEM |
| preferences | JSONB | Extensible |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** [utility_id, user_id]

### 4.20 Attachment

Generic file attachment for any entity. Uses entityType + entityId pattern to associate documents, photos, or other files with any CIS entity (Premise, Customer, Account, Meter, ServiceAgreement).

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| entity_type | VARCHAR(100) | e.g. "Premise", "Meter", "Customer" |
| entity_id | UUID | PK of the associated entity |
| file_name | VARCHAR(255) | Original uploaded file name |
| file_type | VARCHAR(100) | MIME type (e.g. "application/pdf", "image/jpeg") |
| file_size | INTEGER | File size in bytes |
| storage_path | VARCHAR(500) | Internal path in object storage |
| uploaded_by | UUID | User UUID (from JWT) |
| description | VARCHAR(500) | Optional description of the attachment |
| created_at | TIMESTAMPTZ | |

**RLS policy:** Enforced — utility_id must match tenant context.

**Indexes:** [utility_id, entity_type, entity_id]

### 4.21 TenantConfig

Per-tenant configuration flags. One row per utility, created lazily the first time any flag is set; absence of a row means "all defaults."

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Unique — one config per tenant |
| require_hold_approval | BOOLEAN | Default false. Gates ServiceSuspension activation on the APPROVE permission. See spec 12. |
| settings | JSONB | Extensible bucket for tenant flags. Currently carries `numberFormats.{agreement,account}` — see §5.3 "Identifier generation." |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** [utility_id]
**RLS:** standard `utility_id = current_setting('app.current_utility_id')::uuid`.

### 4.22 SuspensionTypeDef

Reference table for service-hold type codes. Replaces the former `SuspensionType` Prisma enum. A row with `utility_id IS NULL` is a global system code visible to every tenant; a row with a set `utility_id` is a tenant-scoped custom code.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Nullable; NULL = global, visible to all tenants |
| code | VARCHAR(50) | Uppercase alphanumeric + underscore |
| label | VARCHAR(100) | Display label |
| description | TEXT | |
| category | VARCHAR(50) | |
| sort_order | INT | Default 100 |
| is_active | BOOLEAN | Default true |
| default_billing_suspended | BOOLEAN | Per-type form default (wired in Phase 3) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Unique:** [utility_id, code] — lets tenants override a global code by inserting a tenant-specific row with the same code (shadow resolution in the service layer).

**RLS:** non-standard policy: `utility_id IS NULL OR utility_id = current_setting('app.current_utility_id')::uuid`. Global rows are readable across all tenants, custom rows remain tenant-isolated.

**Seeded codes** (global, inserted by `seed.js`): `VACATION_HOLD`, `SEASONAL`, `TEMPORARY`, `DISPUTE`, `UNAVAILABLE`, `REGULATORY`.

### 4.23 Database Invariants (CHECK constraints)

Zod validators guard the API boundary, but any backstop invariants that absolutely must hold — regardless of which service, migration, or ad-hoc SQL session writes the data — live as PostgreSQL CHECK constraints. The full list is in `packages/shared/prisma/migrations/01_check_constraints/migration.sql` and is applied automatically by `setup_db.bat` after the RLS migration. The file is idempotent (`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`) so re-running setup is safe.

| Constraint category | Examples |
|---|---|
| Non-negative / positive numerics | `account.deposit_amount >= 0`, `uom.conversion_factor > 0`, `meter.multiplier > 0`, `meter.dial_count > 0`, `commodity.display_order >= 0`, `rate_schedule.version >= 1` |
| Date ordering | `rate_schedule.expiration_date > effective_date`, `service_agreement.end_date >= start_date`, `meter.removal_date >= install_date`, `service_agreement_meter.removed_date >= added_date` |
| Day-of-month bounds | `billing_cycle.read_day_of_month BETWEEN 1 AND 31`, same for `bill_day_of_month` (Zod tightens further to 1–28 at the API boundary; CHECK is the calendar floor) |
| Format checks | `customer.email` / `contact.email` / `cis_user.email` match a basic email regex; `account.language_pref` matches `^[a-z]{2}-[A-Z]{2}$` |
| Non-empty identifiers | `account.account_number`, `meter.meter_number`, `service_agreement.agreement_number`, `commodity.code`, `uom.code`, `billing_cycle.cycle_code`, `rate_schedule.code` |

The design principle is **defense in depth**: Zod returns nice errors at the API boundary, Prisma constrains the schema at application build time, and CHECK constraints are the storage-layer backstop. A bug in any single layer cannot produce data that violates the other layers' assumptions.

---

## 5. API Design

### 5.1 Base URL & Auth

All endpoints under `/api/v1`. All require a JWT bearer token with a `utility_id` claim except for two explicitly public routes: `/health` (liveness probe) and `/api/v1/openapi.json` (machine-readable API contract). Public routes are marked with `{ config: { skipAuth: true } }` on the route options; the auth and tenant middlewares honor that flag so adding a new public route is a one-line config change rather than a middleware edit.

### 5.2 Endpoints (~85 current)

| Method | Path | Module |
|--------|------|--------|
| GET | `/api/v1/openapi.json` | Meta (public, no auth) |
| GET | `/api/v1/auth/me` | Auth (RBAC) |
| GET | `/api/v1/customers` | Customer |
| POST | `/api/v1/customers` | Customer |
| GET | `/api/v1/customers/:id` | Customer |
| PATCH | `/api/v1/customers/:id` | Customer |
| GET | `/api/v1/contacts` | Contact |
| POST | `/api/v1/contacts` | Contact |
| PATCH | `/api/v1/contacts/:id` | Contact |
| DELETE | `/api/v1/contacts/:id` | Contact |
| GET | `/api/v1/billing-addresses` | BillingAddress |
| POST | `/api/v1/billing-addresses` | BillingAddress |
| PATCH | `/api/v1/billing-addresses/:id` | BillingAddress |
| GET | `/api/v1/commodities` | Commodity |
| POST | `/api/v1/commodities` | Commodity |
| PATCH | `/api/v1/commodities/:id` | Commodity |
| GET | `/api/v1/uom` | UOM |
| POST | `/api/v1/uom` | UOM |
| PATCH | `/api/v1/uom/:id` | UOM |
| DELETE | `/api/v1/uom/:id` | UOM |
| GET | `/api/v1/premises` | Premise |
| POST | `/api/v1/premises` | Premise |
| GET | `/api/v1/premises/:id` | Premise |
| PATCH | `/api/v1/premises/:id` | Premise |
| GET | `/api/v1/premises/geo` | Premise (map) |
| GET | `/api/v1/meters` | Meter |
| POST | `/api/v1/meters` | Meter |
| GET | `/api/v1/meters/:id` | Meter |
| PATCH | `/api/v1/meters/:id` | Meter |
| GET | `/api/v1/accounts` | Account |
| POST | `/api/v1/accounts` | Account |
| GET | `/api/v1/accounts/:id` | Account |
| PATCH | `/api/v1/accounts/:id` | Account |
| GET | `/api/v1/service-agreements` | Agreement |
| POST | `/api/v1/service-agreements` | Agreement |
| GET | `/api/v1/service-agreements/:id` | Agreement |
| PATCH | `/api/v1/service-agreements/:id` | Agreement |
| POST | `/api/v1/service-agreements/:id/meters` | Agreement (add meter) |
| PATCH | `/api/v1/service-agreements/:id/meters/:samId` | Agreement (remove meter) |
| GET | `/api/v1/rate-schedules` | Rate |
| POST | `/api/v1/rate-schedules` | Rate |
| GET | `/api/v1/rate-schedules/:id` | Rate |
| POST | `/api/v1/rate-schedules/:id/revise` | Rate |
| GET | `/api/v1/billing-cycles` | Billing |
| POST | `/api/v1/billing-cycles` | Billing |
| GET | `/api/v1/billing-cycles/:id` | Billing |
| PATCH | `/api/v1/billing-cycles/:id` | Billing |
| GET | `/api/v1/theme` | Theme |
| PUT | `/api/v1/theme` | Theme |
| POST | `/api/v1/theme/reset` | Theme |
| GET | `/api/v1/audit-log` | Audit |
| GET | `/api/v1/attachments` | Attachment |
| POST | `/api/v1/attachments` | Attachment |
| GET | `/api/v1/attachments/:id/download` | Attachment |
| DELETE | `/api/v1/attachments/:id` | Attachment |
| GET | `/api/v1/users` | RBAC (settings) |
| POST | `/api/v1/users` | RBAC (settings) |
| GET | `/api/v1/users/:id` | RBAC (settings) |
| PATCH | `/api/v1/users/:id` | RBAC (settings) |
| GET | `/api/v1/roles` | RBAC (settings) |
| POST | `/api/v1/roles` | RBAC (settings) |
| GET | `/api/v1/roles/:id` | RBAC (settings) |
| PATCH | `/api/v1/roles/:id` | RBAC (settings) |
| DELETE | `/api/v1/roles/:id` | RBAC (settings) |
| GET | `/api/v1/tenant-modules` | RBAC (settings) |
| GET | `/api/v1/meter-reads` | Meter Reads |
| GET | `/api/v1/meter-reads/exceptions` | Meter Reads (exception queue) |
| GET | `/api/v1/meter-reads/:id` | Meter Reads |
| POST | `/api/v1/meter-reads` | Meter Reads (manual entry; `serviceAgreementId` optional — auto-resolved) |
| PATCH | `/api/v1/meter-reads/:id` | Meter Reads (creates CORRECTED row, preserves original) |
| DELETE | `/api/v1/meter-reads/:id` | Meter Reads (guarded against frozen + corrected-by state) |
| POST | `/api/v1/meter-reads/:id/resolve-exception` | Meter Reads |
| GET | `/api/v1/meters/:meterId/reads` | Meter Reads (per-meter history) |
| GET | `/api/v1/meter-events` | Meter Events |
| GET/POST/PATCH | `/api/v1/meter-events[/:id]` | Meter Events |
| GET | `/api/v1/containers` | Containers (solid waste) |
| GET/POST/PATCH | `/api/v1/containers[/:id]` | Containers |
| POST | `/api/v1/containers/:id/swap` | Containers (atomic size/type swap) |
| GET | `/api/v1/premises/:premiseId/containers` | Containers |
| GET | `/api/v1/service-agreements/:agreementId/containers` | Containers |
| GET | `/api/v1/service-suspensions` | Service Suspensions |
| GET/POST/PATCH | `/api/v1/service-suspensions[/:id]` | Service Suspensions |
| POST | `/api/v1/service-suspensions/:id/complete` | Service Suspensions |
| POST | `/api/v1/service-suspensions/:id/approve` | Service Suspensions (APPROVE permission; stamps `approved_by`) |
| POST | `/api/v1/service-suspensions/:id/activate` | Service Suspensions (manual PENDING → ACTIVE; refuses if approval gate not met) |
| POST | `/api/v1/service-suspensions/:id/cancel` | Service Suspensions |
| GET | `/api/v1/service-agreements/:agreementId/suspensions` | Service Suspensions |
| GET | `/api/v1/suspension-types` | Suspension type reference table (global + per-tenant codes) |
| POST/PATCH | `/api/v1/suspension-types[/:id]` | Suspension type admin (settings:EDIT) |
| GET/PATCH | `/api/v1/tenant-config` | Tenant-level config (`requireHoldApproval`, `numberFormats.{agreement,account}`, etc.; settings:EDIT for PATCH) |
| GET | `/api/v1/service-events` | RAMS Events |
| GET/POST | `/api/v1/service-events[/:id]` | RAMS Events |
| POST | `/api/v1/service-events/:id/resolve` | RAMS Events |
| GET | `/api/v1/premises/:premiseId/service-events` | RAMS Events |
| POST | `/api/v1/service-agreements/:id/transfer` | Workflows (transfer of service) |
| POST | `/api/v1/workflows/move-in` | Workflows (coordinated customer + account + agreement) |
| POST | `/api/v1/workflows/move-out` | Workflows (atomic finalize + final reads) |
| GET | `/api/v1/search` | Full-text search across customers/premises/accounts/meters |

### 5.3 Cross-Cutting Patterns

**Pagination:** `?page=1&limit=25&sort=createdAt&order=desc` → `{ data: [...], meta: { total, page, limit, pages } }`. Sort fields are allowlisted per entity; values outside the allowlist fall back to the entity's default sort.

**Errors:** `{ error: { code: "VALIDATION_ERROR", message: "...", details: [...] } }`. Prisma error codes (P2002 unique constraint, P2025 record not found, P2003 foreign key, P2014 relation constraint) are mapped to HTTP status codes and friendly messages by a central error handler.

**Validation:** Zod schemas live in the `@utility-cis/shared` package and are reused by the API (as runtime validators) and by the web (for form validation and TypeScript types via `z.infer`). The same schemas also feed the OpenAPI document generator (5.5), which keeps the machine-readable API contract in lockstep with the runtime contract.

**CRUD factory:** Entities that follow the standard list/get/create/update shape register their routes via `registerCrudRoutes(app, config)` from `packages/api/src/lib/crud-routes.ts`. The factory owns RBAC config, Zod parsing, `request.user` extraction, and status-code shaping; route files just declare their `basePath`, `module`, and service adapter closures. Entities with unusual requirements (premises with its `/geo` endpoint, rate-schedules with `/:id/revise` and no PATCH, roles with DELETE) supply whatever subset fits and add custom routes alongside the factory call.

**Audit events:** Mutating services wrap their create/update operations in `auditCreate` / `auditUpdate` from `packages/api/src/lib/audit-wrap.ts`, which emits a `domain-event` carrying `beforeState` / `afterState` / actor / timestamp. A single writer subscribes and persists to `audit_log`, so no service owns event shaping directly.

**List query schemas:** Every list endpoint's query validator extends the shared `baseListQuerySchema` from `packages/shared/src/lib/base-list-query.ts`, which defines `page` / `limit` / `search` / `sort` / `order` as optional. Routes add their entity-specific filters on top and keep `.strict()` so truly unknown keys still get rejected. The base exists because `SearchableEntitySelect` (and any other picker component) always attaches `limit`/`page`/`search` to its fetch, regardless of whether the target endpoint paginates or searches; a route that defined its own `.strict()` schema without those keys would 400 the picker the moment it mounted. Small reference-table routes (e.g. `/api/v1/suspension-types`) accept and ignore the base keys; larger collection routes honor them for real.

**Background schedulers:** Long-running, time-driven work runs in-process via `setInterval` from `packages/api/src/schedulers/*`. Schedulers register themselves from `buildApp` after the Fastify instance is constructed, gated by the `DISABLE_SCHEDULERS` environment variable so tests and worker processes can opt out of side effects. Currently one scheduler exists — the suspension scheduler — which ticks hourly and flips `PENDING → ACTIVE` and `ACTIVE → COMPLETED` on ServiceSuspensions whose dates have arrived, respecting the per-tenant approval gate (see spec 12). **Single-instance only.** Running two API processes will transition the same hold twice and emit duplicate audit events. When the deployment moves to multi-instance, replace the in-process scheduler with BullMQ + Redis-backed job locking; the transition helper (`transitionSuspensions(utilityId, now)`) is already factored so the scheduler wrapper can be swapped without touching service logic.

**Custom fields:** Tenant-configurable custom fields on extendable entities (Customer, Account, Premise, ServiceAgreement, Meter) are stored in a per-entity `custom_fields` JSONB column and governed by a `custom_field_schema` row per (utility, entity_type) holding a `FieldDefinition[]` array. Each field definition carries both a `type` (data type — drives validation) and an optional `displayType` (widget — drives rendering), letting one data type support multiple input widgets: a `string` field can render as text / textarea / email / url / phone; an `enum` field can render as dropdown or radio group. The admin UI presents a unified "Kind" picker that maps to `(type, displayType)` pairs internally so admins never see the split. Reserved-key collisions with core entity columns are rejected at save time via a per-entity allowlist. The shared `buildZodFromFields` helper dynamically builds a Zod validator from the tenant schema on every write, and the API's `validateCustomFields` service wraps it with merge semantics for partial updates, deprecated-field preservation, and strict rejection of unknown keys. Fields can be deprecated (soft-hide, stored values preserved) or hard-deleted with a two-phase data-safety gate that counts rows holding data for the key and refuses without an explicit `force=true` flag; force mode scrubs the key from every matching row via `UPDATE ... SET custom_fields = custom_fields - $key` atomically. Schema is cached in memory per tenant with a 60-second TTL, invalidated on mutation. See spec 20 for the full design and phase roadmap. **Phases 1 and 2 are now complete**: all five extendable entities (Customer, Account, Premise, ServiceAgreement, Meter) are wired end to end with create-form integration, view-mode display on detail pages, and inline edit support that respects each detail page's local visual conventions via host-style overrides on the shared `<CustomFieldsSection>` component. Phases 3–4 cover datetime data type, searchable expression indexes for list-page filters, and field-level RBAC.

**Identifier generation:** Human-readable identifiers (`account_number`, `agreement_number`) are auto-generated by the backend when the caller omits them on create. The number format is tenant-configurable via a template grammar stored in `tenant_config.settings.numberFormats.{agreement|account}`. Supported tokens: `{YYYY}` (4-digit year), `{YY}` (2-digit year), `{MM}` (2-digit month), `{seq:N}` (sequence zero-padded to N digits), `{seq}` (unpadded). Exactly one sequence token per template is required. The parser lives in `packages/shared/src/lib/number-template.ts` (pure, unit-tested) and is consumed by both the API generator in `packages/api/src/lib/number-generator.ts` and the web settings UI's live preview, guaranteeing identical behavior. The generator substitutes the current date into the template, builds a regex from the literal parts with `\d+` standing in for the seq token, queries the highest existing match for the tenant, takes `max(startAt, existing+1)`, and formats back — retrying the wrapped `create` up to 3 times on P2002 unique-constraint races. Because the regex is rebuilt from the current date on every call, sequence resets are implicit: including `{YYYY}` in the template automatically resets the counter every January 1 (new year prefix → no matching rows → restart from `startAt`); including `{MM}` resets monthly; templates with no date tokens never reset. Format changes are non-destructive — legacy rows keep their old identifiers forever because the new regex simply won't match them, and new rows follow whatever template is current. Defaults used when a tenant has no configuration: `SA-{seq:4}` for agreements, `AC-{seq:5}` for accounts. CSRs can still type a custom identifier on any create form to override the generator; uniqueness is enforced at the DB level regardless.

### 5.4 Business Rules

- **Meter-premise commodity match:** Meter's commodity_id must exist in premise's commodity_ids
- **Meter assignment uniqueness:** A meter can only be in one active agreement per commodity (enforced in $transaction)
- **Status transitions:** ServiceAgreement: PENDING → ACTIVE → FINAL → CLOSED (no skipping)
- **Account closure guard:** Cannot close account with active agreements (enforced in $transaction)
- **Rate versioning:** Creating a new version auto-expires predecessor (in $transaction)
- **Soft delete only:** Status changes to INACTIVE/CLOSED/REMOVED — no hard deletes

### 5.5 Cross-entity Workflows

Phase 2 adds three multi-entity operations that don't fit any single CRUD shape and therefore have their own endpoints. Each wraps its work in a single PostgreSQL transaction so partial state is impossible — every row lands or none do — and each emits a dedicated audit event (`workflow.transfer_service`, `workflow.move_in`, `workflow.move_out`) so the audit log shows the logical operation rather than a fan-out of per-entity updates.

**Transfer of service** (`POST /api/v1/service-agreements/:id/transfer`): reassigns an active service agreement from the source account to a target account as of the transfer date. Flow inside the transaction: optionally record a FINAL meter read on the source's primary meter → mark the source agreement `status=FINAL` with `end_date=transferDate` → create a new agreement on the target account cloning `premise/commodity/rateSchedule/billingCycle/readSequence` with `start_date=transferDate` → copy over the active meter assignments → optionally record an ACTUAL read on the new side. The source account must be different from the target and the source agreement must not already be closed.

**Move-in** (`POST /api/v1/workflows/move-in`): coordinated setup of a new customer (or reference to existing) + account + one-or-more service agreements + optional initial meter reads at a premise. The request body's `existingCustomerId` and `newCustomer` are mutually exclusive — exactly one must be present, enforced by the Zod schema's refine rule. All rows land in a single transaction keyed on `move_in_date`.

**Move-out** (`POST /api/v1/workflows/move-out`): finalizes every active or pending agreement on a given account at a given premise. Flow: look up active agreements → for each meter on each agreement, record a FINAL read if one was supplied and mark the meter assignment removed → transition each agreement to `status=FINAL` with `end_date=moveOutDate` → optionally close the account if no other agreements remain on it. The "close other premises first" guard is checked inside the transaction before the account is closed so it cannot be bypassed by concurrent writes.

### 5.6 Full-text Search

A single `GET /api/v1/search?q=...` endpoint queries the four entity kinds users search by name or identifier: customers (weighted on name → email → phone), premises (weighted on address → city/state/zip), accounts (account number), and meters (meter number). Each table has a Postgres `tsvector` generated column kept in sync by the database itself plus a GIN index, defined in `packages/shared/prisma/migrations/02_fts/migration.sql`. The service layer uses raw parameterized SQL via `$queryRawUnsafe` against those columns — Prisma doesn't need to model the tsvector column for application-layer code to work. Results from all four kinds are merged and sorted by `ts_rank` descending before being capped to the query's limit.

Query terms are split on whitespace, non-word characters are stripped for safety, and each term is converted into a prefix match (`term:*`) before being joined with `&` so "jon mai" finds "jones main street". The web side wires this into a Cmd/Ctrl+K overlay in the topbar with debounced fetches and keyboard navigation through the result list.

### 5.7 OpenAPI Contract

The API exposes a machine-readable OpenAPI 3.1 document at `GET /api/v1/openapi.json` (unauthenticated). The document is generated at request time from the Zod validators in `@utility-cis/shared` via `zod-to-json-schema`; no hand-written schema files exist, which means the contract cannot drift from runtime validation. The generator lives in `packages/api/src/lib/openapi.ts` and registers:

- **Component schemas** — every `create*Schema`, `update*Schema`, and `*QuerySchema` for the major entities (32 schemas total).
- **Paths** — every endpoint with its method, tags, security scheme (`bearerAuth`), request body and query parameter `$ref`s, standard error responses (400/401/403/404), and the correct success status (200 on read/update, 201 on create, 204 on delete).
- **Paginated envelope shape** — list endpoints declare the `{ data: [...], meta: { total, page, limit, pages } }` wrapper so clients can generate correct response types.

Clients can pull the document and generate SDKs, contract tests, or API consoles. The structural test suite at `packages/api/src/__tests__/openapi.test.ts` enforces that the document stays well-formed: required paths and methods are present, every `$ref` resolves to a defined component, paginated envelopes are declared on list endpoints, creates return 201, and `:id` path parameters are `uuid` format.

---

## 6. Admin UI

### 6.1 Layout

- Collapsible sidebar with Font Awesome Pro icons (Operations / Configuration / System sections)
- Top bar with breadcrumbs, global search, theme toggle
- Navigation progress bar on link clicks

### 6.2 Pages

| Page | Path | Features |
|------|------|----------|
| Customers | `/customers` | Search with debounce, stat cards, type/status filters, Create Customer |
| Customer Detail | `/customers/:id` | Command center: hero header, 5 tabs (Overview, Accounts, Premises, Contacts, Attachments); inline editing; Deactivate button; Add Account inline form on Accounts tab; Upload button in tab bar |
| Premises | `/premises` | Table + map toggle, stats bar, type/status filters, owner filter (SearchableSelect), owner column |
| Premises Map | `/premises` (map view) | Mapbox GL JS, Supercluster, popups with commodity badges (not UUIDs), type filters; stats reflect active filters |
| Premise Detail | `/premises/:id` | Tabs: Overview, Meters, Agreements, Attachments; inline editing (including commodity toggle buttons); Deactivate button; Add Meter inline form (Meters tab); Add Agreement inline form (Agreements tab); Upload button in tab bar |
| Meters | `/meters` | Table with commodity/status filters |
| Meter Detail | `/meters/:id` | Tabs: Overview, Agreements, Attachments; inline editing (install date, UOM, removal date via DatePicker); Remove Meter button; Upload button in tab bar |
| Accounts | `/accounts` | Table with search, type/status filters |
| Account Detail | `/accounts/:id` | Tabs: Overview, Agreements, Contacts, Billing Addresses, Attachments; inline editing; Close Account button (BR-AC-004 guard); Add/edit/delete contacts inline; Add/edit billing addresses inline; Upload button in tab bar |
| Agreements | `/service-agreements` | Table with status filters |
| Agreement Detail | `/service-agreements/:id` | Tabs: Overview, Meters, Audit, Attachments; inline editing on overview; Activate/Close status transition buttons (PENDING→ACTIVE→FINAL→CLOSED, no INACTIVE); Add/remove meter assignments on Meters tab; Upload button in tab bar |
| Rate Schedules | `/rate-schedules` | Table with commodity/type/active filters |
| Rate Schedule Detail | `/rate-schedules/:id` | Tabs: Overview, Version History, Revise action; contextual tooltips referencing BR-RS rules |
| Rate Schedule Create | `/rate-schedules/new` | Dynamic form: tier builder for TIERED, JSON for TOU/DEMAND; HelpTooltip on all fields |
| Billing Cycles | `/billing-cycles` | Table |
| Billing Cycle Detail | `/billing-cycles/:id` | Overview; inline editing; Deactivate button |
| Commodities & UOM | `/commodities` | Inline edit, UOM table per commodity |
| Audit Log | `/audit-log` | Searchable by entity type, action, actor, date range |
| Theme Editor | `/theme` | Presets, color pickers, typography, live preview |
| Settings | `/settings` | Placeholder |

### 6.3 Shared UI Components (Phase 2)

| Component | Purpose |
|-----------|---------|
| `EntityListPage` | Declarative list-page shell (title, subject, module, endpoint, columns, filters, search, newAction, headerSlot). Owns state, fetching, debounce, page-reset on filter change, and permission gating. Used by customers, accounts, meters, service-agreements, rate-schedules, billing-cycles. |
| `SearchableEntitySelect<T>` | Async-debounced entity picker for large list endpoints. Fetches from `endpoint?search=<query>` on open and on every debounced keystroke (default 200ms), keeps a client-side cache of known labels + rows so the trigger can render selected values without a second GET, exposes the full row back to the parent via `onChange(value, row?)` so callers can drive context panels (meter UOM, customer info, etc.) without re-fetching. Dynamic-options fields on `EntityFormPage` delegate to this component automatically, so every `/new` form that picks a premise, customer, meter, account, or agreement now has server-side search without per-form changes. Used directly in `/meter-reads/new` (premise + meter cascade), `/workflows/move-in` (premise + customer), `/workflows/move-out` (account), `/workflows/transfer` (source agreement + target account). |
| `usePaginatedList` | Data hook behind EntityListPage: owns data/meta/loading/page state, handles both paginated envelopes and plain-array endpoints, drops undefined query params, guards against setState after unmount. |
| `SearchableSelect` | Dropdown with live search for customer/owner selection; used on Premise create/edit and Customer detail |
| `DatePicker` | Calendar picker for date fields (install date, start date, etc.) |
| `HelpTooltip` | Inline icon button that displays business rule references in a popover |
| `StatusBadge` / `CommodityBadge` / `TypeBadge` | Theme-aware badges driven by semantic CSS variables (`--success`, `--warning`, `--danger`, `--info`) so they automatically re-tone between light and dark modes. |
| `ConfirmDialog` | Accessible confirmation modal (role=dialog, aria-modal, ESC, focus trap, return focus) for destructive actions. |
| `FormField` | Injects `aria-invalid` / `aria-describedby` via `cloneElement` so error messages are announced by assistive tech. |
| Navigation progress bar | Thin loading bar at top of page on all route transitions |

### 6.4 Theme System

- 4 built-in presets (Midnight/Daybreak, Dusk/Dawn, Forest/Meadow)
- Dark/light toggle via CSS custom properties on `data-theme` attribute
- Persistence: user preference (DB) → tenant default → system prefers-color-scheme
- Mapbox adapts between dark-v11 and light-v11

---

## 7. Security

- **JWT verification:** Signatures verified with jose + NEXTAUTH_SECRET
- **SQL injection:** UUID validation before any raw SQL interpolation
- **RLS:** PostgreSQL Row-Level Security on all 21 entity tables
- **Defense in depth:** All GET-by-ID queries include utility_id in WHERE clause
- **Race conditions:** $transaction for account closure guard and meter uniqueness
- **PII:** SSN/payment card data never stored in CIS (SaaSLogic handles payments)
- **Audit trail:** All modifications logged with actor, timestamp, before/after state

---

## 8. Phase Roadmap

### Phase 1 (Complete)
Core foundation: 17 entities, 29 API endpoints, admin UI with map view and theme editor, 68 tests.

### Phase 2 (In Progress)
Enhanced CIS + UI: Customer CRUD API (4 endpoints), Contact CRUD API (4 endpoints), BillingAddress CRUD API (3 endpoints), Agreement meter assignment endpoints (2 endpoints), Attachment CRUD (4 endpoints), UOM delete endpoint (1 endpoint) — total 48 endpoints live. Customer list/detail UI with command center, inline editing on all detail pages (Premise, Customer, Account, Meter, Agreement, BillingCycle), Deactivate/Close/Remove buttons with confirmation dialogs, Add Meter/Agreement inline forms on Premise detail, Add Contact/BillingAddress tabs on Account detail, Add Account inline form on Customer detail, Add/remove meter assignments on Agreement detail, SearchableSelect + DatePicker + HelpTooltip components, navigation progress bar, contextual business rule tooltips on all create forms, owner filter on Premise list, commodity badges on map popups. Attachment tab added to all 5 detail pages (Premise, Customer, Account, Meter, ServiceAgreement) with Upload button in tab bar. Commodity editing on Premise inline edit (toggle buttons). Meter detail: install date, UOM, removal date now editable with DatePicker. UOM inline edit + delete with confirmation (BR-UO-005/BR-UO-006 guard). BR-UO-003 auto-enforcement (setting isBaseUnit=true unmarks existing base unit). Conversion factor label shows base unit dynamically. Agreement status transitions corrected: PENDING→ACTIVE→FINAL→CLOSED (no INACTIVE). Modern thin scrollbars. PageHeader supports onClick action. HelpTooltip uses styled popup (not native title).

RBAC (complete): CisUser, Role, TenantModule entities added (+3 entities, now 21 total). Authorization middleware with Redis caching (user role 5min TTL, tenant modules 10min TTL). GET /api/v1/auth/me endpoint. User CRUD (4 endpoints) and Role CRUD (5 endpoints) under settings:VIEW/CREATE/EDIT/DELETE permissions. Tenant modules list endpoint. Frontend AuthContext + usePermission hook + ModuleContext. Sidebar permission filtering. Route permission declarations on all /api/v1/* routes. UI button permission gating across all pages. Settings page with Users tab and Roles tab (permissions matrix).

Structural review + hardening (complete): End-to-end adversarial review across security, data model, API contract, UI/a11y, modularity, and testability. Security hardening (parameterized `set_config`, dev-endpoint gating, tenant-scoped RBAC cache, attachment path and MIME hardening, `@fastify/helmet`); data-model tightening (onDelete on every FK, 20+ new FK indexes, MeterRead freeze/correction fields, rate schedule date index, CHECK constraints for non-negative numerics, date ordering, day-of-month bounds, email and language-tag format, non-empty identifiers); API contract (Prisma error code mapping, sort allowlisting, strict create/query schemas, shared `idParamSchema`, machine-readable OpenAPI 3.1 document at `/api/v1/openapi.json` generated from Zod); UI/WCAG (error boundaries, WCAG AA `StatusBadge`, accessible `ConfirmDialog`, `FormField` aria injection, `SearchableSelect` ARIA combobox, `DataTable` scope + keyboard nav, skip-to-main-content, theme-aware semantic badges). Modularity: `auditWrap` helper applied to 10 services, `paginatedTenantList` to 6, `registerCrudRoutes` factory to 8 route files, `EntityListPage` + `usePaginatedList` shell adopted by 6 list pages, badge consolidation, `@fastify/helmet`. Latent middleware bug fixed: `skipAuth` route config is now honored by both auth and tenant middlewares. Test count grew from 32 to **184** (47 shared + 121 api + 16 web) across 20 files; web package now has a full vitest + React Testing Library + jsdom setup wired into `pnpm verify`. Total: 60 endpoints live (+1 `/api/v1/openapi.json`).

Phase 2 operations work landed (2026-04-10): MeterRead CRUD API with consumption + rollover + reverse-flow detection, correction chain (CORRECTED rows preserve originals via `corrects_read_id`), exception queue endpoint + UI, import center UI (three-stage wizard). MeterEvent entity + CRUD for LEAK/TAMPER/BURST_PIPE/FREEZE/REVERSE_FLOW/HIGH_USAGE/BATTERY_LOW/NO_SIGNAL/COVER_OPEN/OTHER with severity + resolution. Solid waste: Container + ServiceSuspension + ServiceEvent entities with CRUD, atomic container swap transaction, RAMS event receiver with idempotency on `rams_event_id`, per-premise/agreement detail tabs. Cross-entity workflows: transfer of service (atomic close-source + open-target), move-in (coordinated customer + account + agreements + initial reads), move-out (finalize all agreements at a premise + final reads + optional account close). Full-text search via Postgres tsvector generated columns + GIN indexes on customer/premise/account/meter, exposed as `GET /api/v1/search` and wired to a Cmd/Ctrl+K topbar overlay. Nine new modules added to the RBAC module list (meter_reads, meter_events, containers, service_suspensions, service_events, workflows, search) with preset-role permission matrices updated for CSR / Field Tech / Read-Only. Sidebar extended with Operations and Solid Waste sections. Total: ~85 endpoints live.

Meter-read UX hardening (follow-up pass): the read-entry form rebuilt with a premise → meter cascade using `SearchableEntitySelect` so the meter dropdown no longer tries to preload thousands of rows. Service-agreement auto-resolution: `createMeterReadSchema.serviceAgreementId` is now optional, and the service resolves the owning agreement from `ServiceAgreementMeter` on meter+date, erroring early with `METER_NOT_ASSIGNED` if no active assignment exists so operators cannot record a read against a closed customer. The read-entry form fires parallel `GET /api/v1/meters/:id` + last-read fetches on meter selection and renders an immediate context card showing meter number, commodity, UOM code + name, active agreement, multiplier formula, and the last reading value + date; if the meter has no active assignment the context card is replaced by a red warning banner and every downstream form field is disabled. The reading input's label shows the UOM code so operators know what units they're entering. A full meter-read detail page at `/meter-reads/:id` shows the consumption calculation breakdown and context cards, plus header buttons for Correct (inline form → PATCH, creates a CORRECTED row) and Delete (`ConfirmDialog` → new `DELETE /api/v1/meter-reads/:id` endpoint with frozen + correction-chain guards). The async picker pattern is exposed in `SearchableEntitySelect<T>` and automatically inherited by every `EntityFormPage` dynamic-options field, so all `/new` forms benefit without per-form changes; the three hand-rolled workflow wizards (move-in, move-out, transfer) were also updated to use it directly. `GET /api/v1/meters` and `GET /api/v1/service-agreements` both gained a `search` query parameter for case-insensitive substring matching on the identifier field, backing the async picker. Several latent dev-bootstrap bugs were fixed along the way: the API's `.env` is now loaded via `tsx --env-file` and `node --env-file`, the auth middleware peeks at the JWT `alg` header so unsigned dev tokens work regardless of whether `NEXTAUTH_SECRET` is set, the `auth-context` fallback module list now imports `MODULES` from shared instead of hardcoding its own twelve-entry list (closing the third of three places where the module list had drifted), the seed script's `allModules` list was expanded to cover the new Phase 2 modules, and `packages/api/run.bat` now flushes Redis + explicitly sets every env var the API reads so stale shell env can't leak into the process. The `MODULES` constant in `@utility-cis/shared` is now the canonical source for both the seed and the web fallback.

Still planned for Phase 2: GIS integration (deferred to Phase 3 as it depends on the map-tile integration and a service territory entity).

### Phase 3
Billing engine + notifications + delinquency: Rate engine calculations (including WQA), billing cycle execution, SaaSLogic integration, bill document generation, late fees, payment plans, delinquency management, notification engine.

### Phase 4
Customer portal + service requests: Self-service portal, service request lifecycle, ApptorFlow workflows.

### Phase 5
Special assessments: Assessment districts, parcel-based assessments, installment billing.

---

## 9. External Requirements

See `docs/superpowers/specs/2026-04-08-bozeman-rfp-gap-analysis.md` for mapping of 202 City of Bozeman functional requirements to phases.
