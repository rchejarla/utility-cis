# Reporting and Audit

**Module:** 17 — Reporting and Audit
**Status:** Partially Built
**Entities:** AuditLog (built)

## Overview

The Reporting and Audit module provides the transparency, accountability, and operational insight layer for the Utility CIS. It is built on two foundations: the AuditLog entity — which captures every entity state change across the system — and the internal event bus — which emits domain events that other modules and external systems subscribe to. Future phases extend this foundation with configurable custom reports, operational dashboards, exception queues, and aging analytics.

Primary users: utility administrators, finance staff, auditors, operations managers, system administrators.

## Entities

### AuditLog (Built)

Every entity state change in the CIS system is captured in AuditLog via the internal EventEmitter. No CIS entity is modified without a corresponding audit entry.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced) |
| entity_type | VARCHAR(100) | Name of the entity changed, e.g. "RateSchedule", "Account" |
| entity_id | UUID | PK of the changed entity |
| action | ENUM | CREATE, UPDATE, DELETE |
| actor_id | UUID | User who performed the action (from JWT) |
| before_state | JSONB | Full entity state before change (null on CREATE) |
| after_state | JSONB | Full entity state after change (null on DELETE) |
| metadata | JSONB | Contextual data: IP address, user agent, request ID, related entity info |
| created_at | TIMESTAMPTZ | When the change occurred |

**Indexes:** `[utility_id, entity_type, entity_id]`, `[utility_id, created_at DESC]`, `[utility_id, actor_id]`

**Retention:** AuditLog records are never deleted. They are the system of record for all state changes.

**RLS:** Row-Level Security enforced — utility_id is always set from the JWT context. Audit entries from one tenant are never visible to another.

## Internal Event System (Built — Phase 1)

The CIS uses a Node.js EventEmitter for intra-process domain events in Phase 1. The event system serves two roles:

1. **Audit log population:** Every route handler that mutates data emits a domain event after the DB write. The audit subscriber captures before/after state and writes to AuditLog.

2. **Cross-module coordination:** Events emitted by one module are consumed by another (e.g., `billing.record.generated` triggers the notification module). In Phase 1, this is synchronous via EventEmitter. Phase 3+ will use a message queue for reliability and durability.

### Domain Events (Phase 1)

| Event | Emitted by | Description |
|-------|-----------|-------------|
| `customer.created` | Customer module | New customer created |
| `customer.updated` | Customer module | Customer fields changed |
| `account.created` | Account module | New account opened |
| `account.status_changed` | Account module | Account status transition |
| `account.closed` | Account module | Account moved to CLOSED |
| `premise.created` | Premise module | New premise added |
| `premise.updated` | Premise module | Premise fields changed |
| `meter.installed` | Meter module | Meter status → ACTIVE |
| `meter.removed` | Meter module | Meter status → REMOVED |
| `service_agreement.created` | Agreement module | New agreement created |
| `service_agreement.status_changed` | Agreement module | SA status transition |
| `service_agreement.activated` | Agreement module | SA status → ACTIVE |
| `service_agreement.finalized` | Agreement module | SA status → FINAL |
| `rate_schedule.created` | Rate module | New rate schedule created |
| `rate_schedule.revised` | Rate module | New version created, old expired |
| `theme.updated` | Theme module | Tenant theme changed |

### Planned Domain Events (Phase 2+)

| Event | Module | Trigger |
|-------|--------|---------|
| `meter_read.imported` | 08 | Batch import completed |
| `meter_read.exception_flagged` | 08 | Read flagged with exception code |
| `meter_read.frozen` | 08/09 | Read locked after billing |
| `billing.cycle.started` | 09 | Billing run initiated |
| `billing.record.generated` | 09 | BillingRecord created |
| `billing.record.submitted` | 09 | Submitted to SaaSLogic |
| `billing.record.held` | 09 | Bill hold applied |
| `payment.received` | 10 | SaaSLogic payment webhook |
| `payment.reversed` | 10 | SaaSLogic reversal webhook |
| `payment_plan.created` | 10 | Payment plan established |
| `payment_plan.defaulted` | 10 | Plan missed threshold |
| `delinquency.action.created` | 11 | Delinquency tier triggered |
| `delinquency.action.resolved` | 11 | Delinquency cleared |
| `delinquency.shutoff.authorized` | 11 | Disconnect authorized |
| `service_request.created` | 14 | SR submitted |
| `service_request.completed` | 14 | SR marked complete |
| `service_request.sla_breached` | 14 | SR overdue past SLA |
| `notification.sent` | 13 | Communication delivered |
| `notification.failed` | 13 | Delivery failure |

## API Endpoints

### Audit Log (Built)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/audit-log` | Query audit log with filters |

**Query parameters:**
- `entity_type` — filter by entity type (e.g., "RateSchedule")
- `entity_id` — filter to a specific entity's history
- `action` — CREATE | UPDATE | DELETE
- `actor_id` — filter by the user who made the change
- `from` — start date (ISO 8601)
- `to` — end date (ISO 8601)
- `page`, `limit`, `sort`, `order`

**Response:** Paginated audit entries with before/after state diff highlighting in UI.

### Planned Reporting Endpoints (Phase 3+)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/reports/aging` | AR aging summary (30/60/90/120+ day buckets) |
| GET | `/api/v1/reports/billing-summary` | Billing run summary by cycle and period |
| GET | `/api/v1/reports/delinquency` | Delinquency summary by tier |
| GET | `/api/v1/reports/exception-reads` | Meter read exceptions report |
| GET | `/api/v1/reports/meter-reading` | Read completion rate by cycle |
| GET | `/api/v1/reports/revenue` | Revenue by commodity, account type, period |
| POST | `/api/v1/reports/custom` | Run a saved custom report |
| GET | `/api/v1/reports/saved` | List saved custom report definitions |
| POST | `/api/v1/reports/saved` | Save a custom report configuration |

