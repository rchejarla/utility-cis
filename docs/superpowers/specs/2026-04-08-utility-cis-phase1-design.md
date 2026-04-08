# Utility CIS — Phase 1: Core Data Model, APIs & Admin UI

**Date:** 2026-04-08
**Status:** Approved
**Scope:** Phase 1 of the Utility CIS platform — foundation layer

---

## 1. Overview

Phase 1 delivers the foundation of the Utility CIS (Customer Information System): the core data model, REST CRUD APIs, multi-tenancy infrastructure, and an internal admin UI for utility staff. This is the first of four phases building a multi-utility CIS as a standalone microservice that integrates with SaaSLogic (billing) and ApptorFlow (workflow orchestration).

### Key Principle

CIS owns the utility domain — premises, meters, accounts, rate logic, and service agreements. SaaSLogic owns the money. The handoff is a structured billing instruction. This boundary is non-negotiable.

### Phase 1 Deliverables

1. Database schema for 13 entities (8 core + 2 reference + junction + 2 system) (PostgreSQL 16+ with TimescaleDB)
2. PostgreSQL Row-Level Security for multi-tenancy
3. REST CRUD endpoints for all core entities (Fastify)
4. Auth middleware with tenant context (NextAuth.js + JWT)
5. Admin UI for utility staff (Next.js + shadcn/ui + Tailwind)
6. Premises map view (Mapbox GL JS)
7. Tenant theme editor with light/dark mode
8. Internal domain event emission for audit trail
9. Unit tests for entity validation, relationship constraints, effective-date logic

---

## 2. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Monorepo** | Turborepo | Fast builds, smart caching, shared types across packages |
| **API** | Fastify (TypeScript) | Separate microservice on port 3001, independent deployment |
| **Admin UI** | Next.js 14+ App Router | Port 3000, SSR/SSG, unified TypeScript stack |
| **UI Components** | shadcn/ui + Tailwind CSS | Customizable, data-dense admin components |
| **ORM** | Prisma | Type-safe client, declarative schema, auto-migrations |
| **Database** | PostgreSQL 16+ | Relational CIS data, RLS for multi-tenancy |
| **Time-Series** | TimescaleDB (PG extension) | MeterRead hypertable for interval data (billions of rows) |
| **Cache** | Redis | Rate schedule caching, session state |
| **Auth** | NextAuth.js (Auth.js) | JWT with `utility_id` claim, validated by Fastify middleware |
| **Map** | Mapbox GL JS + react-map-gl | Vector tiles, dark/light styles, 50k+ point rendering |
| **Clustering** | Supercluster | Client-side point clustering for map view |
| **Validation** | Zod | Shared schemas between API and UI |
| **Event Bus** | Node.js EventEmitter (internal) | Phase 1 only; external broker (Kafka/RabbitMQ) deferred to Phase 3 |

---

## 3. Monorepo Structure

```
utility-cis/
├── packages/
│   ├── shared/                    — Prisma schema, generated client, shared types, event defs
│   │   ├── prisma/schema.prisma
│   │   ├── src/types/             — Entity types, API request/response types
│   │   ├── src/events/            — Domain event type definitions
│   │   └── src/validators/        — Zod schemas for validation
│   ├── api/                       — Fastify CIS REST API (port 3001)
│   │   ├── src/routes/            — Entity route modules
│   │   ├── src/middleware/        — Auth, tenant context, RLS setup
│   │   ├── src/services/          — Business logic layer
│   │   └── src/events/            — Internal event emitter + audit log writer
│   └── web/                       — Next.js Admin UI (port 3000)
│       ├── app/                   — App Router pages
│       ├── components/            — shadcn/ui + custom components
│       └── lib/                   — API client, auth config, theme provider
├── turbo.json
├── package.json
└── docker-compose.yml             — PostgreSQL + Redis for local dev
```

---

## 4. Architecture

### 4.1 Service Boundaries

- **Fastify API (port 3001):** Owns all CIS data. Exposes REST endpoints. Enforces business rules. Emits domain events. This is the integration surface for SaaSLogic and ApptorFlow in future phases.
- **Next.js Admin UI (port 3000):** Pure consumer of the Fastify API. Handles auth via NextAuth.js, passes JWT to API. No direct database access.
- **PostgreSQL + TimescaleDB:** Single database with RLS. MeterRead table is a TimescaleDB hypertable from day one.
- **Redis:** Rate schedule cache (aggressive, invalidate on change event), session state.

