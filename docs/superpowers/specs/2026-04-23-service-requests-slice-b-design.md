# Module 14 — Service Requests, Slice B (Design)

**Date:** 2026-04-23
**Module:** 14 — Service Requests
**Scope:** First vertical slice: CSR-created service requests end-to-end, including SLA entity and due-date calculation. No portal intake, no external-system routing, no attachments, no billing-on-completion, no breach background job, no delinquency integration.
**Source spec:** `docs/specs/14-service-requests.md`
**Related specs:** `docs/specs/11-delinquency.md` (integration deferred), `docs/specs/15-customer-portal.md` (Phase 4.3 consumer, deferred).

---

## 1. Goals and non-goals

### Goals

- Give CSRs a working admin-side queue to intake, assign, progress, and close service requests.
- Establish the data model (`ServiceRequest`, `Sla`, `ServiceRequestTypeDef`) so later slices can layer in attachments, external routing, portal intake, billing actions, and breach automation without schema churn.
- Compute `sla_due_at` at request creation when a matching SLA exists, and surface an SLA countdown in the UI.
- Let tenant admins manage SLA targets per request type × priority.
- Produce an audit trail (every mutation → `AuditLog`) and render a per-request timeline from it.

### Non-goals (this slice)

- Portal submission (Module 15, Phase 4.3).
- External-system routing (RAMS, Work Management, ApptorFlow).
- Delinquency-source service requests (Module 11 integration).
- Attachment uploads (column reserved, UI deferred).
- Billing action on completion (columns reserved, Module 10 integration deferred).
- Background SLA breach-sweep job and escalation notifications.
- Repeat-detection warnings.
- Fee-waiver workflow.

These columns/enums are provisioned in the schema so later slices do not need migrations for them; they simply remain null/unused this slice.

---

## 2. Data model

Three new Prisma models live in `packages/shared/prisma/schema.prisma`. All tenant-scoped tables include `utility_id` and carry matching Row-Level Security policies aligned to the existing pattern (`utility_id = current_setting('app.current_utility_id')::uuid`).

### 2.1 `ServiceRequestTypeDef` (reference table)

Follows the same pattern as `SuspensionTypeDef` — rows with `utility_id=NULL` are global (visible to every tenant), rows with a specific `utility_id` are tenant-local and shadow a same-code global.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `utility_id` | UUID? | Null for global seeded rows |
| `code` | VARCHAR(100) | E.g. `LEAK_REPORT`; auto-uppercased |
| `label` | VARCHAR(150) | Human-readable |
| `description` | TEXT? | Optional CSR hint |
| `category` | VARCHAR(50)? | Optional grouping |
| `sort_order` | INT | Default 100 |
| `is_active` | BOOL | Default true |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Unique:** `[utility_id, code]`. **Index:** `[is_active, sort_order]`.

**Seeded globals** (`utility_id=NULL`): `START_SERVICE`, `STOP_SERVICE`, `LEAK_REPORT`, `DISCONNECT`, `RECONNECT`, `BILLING_DISPUTE`, `METER_ISSUE`, `OTHER`.

### 2.2 `Sla`

Service level agreement per request type × priority.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `utility_id` | UUID | Tenant scope (required) |
| `request_type` | VARCHAR(100) | String key into `ServiceRequestTypeDef.code` |
| `priority` | `ServiceRequestPriority` | EMERGENCY / HIGH / NORMAL / LOW |
| `response_hours` | DECIMAL(5,2) | Target time from creation to assignment |
| `resolution_hours` | DECIMAL(5,2) | Target time from creation to completion |
| `escalation_hours` | DECIMAL(5,2)? | Optional (not used this slice) |
| `escalation_user_id` | UUID? FK → CisUser | Optional (not used this slice) |
| `is_active` | BOOL | Default true; soft-delete via false |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

**Unique:** `[utility_id, request_type, priority]`. **Index:** `[utility_id, is_active]`.

No FK from `Sla.request_type` to `ServiceRequestTypeDef.code`: the spec uses VARCHAR and we preserve that flexibility so type-code changes don't cascade. The UI validates against the typedef list; the API validates `request_type` is a known code at write time.

