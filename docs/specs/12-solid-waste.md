# Solid Waste

**Module:** 12 — Solid Waste
**Status:** Phase 2 — Container/ServiceSuspension/ServiceEvent entities + CRUD APIs + UI complete; RAMS integration and container-based billing are Phase 3
**Entities:** Container, ServiceSuspension, ServiceEvent

## Overview

The Solid Waste module manages container/cart-based utility services including residential garbage, recycling, organics, and yard waste collection. It differs from metered utilities in that billing is based on container type, size, and quantity rather than consumption readings. The module integrates with RAMS (Route and Asset Management System) for field operations, supports seasonal service suspensions and vacation holds, and handles billing adjustments for missed collections.

This is an entirely new domain within CIS — solid waste requires its own commodity type, container lifecycle management, RAMS event integration, and container-based rate structures.

Primary users: solid waste program administrators, field supervisors, CSRs, billing staff.

## Planned Entities

### Container (planned)

A physical cart or container assigned to a premise for solid waste service.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| premise_id | UUID | FK → Premise |
| service_agreement_id | UUID | FK → ServiceAgreement (the solid waste agreement) |
| container_type | ENUM | CART_GARBAGE, CART_RECYCLING, CART_ORGANICS, CART_YARD_WASTE, DUMPSTER, ROLL_OFF |
| size_gallons | INTEGER | e.g. 32, 64, 96 |
| quantity | INTEGER | Default 1; some accounts have multiple carts |
| serial_number | VARCHAR(100) | Nullable: RFID or barcode identifier |
| rfid_tag | VARCHAR(100) | Nullable: RFID tag for automated lift tracking |
| status | ENUM | ACTIVE, SUSPENDED, RETURNED, LOST, DAMAGED |
| delivery_date | DATE | When container was delivered to premise |
| removal_date | DATE | Nullable: when returned |
| rams_container_id | VARCHAR(100) | Nullable: RAMS system identifier |
| location_notes | VARCHAR(500) | Pickup location description (e.g., "alley behind garage") |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `[utility_id, premise_id]`, `[utility_id, service_agreement_id]`, `[utility_id, serial_number]`

---

### ServiceSuspension

Temporary suspension of a service (solid waste, water, electric, etc.) — despite living in the solid-waste spec for historical reasons, this entity applies to every commodity. Covers vacation holds, seasonal service pauses, regulatory holds, dispute holds, and "service physically unavailable" scenarios.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| suspension_type | VARCHAR(50) | String code, FK-style reference to `suspension_type_def.code` (global OR tenant-scoped). No longer a hard Prisma enum — see SuspensionTypeDef below. |
| status | ENUM | PENDING, ACTIVE, COMPLETED, CANCELLED |
| start_date | DATE | When service suspension begins |
| end_date | DATE | When service resumes (nullable = indefinite / open-ended) |
| billing_suspended | BOOLEAN | Whether charges are suspended during hold (default true) |
| prorate_on_start | BOOLEAN | Whether to prorate the bill for the suspension start period (default true) |
| prorate_on_end | BOOLEAN | Whether to prorate the bill for the suspension end period (default true) |
| reason | TEXT | Nullable |
| requested_by | UUID | Bare UUID reference to cis_user — NOT a Prisma relation so deleting a user doesn't cascade to hold history |
| approved_by | UUID | Nullable bare UUID reference to cis_user. Set by `POST /:id/approve`. |
| rams_notified | BOOLEAN | Whether RAMS has been updated about the suspension (wiring deferred to Phase 3) |
| rams_notified_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### SuspensionTypeDef

Reference table for hold type codes. Replaces the previous `SuspensionType` Prisma enum so tenants can add or override codes without a schema migration.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID (nullable) | NULL = system-global code visible to every tenant; set = tenant-scoped override |
| code | VARCHAR(50) | Uppercase alphanumeric + underscore. Unique per (utility_id, code). |
| label | VARCHAR(100) | Display label shown in dropdowns and the detail page |
| description | TEXT | Nullable long-form description |
| category | VARCHAR(50) | Nullable grouping hint for the admin UI |
| sort_order | INT | Default 100 — controls order in dropdowns |
| is_active | BOOLEAN | Default true — inactive codes are hidden from creation dropdowns but existing holds continue to reference them |
| default_billing_suspended | BOOLEAN | Per-type default for the billing_suspended checkbox on the create form (Phase 3 wiring) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Seed:** six system-global codes are inserted by `seed.js` — `VACATION_HOLD`, `SEASONAL`, `TEMPORARY`, `DISPUTE`, `UNAVAILABLE`, `REGULATORY`.

**Tenant override behaviour:** if a tenant inserts a row with the same `code` as a global row, the tenant row "shadows" the global one in listings. The `listSuspensionTypes` service resolves this by grouping by code and preferring the tenant row when both exist.