### 4.2 Request Lifecycle

1. **Auth Middleware** — validates JWT from NextAuth, extracts user + `utility_id` claim
2. **Tenant Context** — sets `SET app.current_utility_id = '...'` on the DB connection
3. **RLS Enforcement** — PostgreSQL automatically filters all queries by `utility_id`
4. **Route Handler** — validates input (Zod), calls service layer, returns response
5. **Event Emission** — state changes fire internal events → audit log persisted

### 4.3 Multi-Tenancy

Every entity is scoped by `utility_id`. Tenant isolation is enforced at the database level via PostgreSQL Row-Level Security policies, not just application-layer filtering.

```sql
ALTER TABLE service_agreement ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON service_agreement
  USING (utility_id = current_setting('app.current_utility_id')::uuid);

-- Application sets this at connection time:
SET app.current_utility_id = 'mwa-001-uuid';
```

Prisma's `$executeRaw` is used to set the RLS context per-request. A Fastify `onRequest` hook handles this automatically after JWT validation.

---

## 5. Data Model

### 5.1 Commodity

Utility service types. Configurable per tenant — no hardcoded ENUM. Utilities can add custom commodity types without schema changes.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| code | VARCHAR | e.g. "WATER", "ELECTRIC", "RECLAIMED_WATER" |
| name | VARCHAR | e.g. "Potable Water", "Electricity" |
| default_uom_id | UUID | FK → UnitOfMeasure (default unit for this commodity) |
| is_active | BOOLEAN | Default true |
| display_order | INTEGER | For UI ordering |
| created_at | TIMESTAMPTZ | |

### 5.2 UnitOfMeasure

Measurement units per commodity. Includes conversion factors to a base unit for cross-UOM rate application.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| code | VARCHAR | e.g. "GAL", "CCF", "KWH", "THERM" |
| name | VARCHAR | e.g. "Gallons", "Hundred Cubic Feet" |
| commodity_id | UUID | FK → Commodity |
| conversion_factor | DECIMAL(15,8) | To base unit (e.g. 1 CCF = 748.052 GAL) |
| is_base_unit | BOOLEAN | Is this the base unit for its commodity? |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |

### 5.3 Premise (Service Location)

The physical address where utility service is delivered. Permanent — exists independently of customers.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope (RLS) |
| address_line1 | VARCHAR | |
| address_line2 | VARCHAR | Nullable |
| city | VARCHAR | |
| state | CHAR(2) | |
| zip | VARCHAR | |
| geo_lat | DECIMAL(9,6) | For map view |
| geo_lng | DECIMAL(9,6) | For map view |
| premise_type | ENUM | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| commodity_ids | ARRAY\<UUID\> | FK → Commodity (which commodities are served here) |
| service_territory_id | UUID | |
| municipality_code | VARCHAR | |
| status | ENUM | ACTIVE, INACTIVE, CONDEMNED |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 5.4 Meter

Physical device measuring consumption. Retained across customer changes.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| premise_id | UUID | FK → Premise |
| meter_number | VARCHAR | Manufacturer serial, unique within utility |
| commodity_id | UUID | FK → Commodity |
| meter_type | ENUM | AMR, AMI, MANUAL, SMART |
| uom_id | UUID | FK → UnitOfMeasure |
| dial_count | INTEGER | |
| multiplier | DECIMAL(10,4) | Default 1.0 |
| install_date | DATE | |
| removal_date | DATE | Nullable |
| status | ENUM | ACTIVE, REMOVED, DEFECTIVE, PENDING_INSTALL |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 5.5 Account

Billing relationship between a customer and the utility.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| account_number | VARCHAR | Human-readable (e.g. "0184732-00") |
| customer_id | UUID | FK → external CRM / ApptorID |
| account_type | ENUM | RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| status | ENUM | ACTIVE, INACTIVE, FINAL, CLOSED, SUSPENDED |
| credit_rating | ENUM | EXCELLENT, GOOD, FAIR, POOR, UNRATED |
| deposit_amount | DECIMAL(10,2) | |
| deposit_waived | BOOLEAN | Default false |
| deposit_waived_reason | VARCHAR | Nullable |
| language_pref | CHAR(5) | Default "en-US" |
| paperless_billing | BOOLEAN | Default false |
| budget_billing | BOOLEAN | Default false |
| saaslogic_account_id | UUID | FK into SaaSLogic |
| created_at | TIMESTAMPTZ | |
| closed_at | TIMESTAMPTZ | Nullable |