### 2.3 `ServiceRequest`

All spec columns from `docs/specs/14-service-requests.md` are included in the schema; some remain null/empty this slice.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (PK) | |
| `utility_id` | UUID | |
| `request_number` | VARCHAR(50) | Format `SR-YYYY-NNNNNN`; per-tenant, per-year counter |
| `account_id` | UUID? FK → Account | Nullable (non-account SRs allowed) |
| `premise_id` | UUID? FK → Premise | |
| `service_agreement_id` | UUID? FK → ServiceAgreement | |
| `request_type` | VARCHAR(100) | Validated against `ServiceRequestTypeDef` |
| `request_subtype` | VARCHAR(100)? | Free text |
| `priority` | `ServiceRequestPriority` | |
| `status` | `ServiceRequestStatus` | Default NEW |
| `source` | `ServiceRequestSource` | Default CSR (enforced this slice) |
| `description` | TEXT | Required |
| `resolution_notes` | TEXT? | Required to complete |
| `sla_id` | UUID? FK → Sla | |
| `sla_due_at` | TIMESTAMPTZ? | Set at creation if matching SLA exists |
| `sla_breached` | BOOL | Default false; computed at completion (no background job this slice) |
| `assigned_to` | UUID? FK → CisUser | |
| `assigned_team` | VARCHAR(100)? | |
| `external_system` | `ServiceRequestExternalSystem`? | Reserved; null this slice |
| `external_request_id` | VARCHAR(200)? | Reserved |
| `external_status` | VARCHAR(100)? | Reserved |
| `delinquency_action_id` | UUID? FK → DelinquencyAction | Reserved |
| `billing_action` | `ServiceRequestBillingAction`? | Reserved |
| `adhoc_charge_id` | UUID? FK | Reserved (future FK to AdhocCharge when Module 10 lands) |
| `attachments` | JSONB | Default `[]`; no UI this slice |
| `created_by` | UUID? FK → CisUser | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ? | |
| `cancelled_at` | TIMESTAMPTZ? | |

**Unique:** `[utility_id, request_number]`.

**Indexes:**
- `[utility_id, account_id, status]`
- `[utility_id, request_type, status]`
- `[utility_id, sla_due_at]` — partial: `WHERE status NOT IN ('COMPLETED','CANCELLED','FAILED')`
- `[utility_id, assigned_to, status]` — supports "my queue" filter

### 2.4 New Prisma enums

```
ServiceRequestStatus: NEW, ASSIGNED, IN_PROGRESS, PENDING_FIELD, COMPLETED, CANCELLED, FAILED
ServiceRequestPriority: EMERGENCY, HIGH, NORMAL, LOW
ServiceRequestSource: CSR, PORTAL, API, SYSTEM, DELINQUENCY_WORKFLOW
ServiceRequestExternalSystem: RAMS, WORK_MANAGEMENT, APPTORFLOW
ServiceRequestBillingAction: FEE_APPLIED, CREDIT_APPLIED, NO_ACTION
```

### 2.5 Request number generation

Format: `SR-YYYY-NNNNNN` — e.g. `SR-2026-000042`.

Per-tenant, per-year counter. Implementation: Postgres sequence is awkward under RLS; use a small `service_request_counter(utility_id UUID, year INT, next_value BIGINT)` table with `SELECT ... FOR UPDATE` inside the creation transaction. Counter rows are created on first use per (tenant, year). Tests assert uniqueness under concurrency via explicit parallel inserts.

---

## 3. API surface

All routes live in `packages/api/src/routes/`, services under `packages/api/src/services/`, Zod schemas and DTOs in `packages/shared/src/`. All mutations write an `AuditLog` row (the detail timeline reads from it).

### 3.1 `service-request-types.ts`

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/service-request-types` | Returns active types for this tenant (globals + local, shadow-resolved by code), ordered by `sort_order`, `code`. |

No create/update/delete yet — seeding covers it. Admin UI for type configuration is a later slice.

### 3.2 `slas.ts`

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/slas` | List SLAs for tenant, optionally filtered by `requestType`. |
| POST | `/api/v1/slas` | Create. Enforces unique `[utility_id, request_type, priority]`. |
| PATCH | `/api/v1/slas/:id` | Update hours / escalation fields. |
| DELETE | `/api/v1/slas/:id` | Soft-delete (`is_active=false`). |

