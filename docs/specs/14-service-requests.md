# Service Requests

**Module:** 14 — Service Requests
**Status:** Slice B in progress (Phase 4)
**Entities:** ServiceRequest ✓, Sla ✓, ServiceRequestTypeDef ✓ (slice B); ServiceRequestCounter (internal plumbing for SR-YYYY-NNNNNN numbering)

## Slice B scope (2026-04-23)

Slice B ships **CSR-created service requests end-to-end** — intake, assign, progress, complete/cancel — plus SLA tracking, admin-side SLA configuration, and an account-detail tab. What's in and what's deferred:

**Live in slice B:**
- ✓ `ServiceRequest`, `Sla`, `ServiceRequestTypeDef` (globals + tenant-shadow pattern like `SuspensionTypeDef`) data model
- ✓ Full CSR-created lifecycle (NEW → ASSIGNED → IN_PROGRESS → PENDING_FIELD → COMPLETED | FAILED | CANCELLED) with the state machine enforced in the service layer
- ✓ SLA resolution at creation + recomputation on priority change + breach computation at completion (synchronous only — no background sweep yet)
- ✓ Per-tenant/year `SR-YYYY-NNNNNN` request-number generation via the `ServiceRequestCounter` table
- ✓ 8 seeded global type codes: `LEAK_REPORT`, `DISCONNECT`, `RECONNECT`, `START_SERVICE`, `STOP_SERVICE`, `BILLING_DISPUTE`, `METER_ISSUE`, `OTHER`
- ✓ Admin UI: `/service-requests` queue, `/service-requests/new` creation form with live SLA preview, `/service-requests/:id` detail with timeline, `/settings/slas` configuration page
- ✓ `/accounts/:id` "Service Requests" tab + sidebar nav entry
- ✓ RBAC: `service_requests` + `service_request_slas` modules seeded across preset roles (System Admin, Utility Admin, CSR, Field Technician, Read-Only)
- ✓ Row-Level Security policies for all four new tables

**Deferred (see §9 of the slice design doc):**
- Portal submission (Module 15, Phase 4.3)
- External-system routing (RAMS / Work Management / ApptorFlow) — columns reserved
- Delinquency-source SRs (Module 11 integration) — `delinquency_action_id` FK reserved
- Attachments upload UI (JSONB column reserved)
- Billing action on completion (`billing_action` + `adhoc_charge_id` reserved, Module 10)
- Background SLA breach-sweep + escalation notifications
- Repeat-detection warnings
- Fee-waiver workflow

## Overview

The Service Requests module manages the full lifecycle of customer-initiated and system-generated work items — from intake through assignment, execution, and closure. It covers CSR-created requests, portal self-service submissions, and system-generated requests from delinquency workflows (door hangers, shut-offs, reconnections). Service requests route to external field systems (RAMS for solid waste, work management for water/wastewater), and can trigger billing charges or credits on completion.

ApptorFlow orchestrates the workflow automation behind service requests — assigning, escalating, routing, and closing requests based on configurable workflows.

Primary users: CSRs, field supervisors, operations staff, billing staff (for SR-triggered charges).

## Planned Entities

### ServiceRequest (planned)

The core work item. Covers all utility service request types from initial intake to resolution.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| request_number | VARCHAR(50) | Unique per utility, human-readable |
| account_id | UUID | Nullable FK → Account (null for non-account SRs) |
| premise_id | UUID | Nullable FK → Premise |
| service_agreement_id | UUID | Nullable FK → ServiceAgreement |
| request_type | VARCHAR(100) | Type code, e.g. "START_SERVICE", "STOP_SERVICE", "LEAK_REPORT", "DOOR_HANGER", "DISCONNECT", "RECONNECT" |
| request_subtype | VARCHAR(100) | Nullable: further categorization |
| priority | ENUM | EMERGENCY, HIGH, NORMAL, LOW |
| status | ENUM | NEW, ASSIGNED, IN_PROGRESS, PENDING_FIELD, COMPLETED, CANCELLED, FAILED |
| source | ENUM | CSR, PORTAL, API, SYSTEM, DELINQUENCY_WORKFLOW |
| description | TEXT | |
| resolution_notes | TEXT | Nullable: filled on completion |
| sla_id | UUID | Nullable FK → SLA |
| sla_due_at | TIMESTAMPTZ | Calculated from SLA.response_hours at creation |
| sla_breached | BOOLEAN | Default false; set true if completed after sla_due_at |
| assigned_to | UUID | Nullable FK → User (CIS staff assignee) |
| assigned_team | VARCHAR(100) | Nullable: team or group name |
| external_system | ENUM | Nullable: RAMS, WORK_MANAGEMENT, APPTORFLOW |
| external_request_id | VARCHAR(200) | Nullable: ID in the external system |
| external_status | VARCHAR(100) | Nullable: last known status from external system |
| delinquency_action_id | UUID | Nullable FK → DelinquencyAction (Module 11) |
| billing_action | ENUM | Nullable: FEE_APPLIED, CREDIT_APPLIED, NO_ACTION |
| adhoc_charge_id | UUID | Nullable FK → AdhocCharge (Module 10) |
| attachments | JSONB | Array of `{filename, url, uploaded_at}` |
| created_by | UUID | Nullable FK → User |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| cancelled_at | TIMESTAMPTZ | |