### 5.6 ServiceAgreement

The core billing unit. Links account + premise + commodity + rate schedule. Meters are linked via a junction table (ServiceAgreementMeter) to support both single-meter residential and multi-meter commercial/industrial scenarios.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| agreement_number | VARCHAR | Human-readable |
| account_id | UUID | FK → Account |
| premise_id | UUID | FK → Premise |
| commodity_id | UUID | FK → Commodity |
| rate_schedule_id | UUID | FK → RateSchedule (current) |
| billing_cycle_id | UUID | FK → BillingCycle |
| start_date | DATE | |
| end_date | DATE | Nullable (null = active) |
| status | ENUM | PENDING, ACTIVE, FINAL, CLOSED |
| read_sequence | INTEGER | Order within meter reading route |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Constraints:**
- Status transitions: PENDING → ACTIVE → FINAL → CLOSED (no skipping)
- Supports retroactive end_date adjustments for rebilling

### 5.6.1 ServiceAgreementMeter (Junction)

Links one or more meters to a service agreement. Most residential agreements have one meter. Commercial/industrial may have multiple meters whose consumption is aggregated before rate application.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| meter_id | UUID | FK → Meter |
| is_primary | BOOLEAN | Default true — primary meter for display/routing |
| added_date | DATE | When meter was linked to this agreement |
| removed_date | DATE | Nullable — null means currently linked |
| created_at | TIMESTAMPTZ | |

**Constraints:**
- A meter can only be linked to one active agreement per commodity at a time
- At least one meter must be marked `is_primary` per agreement
- Meters can be added/removed over the life of an agreement without losing history

### 5.7 RateSchedule

Pricing rules for a commodity. Effective-dated and versioned.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| name | VARCHAR | e.g. "Residential Water - Schedule RS-1" |
| code | VARCHAR | e.g. "RS-1", "TOU-EV" |
| commodity_id | UUID | FK → Commodity |
| rate_type | ENUM | FLAT, TIERED, TIME_OF_USE, DEMAND, BUDGET, SEASONAL |
| effective_date | DATE | |
| expiration_date | DATE | Nullable |
| description | TEXT | |
| regulatory_ref | VARCHAR | Docket number or filing reference |
| rate_config | JSONB | Structure varies by rate_type (see Section 5.5.1) |
| version | INTEGER | Default 1 |
| supersedes_id | UUID | Nullable → prior RateSchedule |
| created_at | TIMESTAMPTZ | |

#### 5.5.1 rate_config Structures

**Flat Rate:**
```json
{ "base_charge": 9.00, "unit": "MONTH" }
```

**Tiered / Block Rate:**
```json
{
  "base_charge": 12.50,
  "tiers": [
    { "from": 0, "to": 2000, "rate": 0.004 },
    { "from": 2001, "to": 5000, "rate": 0.006 },
    { "from": 5001, "to": null, "rate": 0.009 }
  ],
  "unit": "GAL"
}
```

**Time-of-Use (defined for Phase 3 but schema supports it):**
```json
{
  "periods": [
    { "name": "On-Peak", "hours": "14:00-21:00", "days": "MON-FRI", "rate": 0.18 },
    { "name": "Off-Peak", "hours": "21:00-07:00", "days": "ALL", "rate": 0.07 }
  ],
  "unit": "KWH",
  "season": { "summer": "JUN-SEP", "winter": "OCT-MAY" }
}
```

**Demand Charge:**
```json
{
  "demand_rate": 12.50,
  "energy_rate": 0.08,
  "demand_minimum_kw": 50,
  "unit": "KWH"
}
```

**Budget Billing:**
```json
{
  "monthly_amount": 95.00,
  "trueup_month": 12,
  "base_rate_schedule_id": "RS-1-2024-07"
}
```

### 5.8 BillingCycle

Defines when meters in a cycle are read and bills generate.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| name | VARCHAR | e.g. "Route 1 — North District" |
| cycle_code | VARCHAR | e.g. "R01" |
| read_day_of_month | INTEGER | 1-28 |
| bill_day_of_month | INTEGER | 1-28 |
| frequency | ENUM | MONTHLY, BIMONTHLY, QUARTERLY |
| active | BOOLEAN | Default true |