**RLS:** `suspension_type_def` has a custom RLS policy permitting `utility_id IS NULL OR utility_id = current_setting('app.current_utility_id')::uuid`, so every tenant can read global codes while remaining isolated from other tenants' custom codes.

---

### ServiceEvent (planned)

Records events from RAMS or other external field systems that may affect billing — missed collections, contaminated loads, extra pickups.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| premise_id | UUID | FK → Premise |
| service_agreement_id | UUID | Nullable FK → ServiceAgreement |
| container_id | UUID | Nullable FK → Container |
| event_type | ENUM | MISSED_COLLECTION, CONTAMINATION, EXTRA_PICKUP, BULKY_ITEM, CART_DAMAGED, CART_STOLEN |
| event_date | DATE | |
| event_datetime | TIMESTAMPTZ | |
| source | ENUM | RAMS, MANUAL, DRIVER_APP, CUSTOMER_REPORT |
| rams_event_id | VARCHAR(100) | Nullable: RAMS system event ID |
| status | ENUM | RECEIVED, REVIEWED, ADJUSTMENT_PENDING, RESOLVED |
| billing_action | ENUM | Nullable: CREDIT_ISSUED, CHARGE_ISSUED, NO_ACTION |
| billing_amount | DECIMAL(10,2) | Nullable: credit (negative) or charge (positive) |
| adhoc_charge_id | UUID | Nullable FK → AdhocCharge (Module 10) if billing action taken |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## API Endpoints

All endpoints are planned for Phase 2 (container management) and Phase 3 (billing integration, RAMS events).

### Containers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/containers` | List containers (filterable by premise, type, status) |
| POST | `/api/v1/containers` | Assign container to premise/agreement |
| GET | `/api/v1/containers/:id` | Get container detail |
| PATCH | `/api/v1/containers/:id` | Update container (status, location notes, etc.) |
| POST | `/api/v1/containers/:id/swap` | Record container swap (same size or resize) |
| GET | `/api/v1/premises/:id/containers` | All containers at a premise |
| GET | `/api/v1/service-agreements/:id/containers` | Containers for a specific agreement |

### Service Suspensions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/service-suspensions` | List suspensions (filterable by agreement, status, type, activeOn date) |
| POST | `/api/v1/service-suspensions` | Create vacation hold or seasonal suspension. Validates `suspensionType` against `suspension_type_def`. |
| GET | `/api/v1/service-suspensions/:id` | Get suspension detail — backend also resolves `requested_by` / `approved_by` UUIDs to user names and returns them as `requestedByName` / `approvedByName` via a single tenant-scoped `cisUser.findMany`. |
| PATCH | `/api/v1/service-suspensions/:id` | Update dates, reason, billing flag, or status |
| POST | `/api/v1/service-suspensions/:id/complete` | Mark COMPLETED (backfills end_date if open-ended). Refuses if already COMPLETED or CANCELLED. |
| POST | `/api/v1/service-suspensions/:id/approve` | Stamp `approved_by = actor`. Gated by `service_suspensions.APPROVE` permission. Refuses if not PENDING or already approved. |
| POST | `/api/v1/service-suspensions/:id/activate` | Manual PENDING → ACTIVE. Refuses if tenant has `requireHoldApproval = true` and the hold has no `approved_by`. |
| POST | `/api/v1/service-suspensions/:id/cancel` | Mark CANCELLED. Refuses from COMPLETED or already-CANCELLED. |
| GET | `/api/v1/service-agreements/:id/suspensions` | All suspensions for an agreement |

### Suspension Type Reference Table

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/suspension-types` | List active codes for this tenant (globals + tenant-specific, with shadow resolution). Authenticated but no module permission required — it's reference data every form needs. |
| POST | `/api/v1/suspension-types` | Admin-only (gated by `settings.EDIT`): insert a tenant-scoped code |
| PATCH | `/api/v1/suspension-types/:id` | Admin-only: update a tenant-scoped code (global rows are read-only) |

### Service Events (RAMS Integration)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/service-events` | Receive event from RAMS or manual entry |
| POST | `/api/v1/service-events/import` | Bulk import events from RAMS batch file |
| GET | `/api/v1/service-events` | List events (filterable by type, status, date) |
| GET | `/api/v1/service-events/:id` | Get event detail |
| POST | `/api/v1/service-events/:id/resolve` | Mark resolved, optionally apply billing action |
| GET | `/api/v1/premises/:id/service-events` | Service event history for a premise |

## Business Rules

1. **Container-based billing:** Solid waste service agreements use a CONTAINER-BASED rate type (an extension of the rate engine in Module 07/09). The billing amount is calculated as: `sum(container.size_gallons × rate_per_size × container.quantity) + base_charge`. Rate tables are indexed by container_type and size_gallons.