### 3.3 `service-requests.ts`

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/service-requests` | Cursor-paginated list. Filters: `type`, `status[]`, `priority[]`, `accountId`, `premiseId`, `assignedTo`, `slaStatus` (on-time / at-risk / breached), `dateFrom`, `dateTo`, `q` (text match on request_number / description). |
| POST | `/api/v1/service-requests` | Create. Server generates `request_number`, sets `status=NEW`, `source=CSR`, resolves SLA by `(request_type, priority)`, sets `sla_due_at = created_at + resolution_hours`. |
| GET | `/api/v1/service-requests/:id` | Detail with inline relations (account, premise, agreement, assignee, sla, createdBy) and audit-log timeline. |
| PATCH | `/api/v1/service-requests/:id` | Editable: `description`, `priority`, `request_subtype`. Priority change recomputes `sla_due_at`. |
| POST | `/api/v1/service-requests/:id/assign` | Body `{ assignedTo?, assignedTeam? }`. Auto-transitions `NEW → ASSIGNED`. |
| POST | `/api/v1/service-requests/:id/transition` | Body `{ toStatus, notes? }`. Used for non-terminal transitions (ASSIGNED → IN_PROGRESS, IN_PROGRESS ↔ PENDING_FIELD) and for `toStatus=FAILED`. Notes, if provided, are appended to `resolution_notes`. |
| POST | `/api/v1/service-requests/:id/complete` | Body `{ resolutionNotes }`. Only path to `COMPLETED`; requires notes. Sets `completed_at`, writes `sla_breached = completed_at > sla_due_at`. Terminal. |
| POST | `/api/v1/service-requests/:id/cancel` | Body `{ reason }`. Only path to `CANCELLED`; requires reason. Sets `cancelled_at`, appends reason to `resolution_notes`. Terminal. |
| GET | `/api/v1/accounts/:id/service-requests` | Scoped list for account detail tab. |
| GET | `/api/v1/premises/:id/service-requests` | Scoped list. |

### 3.4 State machine (enforced in service layer)

```
NEW           → ASSIGNED, CANCELLED
ASSIGNED      → IN_PROGRESS, CANCELLED
IN_PROGRESS   → PENDING_FIELD, COMPLETED, FAILED, CANCELLED
PENDING_FIELD → IN_PROGRESS, COMPLETED, FAILED
COMPLETED     → (terminal)
FAILED        → (terminal)
CANCELLED     → (terminal)
```

Invalid transitions return `409 Conflict` with the current status in the error body.

### 3.5 Agreement label format

A shared helper `formatAgreementLabel(agreement)` in `packages/shared/src/` returns:

```
`${agreementNumber} · ${commodity.name} · ${premise.addressLine1}`
```

Used consistently by the creation form's agreement dropdown, the detail page's context panel, and the account tab's SR list, so agreements read the same everywhere.

### 3.6 RBAC

New `service_requests` module in `MODULES` with permissions `VIEW`, `CREATE`, `EDIT`, `CANCEL`.

Seeded role assignments:
- **System Admin:** all
- **Utility Admin:** all
- **CSR:** VIEW, CREATE, EDIT, CANCEL
- **Field Technician:** VIEW, EDIT (can assign/transition but not create/cancel)
- **Read-Only:** VIEW
- **Portal Customer:** none (this slice)

SLA management is gated by a separate module `service_request_slas` with VIEW/EDIT — seeded to System Admin + Utility Admin only.

---

## 4. UI pages

All pages follow the existing Indigo Wash aesthetic — reuse existing tokens, DM Sans, existing components, standard list/detail patterns. No new typefaces or accent colors.

### 4.1 `/service-requests` (queue)

- Table columns: Request #, Type, Account (linked), Premise (linked), Priority badge, Status badge, Assigned, SLA countdown, Created.
- SLA countdown cell: `ok` (green) if >50% time remaining, `warn` (amber) if <50%, `breach` (red) if past due or `sla_breached=true`. Terminal statuses show `—`.
- Filter bar: type (dropdown from `service-request-types`), status multi-select, priority multi-select, assignee, SLA status (on-time/at-risk/breached), date range.
- Cursor pagination, 50/page.
- "New Service Request" button → `/service-requests/new`.

### 4.2 `/service-requests/new` (create)

- **Who / where card:** account (typeahead via existing `SearchableEntitySelect`), premise (auto-filled from account, override), service agreement (hidden if 0 active agreements; read-only pill if 1; dropdown if 2+, using `formatAgreementLabel`).
- **Request details card:** type (dropdown from `/service-request-types`), subtype (free text), priority (radio group, default NORMAL), description (textarea, required).
- **SLA preview card (right column):** looks up matching SLA by `(type, priority)`, shows response/resolution hours and computed `due at`. Missing SLA shows an amber "No SLA configured" note. Recalculates as type/priority change.
- **On-create summary card:** bullet list of what happens on submit.
- Submit → POST; redirect to `/service-requests/:id`.

### 4.3 `/service-requests/:id` (detail)

- **Header:** request number + type, status badge, priority badge, SLA countdown pill, Edit / Cancel buttons.
- **Left column:** context card (account, premise, agreement, subtype, source, created, SLA due), description card, resolution card. The resolution card has a single `resolutionNotes` textarea with two buttons: "Mark Completed" (POSTs `/complete` with the notes — required) and "Mark Failed" (POSTs `/transition` with `toStatus=FAILED` and the notes — optional). Card is hidden once the request is in a terminal state (notes render read-only in its place).
- **Right column:** assignment card (current assignee + team, reassign form), status actions card (only the valid next-states per state machine, excluding COMPLETED / FAILED / CANCELLED which are driven from the resolution and header cards), timeline card (status changes, assignments, edits from AuditLog).
- Hidden this slice: attachments panel, external system panel, billing action panel. Columns exist; UI deferred.

### 4.4 `/settings/slas`

- One card per request type, titled `CODE · label`, showing count of priorities covered.
- Each card has a table with one row per priority, columns for `response_hours`, `resolution_hours`, `escalation_hours`, `escalation_user_id`. Empty cells render `—`.
- Inline-edit cells (matches existing `/settings/*` editor pattern).
- "+ Add priority row" per-card for uncovered priorities. "+ Add type coverage" at top-right to add a new type's first SLA row.
- Footer note explicitly calls out that the breach-sweep job is deferred in this slice.

### 4.5 Account detail — "Service Requests" tab

- New tab in `/accounts/:id`. Reuses the queue table component in scoped mode.
- "New Request for this Account" button pre-fills the account on `/service-requests/new`.

### 4.6 Navigation

Add **"Service Requests"** to the sidebar under the operations grouping, between Meter Reads and Billing Cycles.

---

## 5. Seed data (`seed.js`)

- 8 global `ServiceRequestTypeDef` rows (`utility_id=NULL`): the types from §4.2.
- New roles/module entries: `service_requests` module + `service_request_slas` module; default permission matrix per §3.6.
- ~8 `Sla` rows for the dev tenant: LEAK_REPORT (all 4 priorities), DISCONNECT (HIGH / NORMAL / LOW), BILLING_DISPUTE (NORMAL). Hours match the SLA settings mockup.
- ~3 demo `ServiceRequest` rows referencing existing seeded accounts/premises so the queue isn't empty on first load — one IN_PROGRESS (breached), one NEW, one COMPLETED.

---

## 6. Test plan

Following existing patterns in `packages/api/src/__tests__/`. Target: ~35–45 new tests, keeps suite green (currently 352 passing).

### 6.1 Service-layer tests

`service-request.service.test.ts`:
- Request-number generation: sequential, zero-padded, year-aware, unique under concurrent inserts.
- State machine: every valid transition succeeds; every invalid transition returns structured error.
- SLA resolution: matches existing SLA sets `sla_id` + `sla_due_at`; missing SLA leaves both null.
- Completion: `sla_breached` computed correctly when due before/after completion; no breach when `sla_due_at` is null.
- Priority change on PATCH: recomputes `sla_due_at`.
- Assign triggers `NEW → ASSIGNED` auto-transition; no-op from other states.

`sla.service.test.ts`:
- CRUD happy path.
- Unique constraint violation on duplicate `[request_type, priority]`.
- Soft-delete (`is_active=false`) excluded from list by default.

### 6.2 Route tests

`service-requests.routes.test.ts`:
- Auth required on every endpoint.
- RBAC: CSR can create/edit/cancel; Portal Customer 403 on all; Read-Only can GET but not POST/PATCH; cross-tenant returns 404.
- Filter combinations: type, status, priority, assignee, SLA status, date range, text search.
- Cursor pagination: stable order, no gaps on mutation, correct `nextCursor`.

### 6.3 SLA route tests

`slas.routes.test.ts`:
- List, create, patch, soft-delete.
- Unique-violation surfaces as 409.

### 6.4 Shared schema tests

`packages/shared/src/__tests__/`:
- Zod schemas reject invalid payloads.
- `formatAgreementLabel` formats correctly with and without commodity/premise present.

---

## 7. Documentation updates

Per `CLAUDE.md` doc-maintenance rules:

- **`docs/specs/14-service-requests.md`** — flip status from "Stub" to "Slice B in progress". Mark each field/endpoint/business-rule with "✓ slice B" or "deferred" annotations so future sessions know what's live.
- **`docs/design/utility-cis-architecture.md`** — add the three new entities + five new enums to the master data model and update entity counts.
- **`docs/specs/00-data-model-overview.md`** — add `ServiceRequest`, `Sla`, `ServiceRequestTypeDef` to the entity index.

---

## 8. Rollout

Single branch, single PR. No feature flag — admin-only, portal untouched.

1. Run `prisma migrate dev --name add_service_requests_slice_b`.
2. Reseed dev DB (`seed_db.bat`) — resets demo SRs and SLAs.
3. Smoke test: log in as dev CSR, create a request, assign it, transition it, complete it. Verify SLA countdown colors. Edit an SLA in `/settings/slas`. Open the account detail "Service Requests" tab.
4. Run `pnpm turbo typecheck test` — expect 387–397 tests green across shared/api/web.
5. Commit + push to `main`. Update `CLAUDE.md` memory resume note with slice-B status.

## 9. What's explicitly deferred (with reason)

| Deferred feature | Why | Future slice |
|---|---|---|
| Attachments upload UI | JSONB column reserved; upload/storage plumbing deserves its own slice. | Slice C |
| SLA breach background job | Scheduler work + notification template design belongs with Module 13 integration. | Slice C or D |
| Portal intake | Needs Module 15 Phase 4.3 UI work; data model is ready. | Portal 4.3 |
| External system routing (RAMS / Work Mgmt / ApptorFlow) | Each needs its own integration contract; out of scope for MVP. | Separate slices per system |
| Delinquency-source SRs | Module 11 integration point; requires DelinquencyAction → SR creation hook. | When Module 11 work resumes |
| Billing-on-completion | Module 10 AdhocCharge doesn't exist yet. | After Module 10 lands |
| Repeat detection | UX + threshold-tuning deserves its own design. | Slice C |
| Fee-waiver workflow | Depends on billing-on-completion. | After billing-on-completion |

---

## 10. Open questions

None at spec-approval time. Assumptions to revisit during implementation:

- Request number format is `SR-YYYY-NNNNNN`. If a tenant wants per-tenant prefixes, we'll add a `TenantConfig.srNumberPrefix` field.
- "At-risk" threshold for SLA status filter is <50% of resolution window. If that feels wrong in practice, it's one-line tuning.
- Field Technician gets EDIT on service requests (to assign/transition) but not CREATE/CANCEL. If CSRs want techs to create-on-behalf, we'll widen the permission.
- `assigned_team` is free-text in this slice (no lookup table). A `Team` entity with members can come later if ops want it; the VARCHAR column stays the same.
