# Solid Waste

**Module:** 12 — Solid Waste
**Status:** Stub (Phase 2)
**Entities:** Container (planned), ServiceSuspension (planned), ServiceEvent (planned)

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

### ServiceSuspension (planned)

Temporary suspension of a solid waste (or other) service. Covers vacation holds and seasonal service suspensions.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| suspension_type | ENUM | VACATION_HOLD, SEASONAL, TEMPORARY, DISPUTE |
| status | ENUM | PENDING, ACTIVE, COMPLETED, CANCELLED |
| start_date | DATE | When service suspension begins |
| end_date | DATE | When service resumes (nullable = indefinite) |
| billing_suspended | BOOLEAN | Whether charges are suspended during hold |
| prorate_on_start | BOOLEAN | Whether to prorate the bill for the suspension start period |
| prorate_on_end | BOOLEAN | Whether to prorate the bill for the suspension end period |
| reason | TEXT | Nullable |
| requested_by | UUID | FK → User or null (customer self-service, Phase 4) |
| approved_by | UUID | Nullable FK → User |
| rams_notified | BOOLEAN | Whether RAMS has been updated about the suspension |
| rams_notified_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

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
| GET | `/api/v1/service-suspensions` | List suspensions (filterable by agreement, status, date) |
| POST | `/api/v1/service-suspensions` | Create vacation hold or seasonal suspension |
| GET | `/api/v1/service-suspensions/:id` | Get suspension detail |
| PATCH | `/api/v1/service-suspensions/:id` | Update dates or cancel |
| POST | `/api/v1/service-suspensions/:id/complete` | Mark suspension ended (if end_date was open) |
| GET | `/api/v1/service-agreements/:id/suspensions` | All suspensions for an agreement |

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

## UI Pages

All pages are planned for Phase 2 (container management) and Phase 3 (RAMS events, billing integration).

### Container Management (`/containers`)

- Table: premise address, container type, size, quantity, status, delivery date, RAMS ID
- Filters: type, size, status, premise
- "Assign Container" button → assignment form with premise lookup

### Service Suspensions (`/service-suspensions`)

- Active suspensions table: agreement, type, start/end dates, billing suspended flag, RAMS notified status
- Upcoming suspensions (start in next 30 days)
- "New Suspension" → form with agreement lookup, type, dates

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

- **Phase 2 (Planned):**
  - Container entity + CRUD API + UI
  - Container assignment to service agreements
  - Container swap tracking and mid-cycle billing proration (rate engine prerequisite in Phase 3)
  - ServiceSuspension entity + vacation hold / seasonal management
  - RAMS integration foundation: service event endpoint, RAMS container ID mapping

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
