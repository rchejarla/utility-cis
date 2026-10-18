# Reporting and Audit

**Module:** 17 — Reporting and Audit
**Status:** Partially Built
**Entities:** AuditLog (built), Attachment (built — Phase 2)

## Overview

The Reporting and Audit module provides the transparency, accountability, and operational insight layer for the Utility CIS. It is built on two foundations: the AuditLog entity — which captures every entity state change across the system — and the internal event bus — which emits domain events that other modules and external systems subscribe to. Future phases extend this foundation with configurable custom reports, operational dashboards, exception queues, and aging analytics.

Primary users: utility administrators, finance staff, auditors, operations managers, system administrators.

## Entities

### AuditLog (Built)

Every entity state change in the CIS system is captured in AuditLog by `packages/api/src/lib/audit-wrap.ts`, which writes the audit row inside the same transaction as the change itself, so the two commit or fail together. No CIS entity is modified without a corresponding audit entry.

That last sentence is an intent, not a guarantee the code enforces: `deleteContact` wrote no audit row at all until it was found during unrelated work, taking an `_actorId` it discarded. Deletion is the case where the audit row is the only surviving evidence, so a write path that skips it loses the record outright. When adding a delete, follow `deleteContact` or `deleteBillMessage`: read the prior state, then delete and `writeAuditRow` in one transaction, with `afterState` null.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced) |
| entity_type | VARCHAR(100) | Name of the entity changed, e.g. "RateSchedule", "Account" |
| entity_id | UUID | PK of the changed entity |
| action | ENUM | CREATE, UPDATE, DELETE |
| actor_id | UUID | User who performed the action (from JWT). Null for scheduler-driven changes, which identify themselves in `actor_name` instead |
| entity_type | — | Must be one of `AUDIT_ENTITY_TYPES` in `packages/shared/src/events/index.ts`. Two schedulers wrote snake_case (`service_request`, `service_suspension`) while the request-driven paths for the same entity wrote PascalCase, because they bypass `audit-wrap` with a raw `createMany` — so one entity's history was split across two spellings and the SLA-breach sweeper's rows never appeared on the service request's own Audit tab, which filters on `ServiceRequest`. The writers now agree, and the existing dev rows were corrected in place rather than the old spellings being kept as aliases |
| actor_name | VARCHAR(255) | The actor's name **at the time of the change** — denormalized on purpose, so history survives a rename or a deleted user. Required by `AuditContext`; see below |
| source | VARCHAR(100) | `user:<cisUserId>` or `scheduler:<queue-name>`. The retention sweep filters on `source LIKE 'scheduler:%'` so user audits stay outside its scope |
| before_state | JSONB | Full entity state before change (null on CREATE) |
| after_state | JSONB | Full entity state after change (null on DELETE) |
| metadata | JSONB | Contextual data: IP address, user agent, request ID, related entity info |
| created_at | TIMESTAMPTZ | When the change occurred |

**`actor_name` is required at write time, and nothing legitimately omits it.** `CisUser.name` is NOT NULL; `middleware/auth.ts:77` resolves `request.user.name` to the name claim, then the email, then `"Unknown"`, so it is never empty for a request-driven write; and scheduler writes name themselves ("SLA breach sweeper") while nulling `actor_id`.

It was nevertheless optional on `AuditContext`, and `writeAuditRow` wrote `ctx.actorName ?? undefined`, so a service that simply never passed it wrote null and nothing complained. Three did — `contact.service.ts`, `bill-document.service.ts` and (as a loose type only) `bill-message.service.ts`. Every `BillDocument` row in the dev database had lost its actor that way while every other entity's rows kept theirs. The field is now required, so an omission is a compile error.

The column stays nullable, because the rows already written cannot be repaired: the name they should have recorded is not recoverable, and filling it with the actor's present name would falsify exactly the point-in-time attribution the denormalization exists to preserve. `GET /api/v1/audit-log` instead returns `actorNameCurrent` for such rows — the actor's name today, resolved from `CisUser` for display only — which the UI renders muted and italic, with a tooltip saying the entry recorded no name and that today's may differ from the name held at the time. It is styled rather than labelled because the Actor column is the one that was overflowing, and a visible suffix widened the cell for a distinction that only applies to rows predating the required field.

**Indexes:** `[utility_id, entity_type, entity_id]`, `[utility_id, created_at DESC]`, `[utility_id, actor_id]`

**Retention:** AuditLog records are never deleted. They are the system of record for all state changes.

**RLS:** Row-Level Security enforced — utility_id is always set from the JWT context. Audit entries from one tenant are never visible to another.

### Attachment (Built — Phase 2)

Generic file attachment entity for document management. Any CIS entity can have associated file attachments using the `entityType` + `entityId` polymorphic pattern. Supports photos, PDFs, scanned forms, or any other document associated with a customer, account, premise, meter, or service agreement.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced) |
| entity_type | VARCHAR(100) | e.g. "Premise", "Customer", "Account", "Meter", "ServiceAgreement" |
| entity_id | UUID | PK of the associated entity |
| file_name | VARCHAR(255) | Original file name as uploaded |
| file_type | VARCHAR(100) | MIME type (e.g. "application/pdf", "image/jpeg") |
| file_size | INTEGER | File size in bytes |
| storage_path | VARCHAR(500) | Internal path in object storage |
| uploaded_by | UUID | User UUID from JWT |
| description | VARCHAR(500) | Optional description |
| created_at | TIMESTAMPTZ | |

**Indexes:** `[utility_id, entity_type, entity_id]`

**Upload limit:** 10MB per file (enforced at API layer on multipart upload).