### 5.9 MeterRead

Every reading taken from a meter. Created as a TimescaleDB hypertable from day one, partitioned by `read_datetime`. CRUD endpoints and consumption logic are Phase 2 — only the schema is created in Phase 1.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| meter_id | UUID | FK → Meter |
| service_agreement_id | UUID | FK → ServiceAgreement |
| read_date | DATE | |
| read_datetime | TIMESTAMPTZ | For AMI interval data |
| reading | DECIMAL(12,4) | Raw dial reading |
| prior_reading | DECIMAL(12,4) | |
| consumption | DECIMAL(12,4) | Calculated: (reading - prior_reading) × multiplier |
| read_type | ENUM | ACTUAL, ESTIMATED, CORRECTED, FINAL, AMI |
| read_source | ENUM | MANUAL, AMR, AMI, CUSTOMER_SELF, SYSTEM |
| exception_code | VARCHAR | Nullable: HIGH_USAGE, ZERO_USAGE, METER_DEFECT |
| reader_id | UUID | Nullable |
| created_at | TIMESTAMPTZ | |

**TimescaleDB setup:**
```sql
SELECT create_hypertable('meter_read', 'read_datetime');
```

### 5.10 AuditLog

Captures all entity state changes via internal event emitter.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| entity_type | VARCHAR | e.g. "ServiceAgreement" |
| entity_id | UUID | |
| action | ENUM | CREATE, UPDATE, DELETE |
| actor_id | UUID | User who performed action |
| before_state | JSONB | Nullable (null on CREATE) |
| after_state | JSONB | Nullable (null on DELETE) |
| metadata | JSONB | Nullable — extra context |
| created_at | TIMESTAMPTZ | |

### 5.11 TenantTheme

Per-tenant UI theme configuration.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | One-to-one with tenant |
| preset | VARCHAR | Nullable (e.g. "midnight", "daybreak") |
| colors | JSONB | Nested: `{ "dark": {...}, "light": {...} }` |
| typography | JSONB | `{ "body": "DM Sans", "display": "Fraunces" }` |
| border_radius | INTEGER | Pixels |
| logo_url | VARCHAR | Nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### 5.12 UserPreference

Per-user settings (theme mode, view preferences). One row per user per tenant.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| utility_id | UUID | Tenant scope |
| user_id | UUID | FK → auth user |
| theme_mode | ENUM | DARK, LIGHT, SYSTEM — default SYSTEM |
| preferences | JSONB | Extensible (e.g. `{ "premises_view": "map" }`) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## 6. API Design

### 6.1 Base URL

All endpoints under `/api/v1`. All require JWT with `utility_id` claim.

### 6.2 Endpoints

#### Commodities & Units of Measure
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/commodities` | List commodities for tenant |
| POST | `/api/v1/commodities` | Create commodity |
| PATCH | `/api/v1/commodities/:id` | Update commodity (name, active status) |
| GET | `/api/v1/uom` | List units of measure (filterable by commodity) |
| POST | `/api/v1/uom` | Create unit of measure |
| PATCH | `/api/v1/uom/:id` | Update UOM (conversion factor, active status) |

#### Premises
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/premises` | List (paginated, filterable by status, type, territory) |
| POST | `/api/v1/premises` | Create premise |
| GET | `/api/v1/premises/:id` | Detail (includes meters, active agreements) |
| PATCH | `/api/v1/premises/:id` | Update premise |
| GET | `/api/v1/premises/geo` | Lightweight GeoJSON for map view |

#### Meters
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/meters` | List (filterable by premise, commodity, status) |
| POST | `/api/v1/meters` | Install meter (links to premise) |
| GET | `/api/v1/meters/:id` | Detail |
| PATCH | `/api/v1/meters/:id` | Update (status change, removal) |

#### Accounts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/accounts` | List (paginated, searchable by name/number) |
| POST | `/api/v1/accounts` | Create account |
| GET | `/api/v1/accounts/:id` | Detail (includes service agreements) |
| PATCH | `/api/v1/accounts/:id` | Update (status, preferences, deposit) |