2. **Container inventory constraint:** Each premise can have at most one container of each `container_type` per size tier per active service agreement, unless `quantity > 1` is explicitly set (for multi-unit dwellings). Enforced at assignment.

3. **Container swap billing:** When a customer upgrades or downgrades container size mid-cycle, the swap date is recorded. Billing for the period is prorated: days at old size + days at new size. A ServiceEvent of type CART_SWAP (or PATCH on Container) triggers the proration.

4. **Vacation hold billing:** When `billing_suspended=true` on a ServiceSuspension, the billing engine excludes the suspended period from container-based charges. Proration is applied for partial billing periods at start and end of suspension.

5. **Seasonal service:** Seasonal suspensions operate similarly to vacation holds but are expected annually (e.g., a summer-only yard waste subscription). The service agreement remains active; service and billing resume automatically on the configured end_date.

6. **RAMS integration — event flow:** RAMS sends service events to CIS via the `/api/v1/service-events` endpoint. Each event is reviewed (automated rules or manually). MISSED_COLLECTION events generate a credit (AdhocCharge with negative amount) per configured policy. EXTRA_PICKUP events generate a charge. All billing actions flow through Module 10 (AdhocCharge).

7. **RAMS sync — route changes:** When RAMS changes a route or schedule, CIS must be notified of container location updates (rams_container_id mapping). A reconciliation report compares RAMS container inventory to CIS Container records.

8. **Missed collection dispute workflow:** Customers who believe a collection was missed can file a dispute via CSR or customer portal (Phase 4). This creates a ServiceEvent of type MISSED_COLLECTION with source=CUSTOMER_REPORT. Staff can validate against RAMS records before issuing a credit.

9. **Service suspension RAMS notification:** When a ServiceSuspension is created or modified, CIS notifies RAMS to remove the stop from the route (or re-add it). The `rams_notified` flag tracks whether notification was successful. Failed notifications alert operations staff.

10. **GIS eligibility:** Solid waste service availability at a premise is determined by GIS-based service territory (Bozeman Req 42). The Premise entity's `service_territory_id` and GIS integration (Module — not yet named) determine which solid waste services are available.

11. **Multi-unit billing:** For multi-unit dwellings (e.g., apartment complexes), solid waste service may be billed to the property owner with a single dumpster serving multiple units. This is handled via a COMMERCIAL service agreement on the premise owner's account with `quantity > 1` on the Container.

12. **Container damage/loss:** When a container is reported DAMAGED or LOST (ServiceEvent or manual status change), CIS creates an AdhocCharge for the replacement cost (configurable per container_type and size_gallons). Approval required above a configured threshold.

13. **Hold lifecycle state machine:** ServiceSuspension has four statuses: `PENDING → ACTIVE → COMPLETED`, plus `CANCELLED` (reachable from PENDING or ACTIVE). Transitions happen via two mechanisms:
    - **Manual**: the detail page exposes Approve / Activate / Complete / Cancel buttons subject to the visibility rules below.
    - **Scheduled**: an in-process `setInterval` scheduler runs once per hour (see `packages/api/src/schedulers/suspension-scheduler.ts`) and flips `PENDING → ACTIVE` for any hold whose `start_date` has arrived and whose approval gate is satisfied, then flips `ACTIVE → COMPLETED` for any hold whose `end_date` has passed. Open-ended holds (`end_date IS NULL`) are deliberately skipped on the completion pass — they require manual completion. **Single-instance deployment only**: running two API processes will flip the same hold twice and emit duplicate audit events. When multi-instance is needed, replace with BullMQ + Redis-backed job locking.

14. **Tenant-level approval gate:** Each tenant has a `require_hold_approval` flag on `tenant_config` (default false). When true, new holds remain in PENDING and cannot be activated (neither manually nor by the scheduler) until a user with the `service_suspensions.APPROVE` permission calls `POST /:id/approve`. The approval stamps `approved_by` but does NOT change `status`. Activation remains a separate step. When the flag is false, the scheduler auto-activates on `start_date` without inspecting `approved_by`.

15. **Compound status presentation:** The detail page renders a compound badge derived from `status + approved_by + tenant.require_hold_approval`:
    - `requireHoldApproval = true` AND `status = PENDING` AND `approved_by IS NULL` → **AWAITING APPROVAL** (red)
    - `requireHoldApproval = true` AND `status = PENDING` AND `approved_by IS NOT NULL` → **APPROVED · AWAITING START** (blue)
    - Otherwise `status = PENDING` → **PENDING** (neutral)
    - `ACTIVE` / `COMPLETED` / `CANCELLED` use their stored values directly.

    The underlying `SuspensionStatus` enum still has exactly four values — the compound labels are purely presentational.

## UI Pages

All pages are planned for Phase 2 (container management) and Phase 3 (RAMS events, billing integration).

### Container Management (`/containers`)

