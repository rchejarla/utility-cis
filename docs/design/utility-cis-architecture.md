# Utility CIS — System Architecture & Design

**Last updated:** 2026-04-11
**Status:** Phase 1 complete, Phase 2 complete, Phase 3 in progress

---

## 1. Overview

The Utility CIS (Customer Information System) is a multi-tenant SaaS platform for small-to-mid-market utilities (5,000–100,000 accounts). It manages the utility domain — customers, premises, meters, accounts, service agreements, rate schedules, rating and billing — using SaaSLogic as a payment rail and ApptorFlow for workflow orchestration.

### Key Principle

**CIS calculates and owns everything it bills. SaaSLogic only collects the amount.** CIS rates usage, applies taxes, produces the bill, and owns the receivable. SaaSLogic is told an amount and reports whether it was collected.

> **Revised 2026-10-09.** This replaces the earlier principle — *"CIS owns the utility domain, SaaSLogic owns the money,"* with a structured billing instruction as the handoff, described as non-negotiable. Rate Model v2 built native rating, bill segments and account-level bills in CIS, so the earlier split no longer described the system. See `docs/specs/21-saaslogic-billing.md`.

### Service Boundaries

| Service | Owns | Integrates With |
|---------|------|-----------------|
| **Utility CIS** | Customers, premises, meters, accounts, service agreements, rate schedules, meter reads, **rating, bill segments, bills, taxes, and the receivable** | SaaSLogic (payment collection), ApptorFlow (workflows) |
| **SaaSLogic** | Card data, hosted payment page, settlement | CIS (registers an amount due, receives the payment result) |
| **ApptorFlow** | Workflow orchestration: start/stop service, collections, anomaly response, approvals | CIS (events), SaaSLogic (payment events) |

**Built in Phase 3 AR slice 1:** an issued `Bill` posts a signed `LedgerEntry`, and `Account.balance` is recomputed from the ledger in the same transaction, so the receivable CIS owns now exists in code. **Not yet built:** payments, allocation and write-offs. See module 23.

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

Every entity is scoped by `utility_id`, and tenant isolation **is** enforced at the database level by the PostgreSQL Row-Level Security policies below, which every migration creates. It was not until 2026-10-24: the application role was a superuser *and* owned the tables, and PostgreSQL exempts both independently, so the policies were inert and the `utility_id` predicates in application code were the whole of the separation. Those predicates remain, now as the second line rather than the only one. What makes the policies bite — and what would undo it — is §7.1.

```sql
ALTER TABLE premise ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON premise
  USING (utility_id = current_setting('app.current_utility_id')::uuid);
```

The API validates utility_id as UUID format before interpolation (SQL injection prevention) and sets RLS context per-request.

#### There was no tenant table

*The three paragraphs below describe the state until 2026-10-18 and are
kept because the costs they name explain the design above them. What
replaced it follows, under "A `Utility` root now exists".*

`utility_id` was a foreign key to nothing. No `utility` or `tenant` table existed — not as a Prisma model and not in raw SQL — and no migration declared an FK against one. Verified 2026-10-11.

The tenant is a **JWT claim**. It arrives as `request.user.utilityId` (dev login defaults it to `00000000-0000-4000-8000-000000000001`), is pushed into `app.current_utility_id`, and RLS reads it from there. `CisUser.externalId` shows users mirror an external identity provider, so *which tenants exist* is owned outside this database and the claim is trusted on arrival.