#### Service Agreements
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/service-agreements` | List (filterable by account, premise, status) |
| POST | `/api/v1/service-agreements` | Create (with meter assignments, validates uniqueness) |
| GET | `/api/v1/service-agreements/:id` | Detail |
| PATCH | `/api/v1/service-agreements/:id` | Update (rate change, status transition) |

#### Rate Schedules
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/rate-schedules` | List (filterable by commodity, type, effective status) |
| POST | `/api/v1/rate-schedules` | Create rate schedule |
| GET | `/api/v1/rate-schedules/:id` | Detail (includes version history) |
| POST | `/api/v1/rate-schedules/:id/revise` | Create new version (auto-expires predecessor) |

#### Billing Cycles
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/billing-cycles` | List |
| POST | `/api/v1/billing-cycles` | Create |
| PATCH | `/api/v1/billing-cycles/:id` | Update (schedule, activation) |

#### Theme
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/theme` | Get current tenant theme |
| PUT | `/api/v1/theme` | Update tenant theme |
| POST | `/api/v1/theme/reset` | Reset to default |

### 6.3 Cross-Cutting Patterns

**Pagination:**
```
GET /api/v1/premises?page=1&limit=25&sort=created_at&order=desc

Response: { data: [...], meta: { total, page, limit, pages } }
```

**Error Response:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human readable message",
    "details": [{ "field": "zip", "message": "Required" }]
  }
}
```

**Filtering:** Entity-specific query params, all validated via Zod.

**Validation:** Zod schemas in `shared/` package, reused by API and UI.

### 6.4 Business Rules

- **Meter assignment uniqueness:** A meter can only be linked to one active agreement per commodity at a time (enforced on ServiceAgreementMeter)
- **RateSchedule versioning:** Creating a new version auto-expires the predecessor
- **Meter-Premise commodity match:** Meter's `commodity_id` must exist in premise's `commodity_ids`
- **Status transitions:** ServiceAgreement follows PENDING → ACTIVE → FINAL → CLOSED
- **Account closure guard:** Cannot close account with active service agreements
- **Soft delete only:** No hard deletes — status changes to INACTIVE/CLOSED/REMOVED

---

## 7. Admin UI

### 7.1 Layout

Sidebar navigation (collapsible) with sections:
- **Operations:** Premises, Meters, Accounts, Agreements
- **Configuration:** Rate Schedules, Billing Cycles
- **System:** Audit Log, Theme Editor, Settings

Top bar with breadcrumbs, global search, and theme toggle (sun/moon).

### 7.2 Page Structure (App Router)

```
app/
├── layout.tsx              — Shell: sidebar + header + auth + theme provider
├── page.tsx                — Dashboard / redirect to premises
├── login/page.tsx          — NextAuth sign-in
├── premises/
│   ├── page.tsx            — List view (table + map toggle, filters, search, stats)
│   ├── new/page.tsx        — Create form
│   └── [id]/page.tsx       — Detail (info + meters + agreements tabs)
├── meters/
│   ├── page.tsx            — List view
│   ├── new/page.tsx        — Install meter (select premise)
│   └── [id]/page.tsx       — Detail
├── accounts/
│   ├── page.tsx            — List + search by name/number
│   ├── new/page.tsx        — Create account
│   └── [id]/page.tsx       — Detail (agreements + billing + deposit)
├── service-agreements/
│   ├── page.tsx            — List view
│   ├── new/page.tsx        — Link account + premise + meters (1+) + rate + cycle
│   └── [id]/page.tsx       — Detail + status transitions
├── rate-schedules/
│   ├── page.tsx            — List (current + historical)
│   ├── new/page.tsx        — Rate config builder (tier builder UI)
│   └── [id]/page.tsx       — Detail + version history + revise action
├── billing-cycles/
│   ├── page.tsx            — List + manage
│   └── new/page.tsx        — Create cycle
├── audit-log/
│   └── page.tsx            — Searchable log (entity, action, actor, date range)
├── theme/
│   └── page.tsx            — Theme editor
└── settings/
    └── page.tsx            — Tenant settings