## Business Rules

1. **Immutability:** AuditLog records are never updated or deleted. They are append-only. No `UPDATE` or `DELETE` statements are ever issued against the audit_log table.

2. **Completeness:** Every route handler in the CIS API that performs a mutation (CREATE, UPDATE, DELETE) must emit a domain event. The audit subscriber handles the persistence. Missing audit coverage is treated as a bug.

3. **Before/after state capture:** For UPDATE actions, `before_state` captures the full entity state before the DB write, and `after_state` captures the full entity state after. This allows reconstruction of the complete history of any entity at any point in time.

4. **Actor attribution:** `actor_id` is extracted from the authenticated JWT on every request. System-generated actions (e.g., automated billing run, nightly delinquency job) use a designated system user ID, recorded in AuditLog.

5. **Tenant isolation:** AuditLog has RLS enforced like all other tables. Utility A cannot query Utility B's audit entries. The `utility_id` on every AuditLog row matches the tenant from the request JWT.

6. **Sensitive field handling:** `before_state` and `after_state` should not capture raw PCI data (not stored in CIS) or unmasked SSNs. The audit serializer masks sensitive fields by a configurable list of field names before writing to `before_state`/`after_state`.

7. **Event bus reliability (Phase 3+):** When the event bus migrates from EventEmitter to a message queue (Kafka/RabbitMQ), events must be delivered at-least-once. Duplicate event handling (idempotency) is the responsibility of each subscriber.

8. **Custom report permissions:** Custom reports that expose financial data require a billing administrator role. Reports exposing PII (customer names, addresses) require appropriate role. Read-only reporting roles can run saved reports but cannot create new custom queries.

9. **Report data freshness:** Standard reports query the live PostgreSQL database. For large tenants (>50,000 accounts), reports above a configurable row threshold are queued as background jobs and results are available for download. Real-time dashboards (aging, exception counts) use materialized views updated on a configurable schedule.

10. **Audit log search performance:** The `[utility_id, entity_type, entity_id]` index supports the most common access pattern (show me the history of this specific record). The `[utility_id, created_at DESC]` index supports time-range queries. For large tenants, the audit log is expected to be the largest table in the system.

## UI Pages

### Audit Log (`/audit-log`) — Built

- Searchable, filterable table of all audit entries
- Filters: entity type (dropdown of all entity types), action (CREATE/UPDATE/DELETE), actor (user dropdown), date range picker
- Per-row: timestamp, actor name, entity type and ID, action
- Expandable row: JSON diff view of before/after state (additions in green, removals in red, unchanged collapsed)
- Deep link: clicking entity ID navigates to that entity's detail page

### Planned Reporting Pages (Phase 3+)

### Billing Dashboard with Aging (`/billing`) — Phase 3

- Integrated into Module 09 billing page
- AR aging buckets: current, 30, 60, 90, 120+ days
- Clickable buckets: drill down to account list for that aging tier
- Month-over-month trend line

### Exception Queue (`/meter-reads/exceptions`) — Phase 2

- Covered in Module 08 spec
- Read exceptions requiring review before billing

### Delinquency Dashboard (`/delinquency`) — Phase 3

- Covered in Module 11 spec
- Accounts by delinquency tier, shut-off eligibility

### Custom Reports (`/reports`) — Phase 3+

- Report library: pre-built reports (billing summary, meter read completion, revenue by commodity)
- Custom report builder: field selection, filter configuration, grouping, sorting
- Save and schedule reports
- Export: CSV, Excel, PDF

### SLA Breach Report (`/reports/sla`) — Phase 4

- Service requests past SLA due date
- Covered in Module 14 spec

## Phase Roadmap

- **Phase 1 (Complete):**
  - AuditLog entity with full schema
  - Internal EventEmitter-based event system
  - All Phase 1 domain events wired to audit log
  - Audit Log admin UI page with full filter/search
  - 18 domain events across all Phase 1 modules

- **Phase 2 (Planned):**
  - Meter read domain events (import, exception, freeze)
  - Exception queue UI (see Module 08)
  - Meter inventory reconciliation report

- **Phase 3 (Planned):**
  - Billing domain events (cycle execution, submission, holds)
  - Payment domain events (received, reversed, plan events)
  - Delinquency domain events
  - AR aging dashboard (integrated in Module 09/10)
  - Delinquency reporting (integrated in Module 11)
  - Pre-built operational reports (billing summary, revenue, meter read completion)
  - Message queue migration (Kafka or RabbitMQ) for event bus reliability

- **Phase 4 (Planned):**
  - Service request domain events
  - SLA breach reporting
  - Custom report builder
  - Report scheduling and export

- **Phase 5 (Planned):**
  - Special assessment reporting (collections, delinquency by district)

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 7 | Audit GIS overrides | AuditLog captures all field changes with actor |
| 26 | Consolidated account history view | Audit log + entity-scoped audit queries |
| 33 | Communication history | CommunicationLog (Module 13); linked from audit |
| 88 | Audit trail for meter reads | AuditLog on all MeterRead changes |
| 100 | Exception reports | Phase 2: exception queue + summary report |
| 149–150 | Aging dashboard (real-time) | Phase 3: AR aging from SaaSLogic data |
| 178 | Audit trail for assessments | AuditLog on ParcelAssessment and installment changes |
| 196 | SR audit trail | AuditLog on ServiceRequest state changes |