- Table: premise address, container type, size, quantity, status, delivery date, RAMS ID
- Filters: type, size, status, premise
- "Assign Container" button → assignment form with premise lookup

### Service Suspensions (`/service-suspensions`)

**List** (`/service-suspensions`)
- Columns: type (raw code), agreement number, period, billing flag, RAMS sync, status badge
- Filters: status (PENDING/ACTIVE/COMPLETED/CANCELLED), type (dynamically fetched from `/api/v1/suspension-types`)
- "+ New Hold" → new-form page

**New form** (`/service-suspensions/new`)
- Service agreement picker (async search via `SearchableEntitySelect`, filtered to ACTIVE agreements)
- Hold type dropdown (populated from `/api/v1/suspension-types`)
- Start date, optional end date
- Reason (free text)
- Advanced "Billing options" section exposing `billing_suspended`, `prorate_on_start`, `prorate_on_end` checkboxes (all default true)
- On submit, POSTs to `/api/v1/service-suspensions`. Every new hold starts as `PENDING` regardless of the tenant approval setting.

**Detail** (`/service-suspensions/[id]`)
- Header: type label, compound status badge (see rule 15)
- Two-column card grid: Agreement, Period, Billing flags, Approval state
- Reason card (full width, rendered only if reason is set)
- Metadata footer: created/updated timestamps, requester and approver names (resolved backend-side from the bare UUID references)
- Action buttons (conditional):
  - **Approve** — shown when `canApprove && requireHoldApproval && status === "PENDING" && !isApproved`
  - **Activate now** — shown when `canEdit && status === "PENDING" && (!requireHoldApproval || isApproved)`
  - **Complete** — shown when `canEdit && status === "ACTIVE"`
  - **Cancel hold** — shown when `canEdit && (status === "PENDING" || status === "ACTIVE")`
  - All actions go through a ConfirmDialog before committing, and the page reloads in place so the CSR sees the updated state (stays on detail, does not navigate away).

### RAMS Events Queue (`/service-events`)

- Incoming events awaiting review
- Grouped by event type (MISSED_COLLECTION, CONTAMINATION, etc.)
- Per-event: premise, date, RAMS ID, status
- Actions: Issue Credit, Issue Charge, No Action, Escalate to Dispute

### Premise Detail Enhancement (`/premises/:id`)

- "Containers" tab: list of all containers at premise with status history
- "Service Events" tab: history of RAMS events at premise

## Phase Roadmap

- **Phase 1 (Complete):** commodity_ids array on Premise supports SOLID_WASTE commodity. ServiceAgreement can reference solid waste rate schedules.

- **Phase 2 (Complete):**
  - Container entity + CRUD API + UI (`/containers`, `/containers/new`)
  - Container assignment to premises and optional service agreements, with one-per-type-per-agreement duplicate guard (quantity > 1 override for multi-unit dwellings)
  - Container swap endpoint (`POST /api/v1/containers/:id/swap`) atomic in a single transaction — marks the outgoing container RETURNED and inserts a new ACTIVE row in one step so a partial swap can't leave a premise with zero containers
  - ServiceSuspension entity + CRUD API + UI (`/service-suspensions`, `/service-suspensions/new`) with vacation / seasonal / temporary / dispute types and explicit complete endpoint
  - ServiceEvent entity + API receiver for RAMS events with idempotency on `rams_event_id` (duplicate events return the existing row rather than double-billing on retry)
  - Service events list page (`/service-events`) with filters by type, status, source
  - Per-premise containers / suspensions / service-events endpoints for detail-page tabs

- **Phase 3 (Planned):**
  - Container-based billing rate type in rate engine (Module 09)
  - Proration for container changes and service suspensions
  - RAMS event billing actions (missed collection credits, extra pickup charges) via AdhocCharge (Module 10)
  - RAMS route sync and reconciliation report
  - Missed collection dispute workflow
  - Seasonal service billing automation
  - Container damage/loss charge automation

- **Phase 4 (Planned):** Customer portal: request vacation hold, view container status, report missed collection.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 42 | GIS-based solid waste eligibility | Phase 2: GIS service territory on Premise |
| 43 | Multiple waste service types per property | Multiple ServiceAgreements per Premise (Phase 1) |
| 44 | Effective-dated enrollment with proration | Phase 3: proration in rate engine |
| 45–46 | Seasonal services, vacation suspensions | Phase 2: ServiceSuspension entity |
| 47–51 | RAMS integration | Phase 2/3: ServiceEvent entity, RAMS sync |
| 52–56 | Cart/container management | Phase 2: Container entity |
| 57 | Container-based billing | Phase 3: CONTAINER-BASED rate type in rate engine |
| 58 | Future-dated rate/policy changes | Phase 1: RateSchedule effective dating |
| 59 | Billing adjustments for missed collections | Phase 3: ServiceEvent → AdhocCharge credit |