**Status transitions:** NEW → ASSIGNED → IN_PROGRESS → PENDING_FIELD → COMPLETED | FAILED | CANCELLED

**Indexes:** `[utility_id, account_id, status]`, `[utility_id, request_type, status]`, `[utility_id, sla_due_at]` (partial: WHERE status NOT IN ('COMPLETED','CANCELLED'))

---

### SLA (planned)

Service level agreement definitions by request type and priority. Used to calculate due dates and track breaches.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| request_type | VARCHAR(100) | Matches ServiceRequest.request_type |
| priority | ENUM | EMERGENCY, HIGH, NORMAL, LOW |
| response_hours | DECIMAL(5,2) | Target time from creation to assignment |
| resolution_hours | DECIMAL(5,2) | Target time from creation to completion |
| escalation_hours | DECIMAL(5,2) | Nullable: hours before escalation notification |
| escalation_user_id | UUID | Nullable FK → User (who to notify on escalation) |
| is_active | BOOLEAN | |
| created_at | TIMESTAMPTZ | |

**Unique constraint:** `[utility_id, request_type, priority]`

---

## API Endpoints

### Service Requests

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/v1/service-requests` | Cursor-paginated list. Filters: type, status, priority, accountId, premiseId, assignedTo, slaStatus (on_time / at_risk / breached), dateFrom, dateTo, q | ✓ slice B |
| POST | `/api/v1/service-requests` | Create — server mints `request_number`, sets `source=CSR`, resolves SLA | ✓ slice B |
| GET | `/api/v1/service-requests/:id` | Detail with relations (account, premise, agreement, assignee, sla, creator) | ✓ slice B |
| PATCH | `/api/v1/service-requests/:id` | Update description / priority / subtype; priority change recomputes `sla_due_at` | ✓ slice B |
| POST | `/api/v1/service-requests/:id/assign` | Body `{ assignedTo?, assignedTeam? }`; auto-transitions NEW → ASSIGNED | ✓ slice B |
| POST | `/api/v1/service-requests/:id/transition` | Body `{ toStatus, notes? }` for non-terminal transitions + FAILED | ✓ slice B |
| POST | `/api/v1/service-requests/:id/complete` | Body `{ resolutionNotes }`; sets completedAt + slaBreached | ✓ slice B |
| POST | `/api/v1/service-requests/:id/cancel` | Body `{ reason }`; terminal | ✓ slice B |
| GET | `/api/v1/accounts/:id/service-requests` | Scoped list for account detail tab | ✓ slice B |
| GET | `/api/v1/premises/:id/service-requests` | Scoped list | ✓ slice B |
| GET | `/api/v1/service-request-types` | Active type-defs (globals + tenant, shadow-resolved) | ✓ slice B |

### SLA Management

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/v1/slas` | List SLAs, optional `requestType` filter | ✓ slice B |
| POST | `/api/v1/slas` | Create; unique on `[utility_id, request_type, priority]` | ✓ slice B |
| PATCH | `/api/v1/slas/:id` | Update hours / escalation fields | ✓ slice B |
| DELETE | `/api/v1/slas/:id` | Soft-delete (`is_active=false`) | ✓ slice B |
| GET | `/api/v1/service-requests/sla-breaches` | SRs that have breached or are at risk | deferred (use `?slaStatus=breached` on the list endpoint for slice B) |

### External System Webhooks

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| POST | `/api/v1/webhooks/rams/sr-update` | RAMS status update for a routed SR | deferred |
| POST | `/api/v1/webhooks/apptorflow/sr-update` | ApptorFlow workflow step completion | deferred |

## Business Rules

1. **Request types and routing:** Each request_type has a configured routing destination — CIS staff, RAMS, work management system, or ApptorFlow. Examples:
   - START_SERVICE, STOP_SERVICE → ApptorFlow orchestration
   - DISCONNECT, RECONNECT, DOOR_HANGER → RAMS (solid waste) or Work Management (water)
   - LEAK_REPORT, METER_ISSUE → Work Management system
   - BILLING_DISPUTE → CIS staff queue

2. **SLA calculation:** When a ServiceRequest is created, the matching SLA (by request_type + priority) is looked up. `sla_due_at = created_at + SLA.resolution_hours`. A background job evaluates open SRs at regular intervals and sets `sla_breached=true` when overdue.

3. **SLA escalation:** If `SLA.escalation_hours` is set and the SR is not completed by `created_at + escalation_hours`, a notification is sent to `SLA.escalation_user_id` (and their manager, if configured).

4. **Delinquency-generated SRs:** When Module 11 creates a DOOR_HANGER or DISCONNECT DelinquencyAction, it automatically creates a linked ServiceRequest with `source=DELINQUENCY_WORKFLOW` and sets `delinquency_action_id`. The SR's completion updates the DelinquencyAction status.