**RLS:** Enforced — `utility_id` from JWT context. Attachments from one tenant are never visible to another.

**Supported on:** Premise, Customer, Account, Meter, ServiceAgreement detail pages — each has an Attachments tab with an Upload button in the tab bar.

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

### Attachment (Built — Phase 2)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/attachments` | List attachments for an entity (`?entityType=X&entityId=Y` required) |
| POST | `/api/v1/attachments` | Upload a file (multipart/form-data; 10MB limit) |
| GET | `/api/v1/attachments/:id/download` | Download file by attachment ID |
| DELETE | `/api/v1/attachments/:id` | Delete attachment record and associated file from storage |

**Query parameters for `GET /attachments`:**
- `entityType` — required; entity type string (e.g. "Premise")
- `entityId` — required; UUID of the entity

**Upload fields (`POST /attachments` — multipart):**
- `file` — the file binary (required; max 10MB)
- `entityType` — required
- `entityId` — required UUID
- `description` — optional

### Audit Log (Built)

| Method | Path | Description | Permission |
|--------|------|-------------|------------|
| GET | `/api/v1/audit-log` | One entity's history | `audit_log:VIEW` + **exactly one** `entityType` **and** `entityId` |
| GET | `/api/v1/audit-log` | The whole log, any filters | `audit_log:VIEW` **and** `settings:VIEW` |
| GET | `/api/v1/audit-log/entity-types` | The distinct `entity_type` values present in this tenant's log, sorted | `audit_log:VIEW` |

**Query parameters** (camelCase, as the Zod schema in `packages/api/src/routes/audit-log.ts` defines them — an earlier version of this table documented them as `entity_type`, `entity_id`, `from` and `to`, which the endpoint has never accepted; the schema is `.strict()`, so those names are rejected outright):

- `entityType` — one or more entity types, comma-separated (`Account` or `Account,Contact`). Must be in `AUDIT_ENTITY_TYPES`
- `entityId` — filter to a specific entity's history (uuid)
- `action` — one or more of CREATE | UPDATE | DELETE, comma-separated, from `AUDIT_ACTIONS` in `packages/shared/src/events/index.ts`, which the query schema and the UI filter both read
- `actorId` — filter by the user who made the change (uuid)
- `startDate` — ISO 8601 datetime
- `endDate` — ISO 8601 datetime
- `page`, `limit`, `sort`, `order`

**Authorization — two needs, one endpoint.** Five entity detail pages (account, premise, rate schedule, service agreement, service request) show an Audit tab that sends `entityType` + `entityId`; that is why the CSR and Field Technician presets hold `audit_log:VIEW`. Because every filter is optional, that same grant also answered a request with *no* filters — the entire tenant's log, including role changes, user management and settings edits — to anyone who could open an account. The sidebar hid the menu entry but could not restrict the endpoint.

An unfiltered read now additionally requires `settings:VIEW`, the key the rest of the Administration section already uses (reused rather than adding an `audit_log_all` module, which would need `tenant_module` rows for every existing tenant and a slot in every role preset). Both `entityType` and `entityId` are required to qualify as a scoped read, not either: `entityType=Role` alone would sweep exactly the table being protected. Exactly one entity type, too — the lists are multi-value now, and several types alongside one id is not one record's history, so accepting it would turn the multi-select into a way around the key. A request whose actor has no `CisUser` row is allowed through, matching `authorizationMiddleware`'s migration branch, so this endpoint does not behave differently from every other route for that caller.

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

### Attachments Tab (Built — Phase 2)

Displayed on all 5 entity detail pages: Premise, Customer, Account, Meter, ServiceAgreement.

- Lists all attachments for the current entity with file name, type, size, uploader, description, and upload date
- Upload button is in the tab bar (not inside tab content) for quick access without selecting the tab first
- Each attachment row has a Download link and a Delete button (with confirmation dialog)
- Files open/download via the `GET /api/v1/attachments/:id/download` endpoint

### Audit Log (`/audit-log`) — Built

Listed under **Administration** in the sidebar and gated there on `settings`, deliberately narrower than the endpoint's own `audit_log` key: this page reads the log unfiltered, so offering it to an `audit_log`-only holder would show a menu entry that answers 403. Those holders reach the log through the per-entity Audit tabs instead.

Three filter defects, all of the same shape — the page naming things the API does not accept — were fixed together, and all three had always been broken:

| Filter | What the page sent | What the API accepts |
|---|---|---|
| Action | `CREATED`, `UPDATED`, `DELETED`, `STATUS_CHANGED` | `CREATE`, `UPDATE`, `DELETE` |
| Date range | `dateFrom` / `dateTo` as `YYYY-MM-DD` | `startDate` / `endDate` as ISO datetimes |
| Entity type | a hardcoded list of 6 | any of the 28 types the API writes |

The query schema is `.strict()`, so the first two answered 400 rather than filtering. The action badge colours were keyed on the same wrong strings, so no badge was ever coloured. Actions now come from `AUDIT_ACTIONS` in shared, which the query schema reads too; entity types come from `AUDIT_ENTITY_TYPES` in shared, served through the endpoint above unioned with the distinct values in the data (the union covers a writer that sets `entityType` from a variable, which `bill-message.service.ts` does); and the date bounds are built from local midnight to local end-of-day, so a picked calendar day means the user's day and the `lte` end bound includes it.

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

- **Phase 2 (Partially Built):**
  - Attachment entity and API (4 endpoints: list, upload, download, delete)
  - Attachments tab on all 5 entity detail pages (Premise, Customer, Account, Meter, ServiceAgreement)
  - Still planned: Meter read domain events (import, exception, freeze), exception queue UI (see Module 08), meter inventory reconciliation report

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