The three satellite models — `UtilityConfig`, `UtilityTheme`, `UtilityModule` — are keyed by `utility_id`. (`UtilitySetting` was listed here until 2026-10-31 and did not belong: it is the rate engine's variable store, renamed `UtilityVariable`. The name had it filed among the tenant-config tables by this very sentence.) They were named `Tenant*` until 2026-10-18; "tenant" now names only the isolation mechanism (`withTenant()`, `tenantMiddleware`, `app.current_utility_id`, the `tenant_isolation` policies), while the entity itself is a Utility.

**A `Utility` root now exists** (2026-10-18, build-order step 2 of
`docs/superpowers/specs/2026-10-17-tenancy-and-platform-admin-design.md`). It carries id, display
name, status (`ACTIVE | SUSPENDED`) and created-at, and `utility_id` is a foreign key to it on all
61 tables that carry one, `ON DELETE RESTRICT`. Seven of those are nullable — the global reference
rows of §1.3, which belong to no tenant.

Two of the three costs below are therefore closed:

- ~~**A `utility_id` cannot be validated.**~~ Closed. A write naming a utility that does not exist is
  refused by the database with a foreign-key violation rather than silently opening an empty
  partition.
- ~~**Tenants cannot be enumerated or deactivated.**~~ Closed. They are listed at
  `GET /api/v1/platform/utilities`, and `status` is **read on every request** — the authorization
  pass refuses a suspended tenant with `UTILITY_SUSPENDED` before it looks at the module, so a token
  minted before the suspension stops working rather than running out its lifetime. Suspension
  deletes nothing; purge is a separate, deferred capability.
- **No cross-tenant integrity guarantee.** Still open, and unchanged by the root: the foreign key
  proved each row's tenant exists, not that two rows in a relationship shared one. **Closed on
  2026-10-25** by putting the tenant in the key: every foreign key between two tenant-scoped
  tables is now `(utility_id, <fk>) -> parent (utility_id, id)`, so a child in one tenant cannot
  reference a parent in another. See §7.1.

Why it went unfixed for so long: a local `Utility` row largely mirrors provider-owned data, and a mirror is a second copy free to disagree with its source. That decision — whether the identity provider, this database, or both with a defined direction own tenancy — was settled on 2026-10-18 as Q2 of the tenancy note: apptorID eventually, for every identity rather than this one, and until then the CIS holds the row.

Note the distinction that keeps this from blocking work. The provider owns a tenant's *existence and id*; it has no opinion on a tenant's *operational facts* — remittance address, billing phone, bill messages. Those are CIS-owned and live in `UtilityConfig.settings` namespaces (see `docs/superpowers/specs/2026-10-11-bill-production-design.md`). With the `Utility` root now in place, moving identity onto it stayed the contained change this predicted: one model, one foreign key per table, and no migration of scattered columns.

### 3.4 Integration Contract: CIS ↔ SaaSLogic

**Amount due (CIS → SaaSLogic):** when a `Bill` is issued, CIS registers its total with SaaSLogic so the customer has something payable, keyed on the Bill for idempotency. No usage, no rate configuration and no line detail is sent for pricing — CIS has already priced it.

**Payment result (SaaSLogic → CIS):** when a payment settles, CIS learns of it (webhook if available, polling otherwise) and posts it against the account's balance.

This replaces the earlier "structured billing instruction per service agreement" contract, which assumed SaaSLogic did the rating. Note that payments may also arrive by cash, check or lockbox and never touch SaaSLogic, which is why the ledger is CIS's.

**Both directions ride apptor-connect** (§3.6, decided 2026-10-21): the amount goes out over the `proxy` plane, the result comes back over the `events` plane. CIS holds no SaaSLogic credential.

### 3.5 Event Bus: CIS ↔ ApptorFlow

Every significant CIS state change emits a domain event. ApptorFlow subscribes and triggers workflows. Phase 1 uses internal EventEmitter.

**Two caveats on this section, both unresolved.** The original "Phase 3+ will use Kafka or RabbitMQ" now sits against §3.6, which already has a `kafka` connector and an `events` plane — so the transport question is whether ApptorFlow is reached over the rail like every other external consumer, and no one has decided that. And the in-process EventEmitter is the example CLAUDE.md names as real over-engineering in this codebase: the audit pipeline built on it costs an extra transaction per audit and breaks atomicity. Before this is extended to a second consumer, the direct version — write the row in the same transaction — is the thing to beat.

### 3.6 Integration rail: apptor-connect

**Everything that leaves this process goes through apptor-connect** (`c:\development\apptor-connect`, HTTP surface `apptor-connect-service`, configured by `APPTOR_CONNECT_URL` + `APPTOR_CONNECT_API_KEY`). Email, SMS, postal mail, object storage, GIS, meter-reading systems, work-order systems and payment collection all arrive here rather than as vendor clients of their own.

| Plane | Endpoint | What it gives us |
|---|---|---|
| `proxy` | `POST /proxy/v1/{integration}` | Call a vendor without holding its credential; auth injected, timeouts, retries and per-tenant rate limits applied. |
| `files` | `/files/v1/*` | S3, Azure Blob, GCS, SFTP. Mint a link, stream the bytes, keep a pointer. |
| `events` | `POST /events/v1/{token}` | Verified, deduplicated inbound webhooks, read by cursor. |
| `resolve` | `POST /v1/resolve` | Connection details plus a short-lived token, for a caller that must reach a vendor directly. |

Ownership is `PLATFORM ⊃ TENANT ⊃ CUSTOMER ⊃ SUBJECT`, which maps onto `utility_id`. The `mail`, `sendgrid`, `s3`, `azure-blob`, `gcs`, `sftp`, `rest` and `kafka` connectors exist.

**The constraint: no vendor credential belongs in this codebase** — not in `.env`, not in `UtilityConfig.settings`, not in an encrypted-secrets table. A tenant-level integration setting names which integration to use and carries no key, bucket, region or base URL. Bill production is the worked example and the shape to copy: `packages/api/src/lib/apptor-connect/files-client.ts` is the only module that talks to the files plane, every failure maps to a 502 naming the integration, and the minted link is consumed internally and never persisted, because a capability URL is a bearer credential that needs no login.

What this buys is narrower than it looks. The mechanism is chosen and running, so the outstanding integrations are integration work rather than infrastructure work — cheaper to estimate, not closer to done. Our half of each still has to be written, and several need a third party's file format or API before they can be specified at all. The per-requirement mapping is in `docs/bozeman/17-implementation-gap-analysis.md` §2.

---

## 4. Data Model

### 4.1 Entity Summary

**37 core domain entities** across 13 categories (a curated summary, not the full schema: the Prisma schema defines 62 models, and type-def, plumbing and later-phase models such as `Bill`, `BillDocument`, `BillMessage`, `BillingRun`, `BillingRunItem` and `ServicePoint` are not listed here):

| Category | Entities |
|----------|----------|
| **Customer** | Customer, Contact, BillingAddress |
| **Reference** | Commodity, UnitOfMeasure |
| **Core** | Premise, Meter, MeterRegister, Account |
| **Agreement** | ServiceAgreement, ServiceAgreementMeter (junction) |
| **Configuration** | RateSchedule, BillingCycle |
| **Operations** | MeterRead (TimescaleDB hypertable, composite PK on `(id, read_datetime)`), MeterEvent, ImportBatch, Attachment |
| **Solid Waste** | Container, ServiceSuspension, ServiceEvent |
| **System** | Utility (the tenant root), AuditLog, UtilityTheme, UserPreference |
| **RBAC** | CisUser, Role, UtilityModule |
| **Notifications** | NotificationTemplate, Notification |
| **Delinquency** | DelinquencyRule, DelinquencyAction |
| **Service Requests** | ServiceRequest, Sla, ServiceRequestTypeDef (+ `service_request_counter` plumbing table for per-tenant/year `SR-YYYY-NNNNNN` numbering) |
| **Accounts Receivable** | LedgerEntry, LedgerApplication, LedgerReasonDef |

**Service Request enums (Phase 4 slice B):**
- `ServiceRequestStatus`: NEW, ASSIGNED, IN_PROGRESS, PENDING_FIELD, COMPLETED, CANCELLED, FAILED
- `ServiceRequestPriority`: EMERGENCY, HIGH, NORMAL, LOW
- `ServiceRequestSource`: CSR, PORTAL, API, SYSTEM, DELINQUENCY_WORKFLOW (only CSR wired in slice B)
- `ServiceRequestExternalSystem`: RAMS, WORK_MANAGEMENT, APPTORFLOW (column reserved; routing deferred)
- `ServiceRequestBillingAction`: FEE_APPLIED, CREDIT_APPLIED, NO_ACTION (column reserved; Module 10 integration deferred)

### 4.2 Entity Relationship Diagram

```
Customer ──────┬──→ Account ──────→ ServiceAgreement ──→ ServiceAgreementMeter ──→ Meter
(person/org)   │   (billing)       (the core unit)      (junction, 1 or many)     (device)
               │       │                  │                                          │
               ├──→ CisUser (portal)      │                                          │
               │   (customerId FK)        │                                          │
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
| read_day_of_month | INTEGER | 1-28 (Zod), NOT NULL; the day reads are expected complete by. Added 2026-10-15 — the column had been described here since Phase 1 without existing |
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
| read_event_id | UUID | Nullable: groups sibling reads from one multi-register read event (Phase 2.5) |
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

**Multi-register reads (Phase 2.5).** Meters with multiple registers (e.g., a demand+usage commercial meter) produce **one `MeterRead` row per active register per read event**, all sharing one `read_event_id`, one `read_datetime`, and one reader, but distinct `register_id`, `uom_id`, and consumption values. Single-register meters keep writing a single row with `read_event_id = NULL` — no backfill. See `docs/specs/08-meter-reading.md` for the full data-model, API, UI, import, and billing rules.

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

### 4.18 UtilityTheme

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

### 4.21 UtilityConfig

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

**Where a tenant setting goes** (settled 2026-10-31): a value every
utility has is a column; a value only some have goes in `settings` jsonb.
Where that is arguable, the tiebreaker is mechanical — a column if it is
filtered on in SQL, jsonb if it is only read off a row already in hand.
jsonb costs filtering and types, never reading.

Per-scheduler settings used to live here as three repeated groups of the
same columns, one group per background job. They are rows in
`SchedulerConfig` now; see §4.21a.

### 4.21a SchedulerConfig

What a tenant may configure about **one** background job. One row per
(utility, scheduler).

A one-to-many that had been modelled as repeated column groups on
`UtilityConfig`: an enable flag, a run hour and a last-run timestamp, once
per job. Adding billing's group cost a migration and seven files, which is
the tax a repeated column group charges. Adding a scheduler is now a row.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | FK → `utility(id)` RESTRICT |
| scheduler_key | VARCHAR(50) | A `SchedulerKey` from `validators/automation-config.ts` |
| enabled | BOOLEAN | Default true. A missing row means the scheduler's declared default |
| run_hour_local | SMALLINT | Null where the job has no time of day |
| last_run_at | TIMESTAMPTZ | Written by a dispatcher; tells a missed tick from one not yet due |
| settings | JSONB | Knobs only this job needs — no migration to add one |

**Unique:** [utility_id, scheduler_key]
**RLS:** standard one-argument policy. With no tenant set it raises rather
than returning nothing, because "no rows" would read as "nothing is
enabled" and a dispatcher that believes that bills nobody and reports
success.

**Keys are code; values are configuration.** Each key names a handler that
must exist, so the set lives in `SCHEDULER_DEFINITIONS` — one entry per
job with its label, help text, whether it has a run hour, and its default.
The settings page renders from that list, so a scheduler added there gets
its controls without the page being touched. A row whose key no build
recognises is inert.

**No `cron_pattern` column**, deliberately. Every scheduler has a cadence
so the storage rule would admit one, but three of the five patterns
resolve a tenant-facing hour and a slower cadence makes that hour silently
unreachable — no job, no error. Cadence stays in code until spec 24's
signed command path exists; see `docs/specs/27-job-scheduling.md` §4.

**A missing row means the declared default**, which has three
consequences worth knowing before touching this table:

- A scheduler added in code appears for every existing tenant with no
  backfill; its row materialises on the first save.
- Therefore **anything added from now on must default to disabled** — a
  new job defaulting to on would start work for every tenant the day it
  shipped. The three defaulting to true predate the table.
- A cross-tenant read cannot filter on rows alone. `tenantsForScheduler`
  reads tenants and rows and joins in memory, because filtering would skip
  every tenant who has never changed a setting — for delinquency, all of
  them.

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

### 4.23 Utility

The tenant itself, as a row (2026-10-18). `utility_id` on all 61 tables that carry one is a foreign key to this, `ON DELETE RESTRICT` — so a write naming a tenant that does not exist is refused by the database rather than silently opening an empty partition. Seven tables' `utility_id` is nullable, for the global reference rows that belong to no tenant (§1.3 of the tenancy note), plus `cis_user`, where a null means the platform actor.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK. The value every other table's `utility_id` points at; dev tenant is `00000000-0000-4000-8000-000000000001` |
| name | VARCHAR(255) | Display name. **No unique index** — uniqueness is enforced case-insensitively in `provisioning.service.ts` (`UTILITY_NAME_TAKEN`, 409), because it is a provisioning rule with an explanation attached rather than a storage invariant |
| status | UtilityStatus | `ACTIVE \| SUSPENDED`. Read on **every** request by the authorization pass, before the module check |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**RLS:** non-standard, because the predicate is on the primary key rather than on a `utility_id` column: `id = current_setting('app.current_utility_id')::uuid`. A tenant can see its own row and no other.

**Written by** `provisionTenant` (`scripts/provision-tenant.ts`, `POST /api/v1/platform/utilities`), which also creates all 32 `UtilityModule` rows, the six preset roles and optionally a first admin — in one transaction, idempotent on the **id**, with a dry-run mode that meets the same constraints and rolls back. Suspension and reactivation are the platform actor's (spec 25); there is no delete.

### 4.24 Database Invariants (CHECK constraints)

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

### 5.2 Endpoints (curated subset)

> This table has not kept pace with the API and is a subset, not an inventory — the AR, bills, receipts and disbursements routes from module 23 are absent, among others. The route files currently register 211 explicit handlers plus 13 `registerCrudRoutes` calls. Treat `GET /api/v1/openapi.json` as the authoritative list.

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
| POST | `/api/v1/auth/dev-login` | Unified dev login for admin and portal (non-prod, skipAuth) |
| POST | `/portal/api/auth/register` | Portal self-registration (account number + email → CisUser + JWT) |
| POST | `/portal/api/auth/login` | Portal login (email → JWT with customer_id claim) |
| GET | `/portal/api/dashboard` | Portal dashboard (customer + accounts + agreements, each account's `balance`, and `amountDue` summed across them) |
| GET | `/portal/api/accounts` | Portal account list (customer-scoped) |
| GET | `/portal/api/accounts/:accountId` | Portal account detail with agreements, meters, premises |
| GET | `/portal/api/accounts/:accountId/bills` | The account's **posted** bills, with settlement fields; 404 if the account is not the caller's |
| GET | `/portal/api/agreements/:id/usage` | Portal usage data (meter reads, from/to date range, customer-scoped) |
| GET | `/portal/api/profile` | Portal customer profile (read) |
| PATCH | `/portal/api/profile` | Portal customer profile (edit email, phone, altPhone) |
| GET/POST/PATCH/DELETE | `/api/v1/notification-templates[/:id]` | Notification Templates CRUD |
| GET/POST | `/api/v1/notifications[/:id]` | Notification list + send |
| GET/POST/PATCH/DELETE | `/api/v1/delinquency-rules[/:id]` | Delinquency Rules CRUD |
| GET/POST | `/api/v1/delinquency-actions[/:id]` | Delinquency Actions list + create |
| GET/POST/PATCH/DELETE | `/api/v1/bill-messages[/:id]` | Bill Messages CRUD (`settings` module — bill text is tenant configuration) |
| POST | `/api/v1/bills/:id/document` | Bill Documents (render + store, idempotent; `?force=true` replaces; `accounts:EDIT`) |
| GET | `/api/v1/bills/:id/document` | Bill Documents (stream the PDF; `accounts:VIEW`) |
| GET | `/portal/api/bills/:id/document` | Bill Documents (customer's own copy; `portal_billing:VIEW`) |
| POST | `/api/v1/billing-runs` | Start a billing run (202 + the PENDING run; `accounts:EDIT`) |
| GET | `/api/v1/billing-runs[/:id]` | Billing run list + detail (`accounts:VIEW`) |
| GET | `/api/v1/billing-runs/:id/items` | Per-account results; `?status=FAILED` is the exception list (`accounts:VIEW`) |
| POST | `/api/v1/billing-runs/:id/post` | Post every bill the run produced (`accounts:EDIT`) |
| POST | `/api/v1/billing-runs/:id/cancel` | Ask a run to stop after the account it is on (`accounts:EDIT`) |

#### Platform routes

Twenty-one routes under `/api/v1/platform/*`, declared
`{ config: { platform: true } }` rather than with a module and a
permission. They are gated on the **platform actor** — a `CisUser` with a
null `utility_id` — and a tenant's System Admin is refused on all of
them. None takes a `utility_id` from the token; the ones that act on a
tenant name it in the path. Full inventory and rationale: spec 25.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/platform/me` | The operator, read from the row rather than the token's claims |
| GET | `/api/v1/platform/utilities` | Every tenant, with module / role / user counts |
| GET | `/api/v1/platform/utilities/:id` | One tenant's modules, roles, staff and readiness |
| POST | `/api/v1/platform/utilities` | Provision (201); `dryRun: true` → 200 and nothing written |
| POST | `/api/v1/platform/utilities/:id/suspend` \| `/reactivate` | `Utility.status`, enforced per request |
| GET | `/api/v1/platform/utilities/:id/history` | What was done to this tenant from outside it |
| PATCH | `/api/v1/platform/utilities/:id/modules/:moduleKey` | `{ isEnabled }` — the end state, not a toggle verb |
| GET/POST/PATCH/DELETE | `/api/v1/platform/utilities/:id/roles[/:roleId]` | A tenant's roles, from above it; same `role.service` as `/api/v1/roles` |
| GET/POST | `/api/v1/platform/users` | The platform's own operators |
| POST | `/api/v1/platform/users/:id/deactivate` \| `/reactivate` | `is_active`; the row stays |
| GET | `/api/v1/platform/queues` | The whole cluster in one call: counts, DLQ, failures, attachment, nodes, workers. **200 even when Redis did not answer** — `reachable: false` in the body, because a 503 reads on screen like "nothing is queued" |
| GET | `/api/v1/platform/queues/:name/jobs` | Jobs in one queue and one state; `name` may be the sentinel `all` |
| POST | `/api/v1/platform/queues/:name/jobs/:id/:action` | `retry` \| `promote` \| `replay` — a closed set; `pause`/`drain`/`clean` are decisions about a queue, not a job |
| POST | `/api/v1/platform/workers/start` | Spawn a worker process on this node (`WORKER_CONTROL_ENABLED`) |
| POST | `/api/v1/platform/workers/:id/stop` | Ask that worker to drain, by its own id |

`/admin/queues` (Bull Board, off unless `BULL_BOARD_ENABLED`) is gated on the same platform actor. It used to require `tenant_profile:EDIT` — a tenant permission over queues that are not tenant-scoped, which let one tenant's admin inspect and retry another's jobs.

### 5.3 Cross-Cutting Patterns

**Pagination:** `?page=1&limit=25&sort=createdAt&order=desc` → `{ data: [...], meta: { total, page, limit, pages } }`. Sort fields are allowlisted per entity; values outside the allowlist fall back to the entity's default sort.

**Errors:** `{ error: { code: "VALIDATION_ERROR", message: "...", details: [...] } }`. Prisma error codes (P2002 unique constraint, P2025 record not found, P2003 foreign key, P2014 relation constraint) are mapped to HTTP status codes and friendly messages by a central error handler.

**Validation:** Zod schemas live in the `@utility-cis/shared` package and are reused by the API (as runtime validators) and by the web (for form validation and TypeScript types via `z.infer`). The same schemas also feed the OpenAPI document generator (5.5), which keeps the machine-readable API contract in lockstep with the runtime contract.

**CRUD factory:** Entities that follow the standard list/get/create/update shape register their routes via `registerCrudRoutes(app, config)` from `packages/api/src/lib/crud-routes.ts`. The factory owns RBAC config, Zod parsing, `request.user` extraction, and status-code shaping; route files just declare their `basePath`, `module`, and service adapter closures. Entities with unusual requirements (premises with its `/geo` endpoint, rate-schedules with `/:id/revise` and no PATCH, roles with DELETE) supply whatever subset fits and add custom routes alongside the factory call.

**Audit events:** Mutating services wrap their create/update operations in `auditCreate` / `auditUpdate` from `packages/api/src/lib/audit-wrap.ts`. The wrapper opens a transaction (or joins the caller's), runs the mutation, and writes the `audit_log` row carrying `beforeState` / `afterState` / actor / timestamp **in that same transaction** — the mutation and its audit row commit together or not at all. This replaced an EventEmitter pipeline that split the two across separate transactions and lost the audit row if the process crashed between them; see `docs/superpowers/specs/2026-04-27-event-emitter-audit-refactor-design.md`.

A corollary, worth stating because it is easy to get backwards: the audit row records a **fact about the domain**, not the SQL that happened. A bill document's row is claimed before its bytes are uploaded, so the write that completes it is an `UPDATE` — but the first completion is audited as `bill_document.created`, because that is when the document came into existence. The claim itself is never audited, so a failed upload leaves no entry asserting a document that cannot be downloaded.

**List query schemas:** Every list endpoint's query validator extends the shared `baseListQuerySchema` from `packages/shared/src/lib/base-list-query.ts`, which defines `page` / `limit` / `search` / `sort` / `order` as optional. Routes add their entity-specific filters on top and keep `.strict()` so truly unknown keys still get rejected. The base exists because `SearchableEntitySelect` (and any other picker component) always attaches `limit`/`page`/`search` to its fetch, regardless of whether the target endpoint paginates or searches; a route that defined its own `.strict()` schema without those keys would 400 the picker the moment it mounted. Small reference-table routes (e.g. `/api/v1/suspension-types`) accept and ignore the base keys; larger collection routes honor them for real.

**Background schedulers:** Long-running, time-driven work runs in-process via `setInterval` from `packages/api/src/schedulers/*`. Schedulers register themselves from `buildApp` after the Fastify instance is constructed, gated by the `DISABLE_SCHEDULERS` environment variable so tests and worker processes can opt out of side effects. Currently one scheduler exists — the suspension scheduler — which ticks hourly and flips `PENDING → ACTIVE` and `ACTIVE → COMPLETED` on ServiceSuspensions whose dates have arrived, respecting the per-tenant approval gate (see spec 12). **Single-instance only.** Running two API processes will transition the same hold twice and emit duplicate audit events. When the deployment moves to multi-instance, replace the in-process scheduler with BullMQ + Redis-backed job locking; the transition helper (`transitionSuspensions(utilityId, now)`) is already factored so the scheduler wrapper can be swapped without touching service logic.

**Queue-backed work:** Work too long for a request runs on BullMQ over the same Redis as the RBAC and settings caches. Eight queues are registered in `packages/api/src/lib/queues.ts` with their concurrency and retry policy declared in one place: `suspension-transitions`, `notification-send`, `sla-breach-sweep`, `delinquency-dispatch`, `delinquency-tenant`, `audit-retention`, `imports` and `billing-runs`. Enqueueing goes through `enqueueSafely`, which logs and swallows a Redis failure rather than failing the request that caused it — the row is already committed, and a boot sweep or a re-enqueue can take it later.

Two of those queues carry a **progress row**, not just a job: `import_batch` / `import_row` and `billing_run` / `billing_run_item`. Both process per item in its own transaction, resume by filtering on item status rather than retrying the job (`attempts: 1` — an auto-retry would redo work already committed), honour a `cancel_requested` flag checked between items, and are reclaimed on boot if a replica died holding one. The two are deliberately **copies, not an abstraction**: they share a shape, not a reason, and a common "async batch job" base would make a change to imports a change to billing. Billing runs are concurrency 1 — a run is already a loop over thousands of accounts through the rate engine, so two at once would halve neither's wall clock. See spec 09 for what a run does.

**Custom fields:** Tenant-configurable custom fields on extendable entities (Customer, Account, Premise, ServiceAgreement, Meter) are stored in a per-entity `custom_fields` JSONB column and governed by a `custom_field_schema` row per (utility, entity_type) holding a `FieldDefinition[]` array. Each field definition carries both a `type` (data type — drives validation) and an optional `displayType` (widget — drives rendering), letting one data type support multiple input widgets: a `string` field can render as text / textarea / email / url / phone; an `enum` field can render as dropdown or radio group. The admin UI presents a unified "Kind" picker that maps to `(type, displayType)` pairs internally so admins never see the split. Reserved-key collisions with core entity columns are rejected at save time via a per-entity allowlist. The shared `buildZodFromFields` helper dynamically builds a Zod validator from the tenant schema on every write, and the API's `validateCustomFields` service wraps it with merge semantics for partial updates, deprecated-field preservation, and strict rejection of unknown keys. Fields can be deprecated (soft-hide, stored values preserved) or hard-deleted with a two-phase data-safety gate that counts rows holding data for the key and refuses without an explicit `force=true` flag; force mode scrubs the key from every matching row via `UPDATE ... SET custom_fields = custom_fields - $key` atomically. Schema is cached in memory per tenant with a 60-second TTL, invalidated on mutation. See spec 20 for the full design and phase roadmap. **Phases 1 and 2 are now complete**: all five extendable entities (Customer, Account, Premise, ServiceAgreement, Meter) are wired end to end with create-form integration, view-mode display on detail pages, and inline edit support that respects each detail page's local visual conventions via host-style overrides on the shared `<CustomFieldsSection>` component. Phases 3–4 cover datetime data type, searchable expression indexes for list-page filters, and field-level RBAC.

**Identifier generation:** Human-readable identifiers (`account_number`, `agreement_number`) are auto-generated by the backend when the caller omits them on create. The number format is tenant-configurable via a template grammar stored in `utility_config.settings.numberFormats.{agreement|account}`. Supported tokens: `{YYYY}` (4-digit year), `{YY}` (2-digit year), `{MM}` (2-digit month), `{seq:N}` (sequence zero-padded to N digits), `{seq}` (unpadded). Exactly one sequence token per template is required. The parser lives in `packages/shared/src/lib/number-template.ts` (pure, unit-tested) and is consumed by both the API generator in `packages/api/src/lib/number-generator.ts` and the web settings UI's live preview, guaranteeing identical behavior. The generator substitutes the current date into the template, builds a regex from the literal parts with `\d+` standing in for the seq token, queries the highest existing match for the tenant, takes `max(startAt, existing+1)`, and formats back — retrying the wrapped `create` up to 3 times on P2002 unique-constraint races. Because the regex is rebuilt from the current date on every call, sequence resets are implicit: including `{YYYY}` in the template automatically resets the counter every January 1 (new year prefix → no matching rows → restart from `startAt`); including `{MM}` resets monthly; templates with no date tokens never reset. Format changes are non-destructive — legacy rows keep their old identifiers forever because the new regex simply won't match them, and new rows follow whatever template is current. Defaults used when a tenant has no configuration: `SA-{seq:4}` for agreements, `AC-{seq:5}` for accounts. CSRs can still type a custom identifier on any create form to override the generator; uniqueness is enforced at the DB level regardless.

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

- Collapsible sidebar with Font Awesome Pro icons and hamburger toggle; sections: Operations, Collections, Configuration, System; avatar dropdown
- Top bar with breadcrumbs, global search, theme toggle. **Pinned** (`position: sticky; top: 0`) on every page, both the desktop and the mobile variant
- Navigation progress bar on link clicks
- The theme is set by a **blocking script in `<head>`** that reads `localStorage['theme-mode']` and `prefers-color-scheme` before the body is parsed. Without it the markup shipped `data-theme="dark"` and `ThemeProvider` corrected it in an effect, so every load painted dark and then flipped. It must agree with `getEffectiveMode` in `lib/theme-provider.tsx` — same key, same values, same treatment of `system` — and `app/__tests__/theme-bootstrap.test.tsx` executes the real inlined script to hold the two together
- `<AccessDenied />` renders **nothing** while `useAuth().loading`. `auth-context` starts at `loading: true` with no permissions, and `usePermission` reads those directly, so for the width of the `/auth/me` round trip all 47 pages that do `if (!canView) return <AccessDenied />` ask a question whose answer is not known and get "no" — which flashed a lock and a refusal on every login
- Platform operator screens use `components/platform-shell.tsx`: the same `Sidebar` and `Topbar` with two sections, **Platform** (Utilities, Operators) and **Cluster** (Overview, Workers, Queues, Jobs). The sidebar takes its sections as a prop so there is one sidebar in the product rather than one per surface. These sections are **not** permission-filtered and mount no `AuthPermissionProvider` — `/auth/me` answers 403 for a platform token and the provider then falls back to granting everything, so any gating it provided there would be fabricated
- Admin chrome is skipped for `/portal/*`, `/login`, `/dev` and `/platform/*`
- **Column hiding on narrow screens.** The breakpoints are the layout widths multiplied by `--app-zoom` (1.25): `max-width: 959px` is a phone, `max-width: 1499px` a tablet. `zoom` scales what it renders but does not change what a media query reads, so a breakpoint written for the unzoomed width fires a quarter too late. `lib/use-media-query.ts` carries the same two numbers for the JS side. A hand-rolled `<table>` drops columns with `.col-hide-sm` / `.col-hide-md`, which must be on **both** the `<th>` and every matching `<td>` or the header and body fall out of step and every cell after it shifts one column left; a `DataTable` says the same thing in its column config, where it cannot disagree with itself

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
| Settings | `/settings` | Left-rail nav with 9 sections (General, Number Formats, Branding, Notifications, Retention, Billing, Users, Roles, Modules); 4 sections wired to tenant config |

#### Platform console (spec 25)

Eight pages behind the platform actor, outside the tenant permission model.

| Page | Path | Features |
|------|------|----------|
| Utilities | `/platform/utilities` | Every tenant with module / role / user counts; suspend and reactivate behind `ConfirmDialog` |
| Provision | `/platform/utilities/new` | Name, optional first admin, optional explicit id; **Preview** runs the real provisioning as a dry run and rolls back, so a taken name is refused before anyone commits |
| Utility Detail | `/platform/utilities/:id` | Readiness panel, 32 module toggles, roles (create / edit / delete), staff, portal-customer count, and the from-outside history |
| Operators | `/platform/users` | The platform's own identities, `lastLoginAt`, deactivate / reactivate; appointing opens in place |
| Cluster Overview | `/platform/cluster` | One verdict — unattended queues, paused queues, failures — and the recent failures with the tenant each belongs to |
| Workers | `/platform/cluster/workers` | One row per API node: worker id, pid, queues, uptime, attachment. Start is node-local; Stop only where the pid is this node's to signal |
| Queues | `/platform/cluster/queues` | The eight queues, counts only; each count links to Jobs with queue and state in the URL |
| Jobs | `/platform/cluster/jobs` | Jobs in one queue and one state, queue and status as URL filters (so the page is shareable and Back replaces a Close control), **All queues** fan-out merged by "most recently relevant", per-job retry / promote / replay, and a plain-English reason where a job cannot run |

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
- **RLS:** PostgreSQL Row-Level Security policies exist on all entity tables — but see "Current gaps" below: they do not enforce today
- **Defense in depth:** A by-id query either carries `utility_id` in its `WHERE` or uses an id already proved against `utility_id` earlier in the same function. The flat claim this bullet used to make — that every by-id query carries the predicate — is not true and was never true: the 2026-10-18 sweep below found 89 that do not, all of them entry-proved
- **Race conditions:** $transaction for account closure guard and meter uniqueness
- **PII:** SSN/payment card data never stored in CIS (SaaSLogic handles payments)
- **Audit trail:** All modifications logged with actor, timestamp, before/after state

### 7.1 Current gaps

Row-level security **enforces** as of 2026-10-24. This subsection used to
say it did not, and most of what it said was accurate; it is kept here as
the record of what was wrong, because every item was a separate bypass and
any one of them restored puts isolation back to resting on application
predicates alone.

**What was wrong.** PostgreSQL exempts a role from RLS on two independent
grounds, and `cis` qualified on both: it was a SUPERUSER
(`docker/init-cis-user.sh`), and it owned every table, because
`ALTER DATABASE utility_cis OWNER TO cis` and migrations run as `cis`. An
owner is exempt from its own tables' policies unless the table FORCEs them,
and `pg_class.relforcerowsecurity` was `false` throughout. So
`ALTER ROLE cis NOSUPERUSER` alone would have changed nothing — which is
the part most likely to be misread, then and now. The policies themselves
also disagreed about how to fail: most used the one-argument
`current_setting`, which raises when unset, while 21 used the two-argument
form, which returns NULL and silently filters every row.

**What was done.** Four things, and each is load-bearing:

1. **The role is split.** `cis` remains the owner and runs migrations.
   `cis_app` is a non-owning role with no bypass, and it is what the
   application connects as (`DATABASE_URL`). `cis_platform` holds
   BYPASSRLS and nothing else, for work that crosses tenants by design
   (`DATABASE_URL_PLATFORM`).
2. **Every policied table FORCEs RLS**, so the owner exemption is closed
   too, not just the superuser one.
3. **The policies fail loud, uniformly.** A tenant table's policy raises
   on an unset context rather than returning zero rows, because an empty
   result is read as "nothing is wrong". Eight policies admit rows with a
   null `utility_id` — the seven global reference tables and `cis_user` —
   and those are `nullif(current_setting(…, true), '')::uuid` guarded,
   because a transaction-local `set_config` leaves the GUC as the empty
   string after commit and `''::uuid` raises 22P02 where `IS NULL` would
   have matched. That was found by a failing test, not by reading the SQL.
4. **The acting tenant travels in AsyncLocalStorage and is applied to the
   connection**, not threaded through call sites. `withTenant` had five
   call sites against 432 bare-client query sites, so requiring it
   everywhere would have left isolation resting on code remembering
   something. `lib/prisma.ts` owns the `pg` pool and sets
   `app.current_utility_id` once per checkout; `runAsTenant` and
   `runAsPlatform` in `lib/tenant-context.ts` are how a caller declares
   which it is. This needed Prisma 7: Prisma 6's query engine was a process
   boundary that dropped the context, measured both ways before the
   upgrade.

**Where production's credentials come from.** The `rls_roles` migration
creates `cis_app` and `cis_platform` NOLOGIN with no password, because a
password written into a migration is a password in every clone of the
repository for as long as it exists. Development gets throwaway logins
from `scripts/grant-dev-db-logins.sql`, run by `setup_db.bat` after
`migrate deploy` — it cannot live in `docker/init-cis-user.sh`, which
runs on first init of an empty volume, before any migration has created
the roles it would alter.

Production runs `packages/api/scripts/grant-db-logins.mjs`, which takes
`CIS_APP_PASSWORD`, `CIS_PLATFORM_PASSWORD` and an `ADMIN_DATABASE_URL`
from deployment secrets, in that order of the deploy: migrate, grant,
start. It derives the SCRAM-SHA-256 verifier locally and sends that
rather than the password, because `ALTER ROLE … PASSWORD 'secret'` is a
statement — visible in `pg_stat_activity` and logged under
`log_statement = ddl`, which would put a database credential in a log
file. It also refuses a database whose roles are mis-shaped, including
the case where one role is a *member* of the other and could `SET ROLE`
into the bypass; handing out credentials is the wrong moment to discover
that the split is decorative.

**What must not be undone.** `ALTER ROLE ... SUPERUSER` or `... BYPASSRLS`
on `cis_app`; dropping FORCE from a table; pointing `DATABASE_URL` at the
owner role; or widening a policy with an `OR current_setting(...)` escape
hatch, which is reachable from any code path that can set a GUC and so puts
the invariant back into application code. The first three are refused at
startup in production by `assertRlsEnforced` (`lib/prisma.ts`), which is
also why a dev stack on a superuser only warns.

**The two deliberate bypasses**, both on `cis_platform` and both
cross-tenant by nature: the platform console's routes, which exist to read
across tenants, and the six all-tenants queue sweeps, which find work in
every tenant in one pass. A sweep with no authority reads nothing and
reports success — no rows flipped, no error raised, nobody's SLA breached
overnight — so `lib/queue-scope.ts` derives the authority from
`QUEUE_TENANCY` rather than applying it by hand. The two per-tenant queues
are confined to the tenant named in their job payload, and a per-tenant job
carrying no tenant is refused rather than widened.

**Relationships carry the tenant too, and must.** Row-level security
cannot police a foreign key, and not by oversight: its policies filter
which rows a query *reads*, and a referential-integrity check is not a
read — PostgreSQL runs those as the table owner, exempt from RLS. A
single-column key was therefore satisfied by a parent the acting tenant
could not see, and a mismatched pair was writable; measured, not
assumed, in `cross-tenant-fk.integration.test.ts`. The
`tenant_scoped_foreign_keys` migration rewrites all 64 such keys as
`(utility_id, <fk>) -> parent (utility_id, id)`, derived from the
catalog rather than listed, so each one keeps its own `ON DELETE`
action. Two kinds stay single-column because a composite key would be
*wrong* rather than redundant: keys pointing at `utility`, which has no
`utility_id` of its own, and keys pointing at a global reference table,
whose nullable `utility_id` means "belongs to no tenant" and can never
equal a child's tenant.

**These keys are SQL-only, like the policies.** `schema.prisma` cannot
express 17 of them: Prisma requires every referencing field of a
`SetNull` relation to be optional, and `utility_id` is required. The
alternative was to declare a referential action Prisma would not
perform, so the keys live in the migration and
`schema-invariants.integration.test.ts` pins the absence of any
single-column survivor — a relation added without the tenant fails there
and names itself.

**What is exempt, and why.** `_prisma_migrations`, which is not tenant
data; and `utility`, whose own `id` *is* the tenant id and whose policy
uses it. `import_row` was an exemption until 2026-10-24 and is not one any
more — it was given a `utility_id` column, since a table that holds rows of
a tenant's imported data has a tenant.

**Sign-in is the one place with no scope to inherit.** The three
unauthenticated routes read the database before a request scope exists, so
each names its tenant explicitly and holds it for the whole handler. Portal
registration used to look an account number up with no tenant at all;
account numbers are unique per tenant, so it now requires one.
Coverage: `sign-in-rls.integration.test.ts`.

**"A query that forgets its predicate" is not hypothetical — one audit found
seven.** On 2026-10-17, auditing the two queues that run several tenants'
jobs concurrently in one process (`imports` at concurrency 4,
`delinquency-tenant` at 5), the workers themselves came back clean: both
`processBatch` and `evaluateAll` verify tenant ownership once at the entry
and derive everything after from the id they proved, and all 13 database
accesses in the five import handlers carry `utility_id`. The shared service
they both call did not. `notification.service.ts` accepted `utilityId` and
used it for a single query — the tenant config — while the recipient lookup,
the five template-variable lookups and the preview endpoint's template
lookup read by primary key alone.

Two things in that are worth carrying forward for anyone auditing the rest:

- **The giveaway was a `utilityId` parameter that the function body never
  reaches for.** Both this and the `bill-message.service.ts` targeting defect
  fixed the same day had that shape — a tenant argument present at the
  signature, absent from the `where`. It greps for easily and is worth
  sweeping on deliberately rather than finding by accident.
- **Reachability came from the routes, not the workers.** The two internal
  callers pass ids they derived from tenant-scoped queries, so the worker
  paths were safe by caller discipline. But
  `POST /api/v1/notifications/send` takes `recipientId` and a free-form
  `context` map from the request body — validated as uuids and nothing more
  — so a caller could name ids the engine never derived. That made it a
  missing authorization check on user input *today*, independent of whether
  a second tenant exists. An audit that only reads worker code would have
  called it safe.

Fixed by adding the tenant predicate to all seven lookups. Note for anyone
sweeping for the same shape: a bare `findUnique({ where: { id } })` is the
signal, but its presence is not the defect and `findUnique` is not the
problem — since Prisma 5 it accepts non-unique predicates alongside the
unique one, and `posting.service.ts:167` relies on that. Read the `where`,
not the method. Regression coverage:
`notification-tenancy.test.ts`, which pins the `where` clauses and asserts
that the persisted `resolved_variables` holds nothing of the named tenant's
— verified to fail on five of six cases against the unscoped version.

**A token whose subject has no `cis_user` row skips the permission check.**
`middleware/authorization.ts` returns early when `getUserRole` finds nothing,
deliberately, for backwards compatibility during the RBAC migration — the
module-enabled check still runs, but per-module VIEW/CREATE/EDIT/DELETE does
not. It is pinned as intended behaviour by
`authorization.test.ts` ("allows request when user has no CIS User record in
DB"), so closing it is a migration rather than a one-line change: several
suites authenticate with tokens that have no `cis_user` row and rely on this.
Sequence is (1) seed `cis_user` rows for every real principal, (2) update those
suites, (3) turn the early return into a 403.

**The deliberate sweep for the same shape (2026-10-18) — 89 sites, no holes.**
Run as the prerequisite the tenancy design note makes of it (§1.7, build-order
step 5): the `utilityId`-parameter-that-scopes-nothing shape is worth sweeping
for before an identity that is not scoped by `utility_id` exists, not after.
The instrument is committed at `scripts/audit-tenant-predicates.mjs` so the
numbers below are re-checkable rather than asserted.

Method, and the two passes it took to get right. The script brace-matches every
`prisma|tx.<model>.<method>(…)` call in `packages/api/src/services`, extracts its
`where` object, and reports those naming an id with no `utilityId`. **Its first
version read `/id\s*:/` and so could not see the shorthand `where: { id }` —
which hid 27 of the 89, including every `auditUpdate` call site in
`service-request`, `service-suspension`, `container`, `bill-message` and the five
type-def services.** Anyone re-running this should check that blind spot first;
a sweep that silently covers two thirds of its target is worse than no sweep,
because it produces a number.

Results. Of the 89, fifteen receive the id as a bare parameter — the shape that
can be fed from a request body — and every one is proved before use:
`cancelImport` and `retryImport` via `findFirstOrThrow({ id, utilityId })`,
`processBillingRun`/`postBillingRun`/`cancelBillingRun` likewise, `lockAccount`
by a `SELECT … WHERE id AND utility_id FOR UPDATE` that throws on no row,
`ar/allocation.apply`'s three callers, and `promoteContactToPortalUser` via the
contact fetch. The remaining 74 derive their id from a row fetched with the
predicate. A second pass covered the complementary blind spot — a parent fetched
by some *other* column with no tenant predicate — and found 19, of which the
only two worth recording are `uom.service.ts:91,100`: `deleteUom`'s in-use
guards count `meter`/`commodity` rows by `uomId` alone. They are safe because a
uuid can only be referenced by its owner's rows, and the delete itself is
`deleteMany({ where: { id, utilityId } })` with a 404 on zero — but the safety
rests on an invariant rather than on a predicate, which is the distinction this
whole subsection exists to make.

**Q3 of the tenancy note: how a lifecycle operation reads past a policy
comparing against an unset setting. Settled 2026-10-18, reversed 2026-10-24 —
and the reversal is the part to read.** With no tenant context,
`current_setting('app.current_utility_id', true)` returns nothing, every policy
compares against it, and a platform actor's lifecycle read returns nothing.

The 2026-10-18 resolution was that the policies would admit an explicit platform
context — a second setting the policy ORs in — *rather than* a `BYPASSRLS` role,
on the grounds that a role needs its own connection pool and credentials and
exempts all of its queries instead of only the lifecycle ones.

**What was built on 2026-10-24 is the role.** `cis_platform` holds BYPASSRLS, has
its own pool in `lib/prisma.ts`, and is selected by `runAsPlatform` rather than
by a call site. The objections above were all real and were paid: there is a
second pool, there are second credentials, and every query that role runs is
exempt, which is why `queue-scope.ts` derives authority from `QUEUE_TENANCY`
instead of letting a handler choose.

They were paid because the alternative is worse in a way that only became clear
while writing the policies. An `OR current_setting('app.is_platform', true)`
escape hatch is reachable from *any* code path that can set a GUC — a raw query,
a forgotten `set_config`, a service called from the wrong place — so the
invariant would live in application code remembering not to set it, which is
precisely the arrangement §7.1 exists to end. A role is enforced by PostgreSQL
and cannot be assumed from SQL. The narrower exemption was not narrower in the
way that mattered.

---

## 8. Phase Roadmap

### Phase 1 (Complete)
Core foundation: 17 entities, 29 API endpoints, admin UI with map view and theme editor, 68 tests.

### Phase 2 (In Progress)
Enhanced CIS + UI: Customer CRUD API (4 endpoints), Contact CRUD API (4 endpoints), BillingAddress CRUD API (3 endpoints), Agreement meter assignment endpoints (2 endpoints), Attachment CRUD (4 endpoints), UOM delete endpoint (1 endpoint) — total 48 endpoints live. Customer list/detail UI with command center, inline editing on all detail pages (Premise, Customer, Account, Meter, Agreement, BillingCycle), Deactivate/Close/Remove buttons with confirmation dialogs, Add Meter/Agreement inline forms on Premise detail, Add Contact/BillingAddress tabs on Account detail, Add Account inline form on Customer detail, Add/remove meter assignments on Agreement detail, SearchableSelect + DatePicker + HelpTooltip components, navigation progress bar, contextual business rule tooltips on all create forms, owner filter on Premise list, commodity badges on map popups. Attachment tab added to all 5 detail pages (Premise, Customer, Account, Meter, ServiceAgreement) with Upload button in tab bar. Commodity editing on Premise inline edit (toggle buttons). Meter detail: install date, UOM, removal date now editable with DatePicker. UOM inline edit + delete with confirmation (BR-UO-005/BR-UO-006 guard). BR-UO-003 auto-enforcement (setting isBaseUnit=true unmarks existing base unit). Conversion factor label shows base unit dynamically. Agreement status transitions corrected: PENDING→ACTIVE→FINAL→CLOSED (no INACTIVE). Modern thin scrollbars. PageHeader supports onClick action. HelpTooltip uses styled popup (not native title).

RBAC (complete): CisUser, Role, UtilityModule entities added (+3 entities, now 21 total). Authorization middleware with Redis caching (user role 5min TTL, tenant modules 10min TTL). GET /api/v1/auth/me endpoint. User CRUD (4 endpoints) and Role CRUD (5 endpoints) under settings:VIEW/CREATE/EDIT/DELETE permissions. Tenant modules list endpoint. Frontend AuthContext + usePermission hook + ModuleContext. Sidebar permission filtering. Route permission declarations on all /api/v1/* routes. UI button permission gating across all pages. Settings page with Users tab and Roles tab (permissions matrix).

Structural review + hardening (complete): End-to-end adversarial review across security, data model, API contract, UI/a11y, modularity, and testability. Security hardening (parameterized `set_config`, dev-endpoint gating, tenant-scoped RBAC cache, attachment path and MIME hardening, `@fastify/helmet`); data-model tightening (onDelete on every FK, 20+ new FK indexes, MeterRead freeze/correction fields, rate schedule date index, CHECK constraints for non-negative numerics, date ordering, day-of-month bounds, email and language-tag format, non-empty identifiers); API contract (Prisma error code mapping, sort allowlisting, strict create/query schemas, shared `idParamSchema`, machine-readable OpenAPI 3.1 document at `/api/v1/openapi.json` generated from Zod); UI/WCAG (error boundaries, WCAG AA `StatusBadge`, accessible `ConfirmDialog`, `FormField` aria injection, `SearchableSelect` ARIA combobox, `DataTable` scope + keyboard nav, skip-to-main-content, theme-aware semantic badges). Modularity: `auditWrap` helper applied to 10 services, `paginatedTenantList` to 6, `registerCrudRoutes` factory to 8 route files, `EntityListPage` + `usePaginatedList` shell adopted by 6 list pages, badge consolidation, `@fastify/helmet`. Latent middleware bug fixed: `skipAuth` route config is now honored by both auth and tenant middlewares. Test count grew from 32 to **184** (47 shared + 121 api + 16 web) across 20 files; web package now has a full vitest + React Testing Library + jsdom setup wired into `pnpm verify`. Total: 60 endpoints live (+1 `/api/v1/openapi.json`).

Phase 2 operations work landed (2026-04-10): MeterRead CRUD API with consumption + rollover + reverse-flow detection, correction chain (CORRECTED rows preserve originals via `corrects_read_id`), exception queue endpoint + UI, import center UI (three-stage wizard). MeterEvent entity + CRUD for LEAK/TAMPER/BURST_PIPE/FREEZE/REVERSE_FLOW/HIGH_USAGE/BATTERY_LOW/NO_SIGNAL/COVER_OPEN/OTHER with severity + resolution. Solid waste: Container + ServiceSuspension + ServiceEvent entities with CRUD, atomic container swap transaction, RAMS event receiver with idempotency on `rams_event_id`, per-premise/agreement detail tabs. Cross-entity workflows: transfer of service (atomic close-source + open-target), move-in (coordinated customer + account + agreements + initial reads), move-out (finalize all agreements at a premise + final reads + optional account close). Full-text search via Postgres tsvector generated columns + GIN indexes on customer/premise/account/meter, exposed as `GET /api/v1/search` and wired to a Cmd/Ctrl+K topbar overlay. Nine new modules added to the RBAC module list (meter_reads, meter_events, containers, service_suspensions, service_events, workflows, search) with preset-role permission matrices updated for CSR / Field Tech / Read-Only. Sidebar extended with Operations and Solid Waste sections. Total: ~85 endpoints live.

Meter-read UX hardening (follow-up pass): the read-entry form rebuilt with a premise → meter cascade using `SearchableEntitySelect` so the meter dropdown no longer tries to preload thousands of rows. Service-agreement auto-resolution: `createMeterReadSchema.serviceAgreementId` is now optional, and the service resolves the owning agreement from `ServiceAgreementMeter` on meter+date, erroring early with `METER_NOT_ASSIGNED` if no active assignment exists so operators cannot record a read against a closed customer. The read-entry form fires parallel `GET /api/v1/meters/:id` + last-read fetches on meter selection and renders an immediate context card showing meter number, commodity, UOM code + name, active agreement, multiplier formula, and the last reading value + date; if the meter has no active assignment the context card is replaced by a red warning banner and every downstream form field is disabled. The reading input's label shows the UOM code so operators know what units they're entering. A full meter-read detail page at `/meter-reads/:id` shows the consumption calculation breakdown and context cards, plus header buttons for Correct (inline form → PATCH, creates a CORRECTED row) and Delete (`ConfirmDialog` → new `DELETE /api/v1/meter-reads/:id` endpoint with frozen + correction-chain guards). The async picker pattern is exposed in `SearchableEntitySelect<T>` and automatically inherited by every `EntityFormPage` dynamic-options field, so all `/new` forms benefit without per-form changes; the three hand-rolled workflow wizards (move-in, move-out, transfer) were also updated to use it directly. `GET /api/v1/meters` and `GET /api/v1/service-agreements` both gained a `search` query parameter for case-insensitive substring matching on the identifier field, backing the async picker. Several latent dev-bootstrap bugs were fixed along the way: the API's `.env` is now loaded via `tsx --env-file` and `node --env-file`, the auth middleware peeks at the JWT `alg` header so unsigned dev tokens work regardless of whether `NEXTAUTH_SECRET` is set, the `auth-context` fallback module list now imports `MODULES` from shared instead of hardcoding its own twelve-entry list (closing the third of three places where the module list had drifted), the seed script's `allModules` list was expanded to cover the new Phase 2 modules, and `packages/api/run.bat` now flushes Redis + explicitly sets every env var the API reads so stale shell env can't leak into the process. The `MODULES` constant in `@utility-cis/shared` is now the canonical source for both the seed and the web fallback.

Still planned for Phase 2: GIS integration (deferred to Phase 3 as it depends on the map-tile integration and a service territory entity).

### Phase 3
Rating + billing + notifications + delinquency. **CIS calculates charges natively.** The earlier plan — rating, invoicing and delivery owned by [SaaSLogic](https://docs.saaslogic.io), with CIS as an integration shell pushing usage — was dropped on 2026-10-09 after Rate Model v2 shipped a native engine.

Rating and billing (shipped — Rate Model v2 slices 1–5b.2, plus bill production slice 1 and the billing run, slice 5c):

- **Declarative rate engine** (`packages/api/src/lib/rate-engine`) — a `RateComponent` carries `predicate`, `quantitySource` and `pricing` as JSON validated by a shared Zod grammar, so tariffs are data rather than code. Components are topologically sorted, gated by predicate, priced, and `minimum_bill` floors apply as a separate stage after the main pass.
- **Variable loaders** (`lib/rate-engine-loaders`) — account, meter, premise, tenant, index, WQA, linked-commodity and items loaders hydrate the rating context. This is how "wastewater as a share of winter-average water, excluding irrigation" becomes configuration.
- **Versioned schedules** — `RateSchedule` carries an explicit publish state and a `supersedes`/`supersededBy` chain, with a visual component editor in the web app.
- **Charges** — `BillSegment` + `BillSegmentLine` per agreement per period (slice 5a); account-level `Bill` aggregating segments (slice 5b.2). Each line is traceable to the exact schedule version and component that produced it, and carries the `unit` its `quantity` is counted in — the tariff's unit, which the rate engine converts a meter's reading into (HCF tiers, gallon meters).
- **Golden tests** pin the Bozeman water / sewer / stormwater / solid-waste tariffs and NorthWestern Energy residential electric.

SaaSLogic, reduced to a payment rail and reached over apptor-connect (see `docs/specs/21-saaslogic-billing.md` and §3.6):

- **No client package.** The `@utility-cis/saaslogic` package the prior design wanted — "typed REST client, bearer-token auth, retry with backoff, idempotency keys, call-log emission" — is not built and is not wanted as of 2026-10-21: four of those five belong to apptor-connect's proxy plane, and the fifth is one bill-keyed column. What we write is request and response types.
- **Payer mirroring** — lazy upsert of a SaaSLogic customer, `customer.saaslogic_customer_id`. Still wanted.
- **Amount due** — register an issued `Bill`'s total for collection, keyed on the Bill. Replaces usage push.
- **Payment result** — the events plane inbound, feeding CIS's own AR posting; a scheduled proxy pull only if SaaSLogic cannot call out.
- **Payment methods** — redirect-only to a hosted page. CIS holds no card data and stays out of PCI scope.
- **Dropped:** subscription provisioning, plan IDs on rate schedules, commodity/UOM resource mapping, `BillingLineItem`, usage push via `POST /subscriptions/{id}/resources`, and the authoritative `Invoice` mirror — all presupposed SaaSLogic doing the pricing. Also `SaaslogicCallLog` and `PollCursor`, and the per-tenant encrypted credential store, which the rail makes redundant.

**Interval reads** (`meter_interval_read` hypertable) remain planned but belong to meter reading, not the payment integration — the rate engine consumes them directly.

**AR posting, payments and adjustments (shipped — module 23 slices 1–3).** An issued `Bill` posts one signed `LedgerEntry`, and `Account.balance` plus `lastDueDate` are recomputed from the ledger in the same transaction. Posting is configurable per tenant (`UtilityConfig.autoPostBills`) and overridable per account, defaulting to automatic. Money received is recorded as a negative entry and allocated against open charges — fees first, then manual debits, then bills, oldest due date within each class — with any leftover staying open as a customer credit balance, which a later charge absorbs automatically. Any posted entry can be reversed for NSF or correction: the reversal gives back exactly what the original consumed and is then settled against it, so a bounced payment cannot be spent twice. `GET /api/v1/ar/reconciliation` proves the cache matches the ledger, returning the number of accounts examined alongside the drift so that an empty result is distinguishable from a check that could see nothing. Fees, manual charges, waivers and write-offs each cite a tenant-defined reason code, and the three acts stay distinct on purpose: a wrong charge is reversed, a forgiven one is credited, an uncollectable one is written off — so billing accuracy, concessions and bad debt remain separately reportable. A waiver reduces the receivable and never `bill.total`. The account detail page gained an **AR tab** in slice 4a: the ledger with charged and still-owed kept separate, a credit balance described in words rather than as a negative amount due, both sides of a reversal marked so they do not read as a double charge, and the operator actions — post, pay, reverse, raise a fee, waive, write off — each gated on the module that owns it. A **Billing** sidebar section now holds the tenant-wide views a CSR works — Bills and Receipts; the `& AR` was dropped because "AR" is ledger jargon and an `&` in a section name usually means the category was never chosen — and the auto-post setting is finally reachable as a toggle on Settings → Automation. The cache-versus-ledger check lives at **Settings → Ledger Integrity**, renamed and moved out of Billing & AR because it is not reconciliation in the billing sense — it ties no receipts to a deposit and no subledger to a GL — but an integrity check on a denormalisation, run by an admin after a migration or a repair. It treats "nothing was checked" as inconclusive rather than healthy. `GET /api/v1/bills` closes the cross-account gap: a tenant-wide bill list with bill-number search, a tri-state posted filter and inline posting, at `/bills`. That is where posted state and the Post action now live, because a bill is a calculation until it is posted and the AR tab — which lists what is owed — cannot show an unposted bill at all; the tab keeps an informational note explaining a balance that looks lower than expected. The Bills screen is also where a CSR works a call end to end: it shows what is still owed on each bill beside its total, takes a payment (labelled against the account, because allocation is account-level and oldest-first), and reverses a bill's charge — there being no void and no unpost, since a wrong charge is reversed with both sides left on the ledger. `GET /api/v1/receipts` adds the receipts side at `/receipts`, titled **Money received**: a day's takings across all accounts with a total to tie out against the bank deposit, filtered by kind and tender and searchable by cheque or lockbox reference. It holds `PAYMENT` and `DEPOSIT` alike, because the test for being there is whether the money arrived rather than whether it was a payment -- a security deposit taken at the counter is on the same bank slip as a cheque settling a bill, and excluding deposits left the total short by exactly them while looking complete. One combined figure with a per-kind split beneath it, every kind stated even at zero; the Kind column is never hidden, since a deposit read as a payment answers "have they paid?" wrongly. Money leaving is deliberately absent -- a bank slip is one-directional, so a refund belongs on its own screen with its own tie-out. A deposit now also carries its tender from account creation and move-in, without which it could not be matched against the slip it arrived on. A reversed payment stays inside that total, because the money was in that day's deposit even though the cheque later bounced; the row is marked instead. No batch or deposit model was built — a date range and a total answer the question without choosing a batch granularity nobody has asked for. A security deposit is a `DEPOSIT` ledger entry rather than a bare column, excluded from allocation so a later bill cannot spend it and from `Account.balance` so arrears stay visible to the delinquency sweep; `Account.depositAmount` is its cache and reconciliation proves both. **Refunds ship in slice 4c, and the thing that made them urgent was a workflow, not a balance.** A credit balance on an ACTIVE account is harmless — §6.1 step 4 has the next charge absorb it — but `/workflows/move-out` already closed accounts, and a closed account has no next charge. A `REFUND` is a positive DEBIT that discharges the credit it pays out, at `POST /api/v1/accounts/:id/refunds` on `payments:CREATE`, and it must say which pool it draws from: `CREDIT` or `DEPOSIT`, with no default, because both pools are negative by sign and a walk filtered on sign alone would pay an overpayment out of a security deposit. Asking for more than is available is refused with the figure rather than truncated, and availability is summed from the open credits rather than read from `Account.balance`, which is both a cache and a net number. The disbursement record — tender, cheque number, issue date — lives on the entry, in the same three columns a payment uses for how money arrived; no separate table, since what one would add (cheque-run batching, an issued/cleared/voided lifecycle, approved-but-unpaid state) is unasked for, and spec 10 already puts approval outside the ledger because posting is final. Refunds stay off the Receipts screen: a bank slip is one-directional. The `refundDeposit` checkbox on move-out, accepted and ignored since that workflow shipped — the fourth orphan in this module — now issues the refund inside the move-out transaction, returns the deposit in full, and reports what the account still owes rather than netting it. A **Disbursements** screen at `/disbursements`, titled **Money paid out**, closes the mirror gap: before it, `REFUND` appeared in exactly one place in the web app — the account AR tab — so a refund was visible on one account and nowhere tenant-wide, and "what did we pay out today" had no answer. It is deliberately its own screen rather than a direction column on Receipts, because the two totals are tied out against different documents — a bank deposit slip holds only money in, a cheque run only money out — and a single netted figure agrees with neither. The pool a refund drew from is **derived** from the credits it discharged rather than stored, since every application on a refund points at credits of one kind and a column would be a second copy free to disagree with the ledger; a refund with no applications shows as Unknown rather than defaulting to a credit refund, which would put money in the wrong column of a reconciliation. Its subtotals are summed through that relation by the database, so they cover the filter rather than the page. And what Receipts was actually missing was not a Refund button but **Reverse**: tying out a day is when an NSF cheque surfaces, the screen already marked reversed rows while offering no way to make one, and a refund is the wrong act for a payment taken in error — §3.5 keeps them apart. Still outstanding: withholding part of a deposit against a final bill, interest accrual on deposits held, statutory release rules, the statement view; the aging buckets (under Collections); reason-code CRUD (under Configuration); the per-account auto-post override; and a cross-account ledger or payments list. The portal amount due came off this list on 2026-10-22 — `/portal/api/dashboard` carries `amountDue`, summed server-side from the `Account.balance` rows.

**Bill production (shipped — slice 1).** A posted `Bill` becomes a durable PDF in three separable pieces: a resolver turns the bill and its neighbours into a plain `BillPresentation`, a declarative template is generated from that, and the bytes go to the tenant's own object store. The split is what keeps tenant conditionals out of the generation machinery — anything per-tenant arrives inside the presentation, so the template reads one input and nothing else. Rounded line amounts are summed to produce the printed group subtotal rather than rounding the stored 4dp subtotal, because a customer who adds up their own bill and gets a different answer is the most damaging bug this feature could ship. A bill refuses to render at all when the issuer identity is incomplete, the recipient has no name or address, or there are no charge lines, each with a 422 naming what is missing: a bill with a blank recipient that gets mailed is worse than no bill. Output is **byte-stable** — the renderer's wall-clock timestamps are pinned — which is what makes a concurrent Regenerate harmless rather than a race over differing bytes. Storage is apptor-connect's files plane and nothing else: one integration name selects S3, Azure Blob or GCS on their side, they hold the credential, and no storage-driver abstraction was built for a single backend selected by name. `BillDocument` holds a pointer, never bytes and **never a URL** — a minted capability link is a bearer credential that needs no login, so it is consumed inside the files client and discarded, and bytes stream back through our API where our own RBAC applies. The row is claimed before the upload so the unique constraint on `(bill_id, document_type)` arbitrates concurrent renders, and only the completed store is audited: a claim is not a document, and a failed upload leaves neither a row nor an audit entry asserting one. Issuer identity and the storage integration are `UtilityConfig.settings` namespaces rather than columns, following the rule the existing split already encodes — a typed column is for what a scheduler or a query touches, a validated `.strict()` namespace for what an operator edits and one code path reads. Nothing filters on a remittance address. Producing a document is `accounts:EDIT` and reading one is `accounts:VIEW`, split on whether the call writes; a Regenerate shares the write's authority rather than needing a higher one, since byte-stable output means replacing a document cannot change what it says. An earlier `accounts:APPROVE` gate on a separate Regenerate path was a defect worth recording: no preset role grants `APPROVE` on `accounts` — the permission exists for `service_suspensions` alone — so the endpoint was unreachable by every seeded role, and with the authority equal the separate path had no reason to exist. **Reprinting creates no version**, and the absence is deliberate: the same presentation renders identical bytes, nothing delivers a bill yet so there is no sent copy to preserve, and versioning belongs with corrected issuance in slice 5d.

**A service period is read to read (2026-10-15).** A `BillSegment`'s period is resolved from the meter reads rather than from the cycle's calendar: it ends on the newest unbilled read on or before the scheduling bound, and starts the day after the last read already billed, so consecutive periods abut with no gap and no overlap. `resolveServicePeriod` in `bill-segment.service.ts` is the only place this is decided, and a `Bill`'s period is the span of its segments. The reason is manual reading: two accounts on one cycle are never read on the same day, so a nominal 1/1–1/31 period described neither of them — and a reader one day late left one window with no read, producing a zero-usage bill, and the next with two, billing both intervals at once and pushing the customer into a tier they never entered. `BillingCycle` gained a required `read_day_of_month` that must precede its bill day, which had been promised in four documents since Phase 1 without existing. Two refusals replace the old guess: `NO_READ_IN_WINDOW` (400 — estimation is the answer to that and is not built) and `READ_PREDATES_BILLED_PERIOD` (409 — a backdated read needs a rebill, not a new segment). Tier thresholds can now be prorated by the days actually billed (Req 138), opt-in per tariff via `standard_days`, because 29-to-33 days is ordinary once periods run read to read and a missed read makes 44 normal — and because automatic scaling would silently change the arithmetic of every published schedule.

**The billing run (shipped — slice 5c, API and worker; no UI).** `BillingRun` + `BillingRunItem` make a cycle's billing a row to watch rather than a request to wait on: twelve thousand accounts each rating several agreements is minutes of work, and an HTTP request that long dies to a proxy with the work half done and no record of how far it got — after which re-running it turns the per-account overlap guard into twelve thousand 409s rather than a resume. Eligibility is one query (the cycle, a billable status, an agreement overlapping the window), so an account that is not due is not in the run at all while one that is due and cannot be billed is an item carrying a reason. **SKIPPED and FAILED are separate statuses because only one of them is work** — "nothing to bill" is noise an operator scrolls past, "should have billed and could not" is a queue, and a single error count would bury the second in the first. The run is deliberately not atomic: one transaction over twelve thousand accounts holds locks for minutes and lets one bad rate assignment roll back eleven thousand good bills, so `PARTIAL` is a normal outcome. Rating and aggregation do share one transaction per account, because segment creation marks the period's reads `billed_at` and rating that survived a failed aggregation would leave reads billed against segments with no bill. **The run calculates; posting is a second act over the finished run** — bills a run creates pass `suppressAutoPost`, overriding the tenant's `autoPostBills`, which the design depends on: `generateBillForAccount` auto-posts by default, so without it a run would have raised every receivable as it went and the exception review would have happened after the money moved. A run is exactly when a bad rate change becomes twelve thousand wrong charges, and reversing those is far worse than discarding unposted bills. The screens landed the next day, at `/billing-runs` and `/billing-runs/:id`. Three things in them are worth recording because each one is a decision rather than a layout. **Failures and skips are never one number** — the summary row originally carried a single `exception_count`, which added "nothing to bill" to "should have billed and could not" and so told a clerk with forty unread meters that there were forty things to fix; it is now `failed_count` and `skipped_count`, with their sum derived rather than stored so a third counter cannot disagree with them. **Starting a run shows a preview first**, from `GET /billing-runs/preview`, because the window is the cycle's own and always ends on its bill day on or before the date asked for — an operator who types the 20th against a cycle that bills on the 15th gets the 15th, and a run cannot be started twice, so that has to be visible before the click rather than discovered after it. **Posting names the amount**, and a finished unposted run says in words that no customer owes any of it yet, because every other screen in this app shows bills that are already owed. What is still missing is the trigger: a person starts every run, and `Generate Bill` on one account's Bills tab remains the only other way to produce a bill.

The UI offers one button for "give me the bill" rather than making a CSR read a row's state to pick between Download and Generate: **PDF** fetches, and generates first if nothing is stored. Fetching before generating is what keeps the permission split honest, since downloading is `accounts:VIEW` and generating is `accounts:EDIT` — a generate-first button would stop a read-only user from fetching a PDF that already exists, and only a 404 is treated as "not generated yet". That download is the only inline action a bills row carries. Everything that moves money or overwrites something — take payment, regenerate, waive, write off, reverse — sits behind a **More** menu, ordered by how often it is reached and what it costs to get wrong, after the row had grown to six buttons and started reading as a control panel rather than a list of bills. The download also appears on an account's AR tab and in the bill's own dialog, since a CSR on a call reaches for whichever they are already on. That order also means no row has to carry document state, which an earlier design did at the cost of two API fields, two joins, and being wrong the moment someone generated the PDF in another tab. Issuer identity and bill storage share one Settings page rather than being filed onto two existing tabs, because they answer one question: why a bill will not produce. **The portal download closed on 2026-10-22**, and what had been missing was never the endpoint — `GET /portal/api/bills/:id/document` had been live since this slice — but a real bill id to pass it, since every portal bill surface rendered `mockCustomerBills`. `GET /portal/api/accounts/:accountId/bills` supplies them, and the same `BillPdfButton` serves both surfaces on a `surface` prop: on `"portal"` it fetches only, because generating is `accounts:EDIT` and no portal token holds it, so the staff fetch-then-generate fallback would have answered a customer with an authorization error for their own bill. Delivery is still outstanding.

Notifications (complete): NotificationTemplate + Notification entities. Template CRUD with channel (**`EMAIL` and `SMS` only** — `NotificationChannel` has no postal member, so Bozeman #27 and bill delivery #132 both need one added; this line claimed MAIL until 2026-10-21), Mustache body with variable interpolation, event-trigger binding. Notification send + list endpoints. RBAC module `notifications` with VIEW/CREATE/EDIT/DELETE permissions. See `docs/specs/13-notifications.md`.

Delinquency (complete): DelinquencyRule + DelinquencyAction entities. Rule CRUD with configurable thresholds (days past due, minimum balance), escalation tiers, and linked notification templates. Action log tracks rule firings per account. RBAC module `delinquency` with VIEW/CREATE/EDIT/DELETE permissions. Account entity extended with `balance`, `lastDueDate`, and `isProtected` columns to support delinquency evaluation. **Wired to the ledger and the field on 2026-10-25** (Bozeman #145, #198, #199): a tier charges a flat or percentage fee through `assessFee` inside the action's own transaction, can replace what the ladder charged below it, and dispatches shut-off and reconnection service requests through two state-keyed sweeps. The fee reaches the customer as an `Other activity on your account` block on the next bill, bounded at that bill's own `bill_date`. Two SQL-only schema objects came with it — a partial unique index giving "one live action per account per tier" across processes, and two more tenant-scoped composite foreign keys. See `docs/specs/11-delinquency.md`.

Still planned for Phase 3: batch billing run (slice 5c), rebill/corrections (slice 5d), the bill-document UI actions and bill delivery, and late fees and payment plans — the latter now as CIS-side charges and AR arrangements, not as line items fed to SaaSLogic.

### Phase 4
Customer portal + service requests. See `docs/specs/15-customer-portal.md` for the full spec.

Phase 4.1 (complete — portal MVP): Unified JWT auth with `CisUser.customerId` FK to `Customer` (no separate PortalUser entity). Portal Customer preset role with four portal-specific RBAC modules (`portal_accounts`, `portal_billing`, `portal_usage`, `portal_profile`). Portal is a route segment in the existing Next.js app (`/portal/*`) with its own layout (horizontal nav, avatar dropdown, no admin sidebar). Dev-mode registration (account number + email verification) and login via `POST /api/v1/auth/dev-login`. Token persistence in localStorage with 401→login and 403→portal redirects. Pages: dashboard (amount due per account with a tie-out total, current usage from MeterRead, account cards), bills (the customer's posted bills across every account they hold, with settlement status and the bill PDF), usage (premise/meter picker, MonthPicker date range, monthly bar chart with UOM), account detail (premises → agreements → meters hierarchy), profile (view + inline edit). All portal data endpoints are customer-scoped via `customerId` on the token.

**The bill screens stopped being mock on 2026-10-22**, and three things about that are worth recording. The portal and dashboard figures came from `lib/mock-billing`, which invented invoice numbers, premises, commodities, a lifetime-paid total and an on-time rate — three of which have no source in this data model — and the dashboard's fabricated amount due was the first number a customer saw on signing in. They were waiting on an "invoice mirror" **cancelled on 2026-10-09**, while `Bill` and `LedgerEntry` had been there all along. And an `/portal/invoices/[id]` page was deleted rather than wired: the customer-facing bill document is the byte-stable PDF, so a second HTML rendering of a bill would be a second thing to keep in agreement with it. Each portal route needs its own ownership check because the staff routes have none to borrow — a CSR may read any account in the tenant — so a record belonging to someone else answers **404**, and the bills route withholds unposted bills, which have raised no receivable and are therefore owed by nobody.

Phase 4.2 (planned, blocked on Phase 3): real bill data from CIS's own `Bill` / `BillSegmentLine` rows, Pay Now redirect to the hosted payment page, charge breakdown, autopay enrollment, paperless billing toggle.

Phase 4.3 (planned, blocked on Modules 13+14): service request submission/tracking, start/stop/transfer wizards (ApptorFlow), communication preferences, solid waste vacation hold.

Phase 4.4 (planned): multi-account view, third-party payer access, outage/status page, real auth via ApptorID (password hashing, MFA, email verification), AMI interval data on usage page.

### Phase 5
Special assessments: Assessment districts, parcel-based assessments, installment billing.

### Platform and tenancy (shipped, outside the numbered phases)

This belongs to no phase because it is about the deployment rather than about what a utility does. A tenant is now a **row** — `Utility`, with every `utility_id` a foreign key to it under `ON DELETE RESTRICT` — rather than a UUID in a column with no row, no name and no status. Above tenants sits one identity, the **platform actor**: a `CisUser` with a null `utility_id`, holding no role, whose routes are gated on being that row rather than on a permission. Its console is eight pages at `/platform/*` in two sections — tenant lifecycle (provision with a dry-run preview, modules, roles from above the tenant, suspend, operators) and the cluster (nodes, worker processes, the eight queues, and the jobs behind a count with retry, promote and replay). Suspension is enforced in the same authorization pass that checks enabled modules, so a token minted before it stops working rather than running out its lifetime.

Three things are deliberately *not* in it: editing global reference rows (a write to a `utility_id = NULL` row changes behaviour for every tenant at once, so that is a migration or a tenant override), pausing a queue (a decision about a queue, not a job), and purging a tenant. Still outstanding: worker control across nodes (spec 24, steps 2–4), `TENANCY_MODE` as boot configuration, and nullable `audit_log.utility_id` / `entity_id` so host-level actions can be audited at all rather than only logged. See `docs/specs/25-platform-console.md` and `docs/specs/24-platform-worker-control.md`.

---

## 9. External Requirements

See `docs/superpowers/specs/2026-04-08-bozeman-rfp-gap-analysis.md` for mapping of 202 City of Bozeman functional requirements to phases.