5. **RAMS routing:** SRs routed to RAMS are submitted via the RAMS API. RAMS returns an `external_request_id`. Status updates flow back via the RAMS webhook, updating `external_status`. CIS maps RAMS statuses to CIS statuses.

6. **Billing on SR completion:** Certain SR types trigger billing actions on completion. Examples:
   - RECONNECT: reconnection fee (AdhocCharge) created on completion
   - METER_TEST: testing fee created if meter tests as good (customer-requested test)
   - MISSED_COLLECTION (solid waste): credit applied on completion
   
   The SR's `billing_action` and `adhoc_charge_id` are populated on completion.

7. **Repeat detection:** Before creating a new SR, the system checks for open SRs of the same type for the same account/premise within a configurable lookback window (e.g., 30 days). If found, the CSR is warned and can link the new request to the existing one or confirm a duplicate.

8. **Attachments:** SRs can have file attachments (photos, documents). Files are stored in blob storage; the JSONB attachments field holds metadata and access URLs. Maximum 10 attachments per SR, 10 MB per file.

9. **Status audit trail:** Every status change creates an AuditLog entry. The full history of who changed what and when is preserved.

10. **Portal-submitted SRs:** When customers submit SRs via the portal (Phase 4), they are created with `source=PORTAL` and auto-assigned to the appropriate queue based on request_type. Customers receive a notification with their request_number and can track status in the portal.

11. **Transfer of service requests:** START_SERVICE and STOP_SERVICE requests trigger ApptorFlow workflows that coordinate: premise assignment/release, meter read scheduling (final read for stop, opening read for start), service agreement status transitions, and billing (final bill for stop, proration for start).

12. **Fee waivers:** If a billing action is associated with an SR but circumstances warrant waiving the fee (e.g., reconnection fee waived for hardship), an authorized user can void the AdhocCharge. Waiver requires a reason and is logged in AuditLog.

## UI Pages

All pages are planned for Phase 4.

### Service Request Queue (`/service-requests`)

- Table: request_number, type, account, premise, priority badge, status badge, assigned to, SLA due date (color-coded: green/yellow/red), created date
- Filters: type, status, priority, assignee, SLA status (on-time/at-risk/breached), date range
- Bulk assign action
- "New Service Request" button → creation form

### Service Request Detail (`/service-requests/:id`)

- Header: request number, type, status badge, priority badge, SLA countdown
- Account/premise info with links
- Timeline: status history with timestamps and actors
- Assignment panel: current assignee/team, reassign action
- External system status (RAMS/ApptorFlow) with sync button
- Resolution panel (completion form)
- Billing action section: associated AdhocCharge, waiver option
- Attachments
- Audit log

### SLA Configuration (`/settings/slas`)

- Table by request_type and priority with response/resolution hours
- Edit inline
- Breach report: historical SLA performance by type

### Account Service Request History (within Account Detail)

- Tab showing all SRs for the account with quick status view
- Create SR from account context

## Phase Roadmap

- **Phase 1 (Complete):** No service request functionality.

- **Phase 3 (Planned):** Delinquency-generated SRs for door hangers, disconnects, reconnects (Module 11 integration prerequisite).

- **Phase 4 (Planned):**
  - ServiceRequest entity + full API + admin UI
  - SLA entity + SLA tracking + escalation job
  - ApptorFlow integration for start/stop service workflows
  - RAMS routing for solid waste field work
  - Work management system routing for water/wastewater
  - Customer portal SR intake (Module 15)
  - Billing-on-completion (AdhocCharge integration)
  - Repeat detection
  - Fee waiver workflow
  - SR notification triggers (Module 13)

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 180–181 | SR intake (CSR, portal, API), types | Phase 4: ServiceRequest entity, all sources |
| 182 | SR attachments | Phase 4: JSONB attachments on ServiceRequest |
| 183 | SR subtypes | Phase 4: request_subtype field |
| 184 | SR type configuration | Phase 4: configurable request_type values |
| 185 | SR priority | Phase 4: priority ENUM (EMERGENCY/HIGH/NORMAL/LOW) |
| 186 | SR assignment | Phase 4: assigned_to, assigned_team |
| 187 | SLA tracking | Phase 4: SLA entity, sla_due_at, sla_breached |
| 188 | SLA escalation | Phase 4: escalation_hours + notification |
| 189–192 | Routing to RAMS/work systems, bi-directional updates | Phase 4: external_system routing + webhooks |
| 193–194 | SR lifecycle management, repeat detection | Phase 4: status machine + duplicate check |
| 195 | Dispute handling | Phase 4: BILLING_DISPUTE request type |
| 196 | SR audit trail | Phase 4: AuditLog integration |
| 197 | Customer notifications on SR updates | Phase 4: Module 13 triggers on status changes |
| 198–199 | Delinquency work orders | Phase 3: DelinquencyAction → ServiceRequest |
| 200–202 | Charges/credits on completion, fee waivers, notifications | Phase 4: billing_action + AdhocCharge + waiver |