```

### 7.3 Reusable Patterns

- **Data Table:** shadcn/ui DataTable with server-side pagination, column sorting, filterable dropdowns, row click → detail
- **Detail Page:** Tabbed layout (Overview, Related Entities, Audit History), inline edit with confirmation
- **Forms:** react-hook-form + Zod resolver (same schemas as API), dependent dropdowns, toast notifications
- **Rate Schedule Builder:** Custom component — select rate type → dynamic form, tier builder (add/remove), live calculation preview, JSON preview for advanced users

### 7.4 Premises Map View

- **Toggle:** Table/Map switch in top bar, shared filter state via URL query params
- **Map:** Mapbox GL JS (`dark-v11` / `light-v11` based on theme) with react-map-gl
- **Pins:** Color-coded by premise type (blue=Residential, amber=Commercial, violet=Industrial, rose=Condemned)
- **Clustering:** Supercluster for client-side clustering, expand on zoom
- **Popup:** Click pin → detail card (address, type, territory, commodities, meters, agreements, status, action buttons)
- **Data:** `GET /api/v1/premises/geo` returns lightweight GeoJSON (id, coords, type, status, commodities). Full entity fetched on popup click.
- **Controls:** Zoom +/-, fit-all, type filters, legend, stats overlay
- **Persistence:** View preference (table/map) stored in localStorage

### 7.5 Theme System

#### Theme Editor
- Preset selection (4 built-in: Midnight/Daybreak, Dusk/Dawn, Forest/Meadow + custom)
- Brand colors: primary, accent, success, danger, warning
- Surface colors: background, card, border
- Typography: body font + display font selectors
- Border radius slider
- Tenant logo upload (SVG/PNG)
- Live preview panel with instant updates

#### Light/Dark Toggle
- Sun/moon switch in header bar
- CSS variable swap via `data-theme` attribute — no page reload
- Persistence: user preference (DB) → tenant default (Theme Editor) → system (`prefers-color-scheme`)
- Map adapts: Mapbox style switches between dark-v11 and light-v11
- `TenantTheme.colors` JSONB nests under `"dark"` and `"light"` keys
- `UserPreference.theme_mode`: `"dark"` | `"light"` | `"system"`

---

## 8. Internal Event System

### 8.1 Architecture

Phase 1 uses a Node.js EventEmitter for internal domain events. No external broker. Events are emitted synchronously after successful database writes and consumed by the audit log writer.

### 8.2 Event Types

| Event | Trigger |
|-------|---------|
| `premise.created` / `premise.updated` | Premise CRUD |
| `meter.created` / `meter.updated` | Meter CRUD |
| `account.created` / `account.updated` | Account CRUD |
| `service_agreement.created` / `service_agreement.updated` | Agreement CRUD |
| `rate_schedule.created` / `rate_schedule.revised` | Rate schedule CRUD |
| `billing_cycle.created` / `billing_cycle.updated` | Billing cycle CRUD |

### 8.3 Event Payload

```typescript
interface DomainEvent {
  type: string;
  entity_type: string;
  entity_id: string;
  utility_id: string;
  actor_id: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  timestamp: string;
}
```

### 8.4 Future: External Broker

In Phase 3, the internal emitter will be replaced by (or supplemented with) Kafka or RabbitMQ. The event contracts defined here will be reused. Application code emits to the same interface; only the transport changes.

---

## 9. Testing Strategy

- **Unit tests:** Entity validation, Zod schema validation, relationship constraints, effective-date logic, status transition rules, rate config validation
- **Integration tests:** API endpoint testing with a real PostgreSQL database (not mocks), RLS enforcement verification, audit log capture verification
- **Test framework:** Vitest (fast, TypeScript-native, compatible with Turborepo)
- **Database:** Testcontainers or Docker Compose for isolated test PostgreSQL instances

---

## 10. Security & Compliance

- **PII (High):** SSN, payment card data — never stored in CIS. Payment instruments handled by SaaSLogic.
- **PII (Standard):** Name, address, phone, email — encrypted at rest (AES-256), access logged, exportable on request (CCPA/GDPR).
- **Usage Data:** Meter reads — subject to state energy data privacy regulations.
- **Financial Records:** Billing records — immutable once created, minimum 7-year retention.
- **Audit Trail:** All modifications to rate schedules, billing records, service agreement status, account status, manual read corrections, and billing instruction submissions are logged with actor, timestamp, before/after state.

---

## 11. Out of Scope (Phase 2+)

- MeterRead CRUD endpoints and consumption calculation (Phase 2)
- Move-in / move-out workflow (Phase 2)
- Rate engine calculation logic (Phase 3)
- Billing cycle execution (Phase 3)
- SaaSLogic integration (Phase 3)
- Customer portal (Phase 4)
- ApptorFlow orchestrated workflows (Phase 4)
- External event broker (Phase 3)
