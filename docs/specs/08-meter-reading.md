# Meter Reading

**Module:** 08 — Meter Reading
**Status:** Phase 2 — CRUD + exception queue + import center UI complete; rollover detection + correction chain landed; bulk import backend and configurable thresholds are follow-ups
**Entities:** MeterRead, MeterEvent, ImportBatch

## Overview

The Meter Reading module ingests, validates, and manages all consumption readings from utility meters. It serves as the bridge between physical meter data (manual reads, AMR drive-by, AMI interval data) and the billing engine. Accurate, auditable reads are foundational — this module must handle estimated reads, exception detection, corrected reads, and the locking of reads after billing to prevent retroactive tampering.

Primary users: field meter readers, AMI system integrations, billing clerks, operations supervisors.

## Entities

### MeterRead

Every reading associated with a meter. Stored in a TimescaleDB hypertable, partitioned by `read_datetime`, enabling efficient time-series queries at scale.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced) |
| meter_id | UUID | FK → Meter |
| register_id | UUID | Nullable FK → MeterRegister (for multi-register meters) |
| read_event_id | UUID | Nullable: groups sibling reads from the same read event on a multi-register meter. All rows written for one physical read visit share this id. Nullable so legacy/single-register rows don't need backfilling. |
| service_agreement_id | UUID | FK → ServiceAgreement (active at time of read) |
| read_date | DATE | Calendar date of read |
| read_datetime | TIMESTAMPTZ | Hypertable partition key; precise time for AMI |
| reading | DECIMAL(12,4) | Raw dial reading as recorded |
| prior_reading | DECIMAL(12,4) | Previous read value for consumption calculation |
| consumption | DECIMAL(12,4) | Calculated: (reading - prior_reading) × multiplier |
| read_type | ENUM | ACTUAL, ESTIMATED, CORRECTED, FINAL, AMI |
| read_source | ENUM | MANUAL, AMR, AMI, CUSTOMER_SELF, SYSTEM |
| exception_code | VARCHAR(50) | Nullable: HIGH_USAGE, ZERO_USAGE, METER_DEFECT, REVERSE_FLOW, ROLLOVER |
| exception_notes | TEXT | Nullable: free-text explanation from reader or system |
| is_frozen | BOOLEAN | True after billing cycle processes this read; blocks edits |
| billed_at | TIMESTAMPTZ | Nullable: timestamp when billing used this read |
| reader_id | UUID | Nullable FK → User (for MANUAL reads) |
| import_batch_id | UUID | Nullable: groups reads from the same import file |
| corrects_read_id | UUID | Nullable self-reference: for CORRECTED reads, points to original |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Hypertable:** Partitioned by `read_datetime`, 1-month chunks. Requires TimescaleDB extension.

**Indexes:** `[utility_id, meter_id, read_date DESC]`, `[utility_id, service_agreement_id, read_date DESC]`, `[utility_id, exception_code]` (partial: WHERE exception_code IS NOT NULL), `[import_batch_id]`, `[utility_id, read_event_id]` (partial: WHERE read_event_id IS NOT NULL) — so fetching sibling reads for one event is one index lookup.

**Unique constraint:** `[meter_id, register_id, read_datetime, read_source]` — prevents duplicate imports of the same reading.

## Planned Supporting Entities

### ExceptionThreshold (configuration, planned)

Tenant-configurable rules that determine when a read is flagged as an exception.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| commodity_id | UUID | Nullable FK → Commodity (null = all commodities) |
| account_type | ENUM | Nullable: RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL |
| rule_type | ENUM | HIGH_USAGE_PERCENT, HIGH_USAGE_ABSOLUTE, ZERO_USAGE, REVERSE_FLOW, CONSECUTIVE_ESTIMATE |
| threshold_value | DECIMAL(10,4) | Meaning depends on rule_type |
| is_active | BOOLEAN | |
| created_at | TIMESTAMPTZ | |

Example: `rule_type=HIGH_USAGE_PERCENT, threshold_value=200` means flag any read where consumption is more than 200% of the prior 12-month average for that meter.

### ImportBatch (planned)

Tracks bulk read imports for reconciliation and error handling.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| source | ENUM | AMR, AMI, MANUAL_UPLOAD, API |
| file_name | VARCHAR(500) | Nullable: original filename for file uploads |
| record_count | INTEGER | Total records in import |
| imported_count | INTEGER | Successfully imported |
| exception_count | INTEGER | Reads flagged with exceptions |
| error_count | INTEGER | Records that failed to import |
| status | ENUM | PENDING, PROCESSING, COMPLETE, FAILED |
| errors | JSONB | Array of {row, error_code, message} |
| created_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |

## API Endpoints

| Method | Path | Status | Description |
|--------|------|--------|-------------|
| GET | `/api/v1/meter-reads` | live | List reads (filterable by meter, date range, type, exception, frozen state) |
| POST | `/api/v1/meter-reads` | live | Create a single meter read. `serviceAgreementId` is optional in the request body — the service resolves it from `ServiceAgreementMeter` using meter id + read date, erroring with `METER_NOT_ASSIGNED` if no active assignment exists at that date. |
| GET | `/api/v1/meter-reads/:id` | live | Get read detail with meter, agreement, account, premise, commodity, and register hydrated |
| PATCH | `/api/v1/meter-reads/:id` | live | Correct a read. Does NOT mutate the original row — creates a new `CORRECTED` row with `correctsReadId` pointing at the original. Returns 201 with the new row. |
| DELETE | `/api/v1/meter-reads/:id` | live | Hard-delete a read. Guarded: frozen (billed) reads cannot be deleted, and reads that have been corrected by a subsequent CORRECTED row cannot be deleted without first deleting the correction. Emits a domain event with the before-state so the audit log preserves a record of the deletion. |
| GET | `/api/v1/meters/:id/reads` | live | All reads for a specific meter, newest first |
| GET | `/api/v1/meter-reads/exceptions` | live | Exception queue: reads flagged for review (non-frozen with an `exceptionCode`) |
| POST | `/api/v1/meter-reads/:id/resolve-exception` | live | Mark exception resolved (approve / hold for re-read / estimate). Errors with `READ_FROZEN` if the read is already billed. |
| POST | `/api/v1/meter-reads/import` | planned | Bulk import backend (file parser + ImportBatch job runner). The UI at `/meter-reads/import` exists and exercises the flow via client-side CSV/JSON parsing, but the server-side commit endpoint is Phase 3. |
| GET | `/api/v1/meter-reads/import/:batchId` | planned | Import batch status and error report |
| GET | `/api/v1/exception-thresholds` | planned | Exception threshold rules (Phase 3) |
| POST/PATCH/DELETE | `/api/v1/exception-thresholds` | planned | CRUD for tenant-configurable threshold rules (Phase 3) |

### Meter list query enhancement

`/api/v1/meters` now accepts a `search` query parameter that does a case-insensitive substring match against `meter_number`. Used by the meter picker in the read-entry form for server-side search instead of loading every meter into a dropdown.

### Import Endpoint

`POST /api/v1/meter-reads/import` accepts:
- `multipart/form-data` with a CSV or XML file
- `application/json` with an array of read records

Supported file formats (configurable per tenant):
- **CSV:** Columns map to MeterRead fields via a per-tenant column mapping configuration
- **XML/MV90:** Standard meter data exchange formats
- **JSON:** Native API format for AMI system integrations

## Business Rules

1. **Consumption calculation:** `consumption = (reading - prior_reading) × meter.multiplier`. If `register_id` is set, use `register.multiplier` instead. Stored on save; not recalculated on read.

2. **Rollover handling:** If `reading < prior_reading`, check meter dial count. If `(10^dial_count - prior_reading + reading)` is within a reasonable rollover range, treat as rollover and flag with `exception_code=ROLLOVER`. Otherwise flag as `METER_DEFECT` for human review.

3. **Estimated reads:** When a physical read is unavailable, the system generates an ESTIMATED read using the trailing 3-month average consumption for the meter. Estimation is only allowed for up to 2 consecutive billing cycles before escalating to an exception requiring field action.

4. **Read freeze after billing:** When a billing cycle processes a read, `is_frozen=true` and `billed_at` are set. Frozen reads cannot be edited or deleted. A correction requires creating a new CORRECTED read (referencing `corrects_read_id`) and triggering a rebill workflow in Phase 3.

5. **Correction audit:** Creating a CORRECTED read automatically creates an AuditLog entry capturing before/after state of both the original (now marked) and new read.

6. **Duplicate import prevention:** The unique constraint on `[meter_id, register_id, read_datetime, read_source]` prevents re-importing the same AMI interval data. Duplicate rows during import are silently skipped with a count in the batch report.

7. **Exception thresholds:** After each read is saved (single or batch), the system evaluates all active ExceptionThreshold rules for the meter's commodity and account type. Any threshold triggered sets `exception_code` and queues the read for review. Configurable per tenant (Bozeman Req 93).

8. **Exception resolution:** Reads in the exception queue must be resolved before the billing cycle will process them. Resolution options: approve as-is, replace with estimate, correct reading, or hold for field re-read.

9. **Final reads:** A read with `read_type=FINAL` marks the last read for a service agreement (associated with account closure or move-out). The billing engine will prorate charges to the `read_date`.

10. **Multi-register reads:** For meters with multiple MeterRegisters, a read event produces one `MeterRead` row per active register. The service layer generates a single `read_event_id` and attaches it to every row written for that event. A demand+usage meter on a single field visit produces two `MeterRead` rows sharing one `read_event_id`, one `read_datetime`, one reader, but distinct `register_id` and UoM. Consumption is calculated independently per register using that register's `multiplier`. See the **Multi-Register Reads** section below for full rules.

11. **Mid-cycle meter replacement:** When a meter is swapped mid-cycle, the outgoing meter receives a FINAL read and the incoming meter receives an ACTUAL read. The billing engine sums consumption from both reads for the period (Bozeman Req 91).

12. **Reverse flow:** If `consumption` is negative and no rollover condition is detected, flag as `exception_code=REVERSE_FLOW`. This may indicate backflow, cross-connection, or a tampered meter (Bozeman Req 98).

13. **Backfill imports:** Importing historical reads (past billing periods) is allowed only if `is_frozen=false` on any affected reads. Importing into already-billed periods requires supervisor authorization captured in AuditLog.

## Multi-Register Reads

Many commercial and industrial meters expose multiple registers on a single device — typically one for energy (kWh, usage) and one or more for demand (kW peak). Each register has its own UoM, its own multiplier, and its own prior-reading/consumption calculation. A single field visit (or a single AMI/AMR reading interval) captures values for all active registers at the same timestamp.

### Data model

- A read *event* is the physical act of reading a meter. It produces **N `MeterRead` rows**, one per active `MeterRegister` on the meter at `read_date`.
- All sibling rows share:
  - `meter_id`, `read_event_id`, `read_date`, `read_datetime`, `read_type`, `read_source`, `reader_id`, `import_batch_id`, `service_agreement_id`
- Each sibling row differs in:
  - `register_id`, `uom_id`, `reading`, `prior_reading`, `consumption`, `exception_code` (registers fail independently)
- Single-register meters continue to write a single row with `read_event_id = NULL`. No backfill required. Code that operates on a single read treats `NULL` read_event_id as "legacy/single-register" and proceeds as today.

### Read-event creation rules

- **All active registers required by default.** When a read is recorded for a meter with N active registers, the service expects N readings in the payload. Submitting with fewer than N errors with `REGISTERS_INCOMPLETE` and lists the missing `register_number`s.
- **Skip path for broken registers.** The request may include a per-register skip object `{ registerId, skipReason }` with one of `OUT_OF_SERVICE`, `INACCESSIBLE`, `DEFECTIVE`. A skipped register produces **no `MeterRead` row**; the skip is captured as a `MeterEvent` (event_type=`NO_SIGNAL` or `METER_DEFECT`) tied to the same `read_event_id`. Field techs aren't blocked by a broken demand register when the usage register reads fine.
- **Atomicity.** All rows for a single event are written inside one transaction. Partial success is not allowed.
- **Exception evaluation** runs per register. One register triggering `HIGH_USAGE` does not flag its siblings.

### API changes

- `POST /api/v1/meter-reads` accepts either:
  - **Single-register form (unchanged):** top-level `reading` field. Used by the simple entry form for single-register meters and by legacy integrations.
  - **Multi-register form (new):** a `readings: [{ registerId, reading, exceptionNotes? }]` array and an optional `skips: [{ registerId, skipReason }]` array. The service validates that the union of `readings[].registerId` and `skips[].registerId` covers every active register on the meter.
- Response returns the full array of created `MeterRead` rows plus the generated `read_event_id`.
- `GET /api/v1/meters/:id/reads` accepts a new query param `group=event` that returns one row per `read_event_id` with siblings nested under a `readings` array. Default (ungrouped) is unchanged for backwards compatibility.
- `PATCH /api/v1/meter-reads/:id` (correction) continues to operate on one row at a time. Correcting a single register creates a new `CORRECTED` row with a **new** `read_event_id` (not the original event's id) so the correction chain stays per-register. The original event's `read_event_id` is not mutated.

### UI changes

- **Record Meter Read (`/meter-reads/new`)**: after meter selection, the reading section renders dynamically. If `meter.registers.length === 1`, the single reading field stays as-is. If ≥ 2, render a compact table with one row per active register showing `Register #`, description, UoM code, prior reading, reading input, and a "Skip register" checkbox that expands a reason dropdown. A sticky summary line beneath shows `N of M registers ready`. Submit is disabled until all registers are either read or explicitly skipped.
- **Meter Reads List (`/meter-reads`)**: the list groups by `read_event_id` when non-null. A multi-register event shows as a single expandable row with the meter/date header and a sub-row per register. Read-type and source badges apply to the event; per-register exception chips render on the sub-rows. A "ungroup" toggle in the filter strip restores the flat per-row view for operators who prefer it.
- **Meter Read Detail (`/meter-reads/:id`)**: when the read belongs to a multi-register event, a new "Sibling Registers" card renders beside the consumption calculation card, linking to each sibling row. The correction workflow remains per-row (you correct one register's reading, not the whole event).

### Import changes

- **CSV format evolves** to be keyed on `(meter_number, register_number)`:
  ```
  meter_number, register_number, read_datetime, reading, read_source, …
  ```
- **Single-register compatibility.** If `register_number` is absent or empty on an import row and the target meter has exactly one active register, the importer accepts the row and writes a legacy-style `register_id=NULL` read. If the meter has ≥ 2 registers and `register_number` is missing, the row errors with `REGISTER_REQUIRED_FOR_MULTI_REGISTER_METER`.
- **Event grouping on import.** The importer groups rows by `(meter_number, read_datetime)` within a batch and generates one `read_event_id` per group. Rows for the same meter at the same datetime become sibling reads automatically. If a group covers fewer than the meter's active register count, the batch reports `REGISTERS_INCOMPLETE` and the whole group is rejected (safer than writing a partial event that billing can't process).
- **AMI / MV90 formats** already produce per-register records in their native form. The parser maps those directly; `read_event_id` is assigned per-meter per-interval.

### Billing touchpoints

- Rate schedules for multi-register meters typically carry separate charge components (energy `$/kWh` vs. demand `$/kW`). The billing engine selects the correct register's consumption by matching the component's commodity + UoM against each sibling read's `uom_id`. Validation at rate-schedule save time: if the rate schedule references a UoM that the assigned meter's registers don't provide, surface a warning ("rate expects kW demand register; meter has only kWh register").
- Freeze semantics apply at the row level, not the event level. In practice billing either freezes all siblings of an event together (normal path) or freezes the ones it actually used and leaves others editable (unusual). Default behavior: freeze the whole event — simpler for correction workflows.

### Migration and rollout

1. Add `read_event_id` column to `meter_read` (nullable, no backfill of existing rows).
2. Add the partial index on `(utility_id, read_event_id) WHERE read_event_id IS NOT NULL`.
3. Ship service + API supporting both single and multi-register payloads. Existing clients using the single-reading form continue working unchanged.
4. Ship UI enhancements (list grouping, entry form register table, detail sibling card). All behind the natural gate of `meter.registers.length`.
5. Ship import format upgrade with the per-meter single-register fallback. Tenants importing into single-register meters don't need to change anything.
6. Flip billing rate-schedule UoM validation on for new rate schedules; existing schedules keep working.

## UI Pages

### Meter Reads List (`/meter-reads`) — live

Table: meter number (monospace), read date, reading, consumption, read-type badge (ACTUAL/ESTIMATED/CORRECTED/FINAL/AMI color-coded), read source, exception code chip (if any), frozen indicator (`❄`). Filter pills for type, source, exception presence, billed state. Header strip has "+ New Read," "⚠ Exception Queue," and "↑ Import Reads" action buttons.

### Record Meter Read (`/meter-reads/new`) — live

Hand-rolled form (not the `EntityFormPage` shell) with a **premise → meter cascade**: user searches premises with `SearchableEntitySelect`, then the meter picker scopes to that premise's meters only. Clicking a meter immediately fires two parallel fetches — `GET /api/v1/meters/:id` and `GET /api/v1/meters/:id/reads?limit=1` — and renders a **context card** with meter number, commodity + UOM (code + name), active agreement number with status, last read value + date, and the multiplier formula if not 1. If the meter has no active `ServiceAgreementMeter` assignment, the context card is replaced by a red warning banner and every remaining form field is disabled. The reading input's label shows the UOM code (e.g. `Reading (KWH)`). `serviceAgreementId` is never asked for — the backend resolves it on submit.

### Meter Read Detail (`/meter-reads/:id`) — live

Full field display with a dedicated 4-column consumption calculation card showing READING / PRIOR / × MULTIPLIER / = CONSUMPTION in large monospace, plus a formula line beneath (`(12,345.67 − 12,000.00) × 1 = 345.67`). Four context cards in a 2×2 grid cover meter info, service agreement with account + premise + commodity links, read metadata (type, source, dates, reader), and audit (created, updated, frozen, correction chain links). Exception panel renders only if the read is flagged. Header has `Correct` and `Delete` action buttons, both disabled (with explanatory tooltips) when the read is frozen.

**Correction workflow.** Clicking `Correct` reveals an inline form with the current reading pre-filled and a required notes field. Submitting calls `PATCH /api/v1/meter-reads/:id`, which creates a new `CORRECTED` row via the same service path as a manual correction — the original is never mutated. On success, the page redirects to the new corrected row's detail page so the operator can verify the recalculated consumption.

**Delete workflow.** Clicking `Delete` opens the shared `ConfirmDialog` with a clear warning naming the reading value, date, and meter. Submitting calls `DELETE /api/v1/meter-reads/:id`, which enforces the frozen + correction-chain guards server-side. On success, toast + redirect to the list.

### Exception Queue (`/meter-reads/exceptions`) — live

Distinctive custom design (not shell-based): sticky header strip showing per-exception-code counts with a pulsing red dot when the open count is non-zero, grouped sections by exception code with terminal-style headers, per-row monospace layout with tabular-numeric alignment for the reading columns. Bulk action bar slides up from the bottom when rows are selected, offering `✓ APPROVE AS-IS` and `⏸ HOLD FOR RE-READ` as the two bulk operations. Escape key clears selection.

### Import Center (`/meter-reads/import`) — live (UI), partial (backend)

Three-stage wizard: UPLOAD → PREVIEW → COMMIT, with a numbered stage rail on the left that shows active/done state. Drag-and-drop file dropzone or paste-JSON fallback; client-side CSV/JSON parser with per-row validation. Preview shows the first 10 rows with ready/error status. Commit fires an animated progress bar and renders a three-card results summary (imported / exceptions / errors). The backend commit endpoint (`POST /api/v1/meter-reads/import`) is not yet deployed — the UI exercises the flow end-to-end up to the commit step and then surfaces a clean error. The client-side parser + preview is useful for dev/test but genuine bulk ingestion is a Phase 3 follow-up.

### Meter Detail Enhancement (`/meters/:id`) — planned

Read history tab with a consumption-over-time chart and a table of recent reads. Exception history tab. Deferred to a small follow-up pass; the underlying endpoint (`GET /api/v1/meters/:id/reads`) is live.

## Phase Roadmap

- **Phase 1 (Complete):** MeterRead entity defined in schema, TimescaleDB hypertable, fields for read_type/read_source/exception_code. No API endpoints or UI.

- **Phase 2 (Complete):**
  - MeterRead CRUD API: list, get, per-meter history, manual create, correction (produces new CORRECTED row), exception queue, resolve-exception
  - MeterEvent entity + CRUD (LEAK, TAMPER, REVERSE_FLOW, HIGH_USAGE, NO_SIGNAL, BATTERY_LOW, COVER_OPEN, BURST_PIPE, FREEZE, OTHER)
  - ImportBatch entity (tracks bulk import jobs with error reporting)
  - Manual read entry UI (hand-rolled form at /meter-reads/new with premise → meter cascade and automatic service-agreement resolution)
  - Meter Reads list page with exception indicator, read-type badges, frozen indicator, filter pills for type/source/exception/billed
  - **Meter Read detail page** (/meter-reads/:id): full field display, consumption calculation card with formula line, 2×2 context grid (meter / agreement / metadata / audit), exception panel when flagged, correction chain links
  - **Correct workflow** on the detail page: inline form with pre-filled reading + required notes, submits `PATCH /api/v1/meter-reads/:id` which creates a new `CORRECTED` row preserving the original via `corrects_read_id`, redirects to the new row's detail page
  - **Delete workflow** on the detail page: `ConfirmDialog` with warning naming the reading value and date, calls `DELETE /api/v1/meter-reads/:id`, guarded server-side against frozen reads and reads with downstream corrections
  - Exception queue UI (/meter-reads/exceptions): grouped by exception code, sticky count strip with pulse indicator for open items, bulk approve / bulk hold-for-reread action bar, keyboard escape to clear selection
  - Import Center UI (/meter-reads/import): three-stage wizard (upload → preview → commit) with drag-and-drop file drop, CSV/JSON client-side parser, per-row validation status, progress bar, results summary with error panel. Backend commit endpoint deferred to Phase 3.
  - Consumption calculation in service layer with rollover detection (respects meter.dial_count)
  - Reverse-flow detection (negative consumption with no rollover flag)
  - Correction chain via corrects_read_id self-reference — correction inserts a new row instead of mutating the original
  - Freeze-after-bill guard: cannot resolve exceptions on frozen (already-billed) reads, cannot delete frozen reads
  - **Auto-resolve service agreement**: `createMeterReadSchema.serviceAgreementId` is optional; the backend resolves the owning agreement from the `ServiceAgreementMeter` junction table using `meter_id + read_date`, returning `METER_NOT_ASSIGNED` if no active assignment exists at the read date. Operators never pick the agreement manually — preventing the class of bug where a read gets attributed to a closed-out customer.
  - **Server-side meter search**: `GET /api/v1/meters?search=<q>` does a case-insensitive substring match on `meter_number`, backing the meter picker in the read-entry form so dropdowns don't preload unbounded lists.
- **Phase 2 (Deferred to Phase 3):**
  - Bulk import backend (CSV/XML/MV90 parser and ImportBatch job runner — the UI exercises the flow via client-side parsing only)
  - Estimated read generation (trailing 3-month average)
  - ExceptionThreshold entity + tenant-configurable rules

- **Phase 2.5 — Multi-Register Reads (Planned):**
  - `read_event_id` column + partial index on `meter_read`
  - Read service accepts multi-register payload (`readings[]` + `skips[]`), writes sibling rows atomically under one `read_event_id`, runs exception evaluation per register
  - Single-register entry path preserved unchanged — UI and API branch on `meter.registers.length`
  - `/meter-reads/new` dynamic register table when ≥ 2 registers, with per-register skip + reason
  - `/meter-reads` list grouping by `read_event_id` (with flat-view toggle)
  - `/meter-reads/:id` sibling-registers card linking to each sibling row
  - Import format keyed on `(meter_number, register_number)` with single-register fallback and per-event grouping
  - Billing rate-schedule validation: warn when the referenced UoM isn't provided by any active register on assigned meters

- **Phase 3 (Planned):**
  - Read freeze after billing cycle execution
  - Correction workflow (CORRECTED read → rebill trigger)
  - Leak adjustment workflow (Bozeman Req 99)
  - Reads drive billing engine calculations
  - Exception reports (Bozeman Req 100)

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 75–76 | Meter reading as authoritative system, API integration | Phase 2: import API, AMI/AMR support |
| 77 | Incremental and full read imports | Phase 2: import endpoint with batch support |
| 78 | Read cycle scheduling, route grouping | BillingCycle + ServiceAgreement.read_sequence (Phase 1) |
| 79 | Unique read IDs, prevent duplicate billing | Unique constraint on [meter, register, datetime, source] |
| 80 | Associate reads to meters | MeterRead.meter_id FK |
| 81 | Multi-register meter handling | Phase 2: `register_id` on `MeterRead`, per-register rows; Phase 2.5: end-to-end support (read_event_id grouping, multi-register entry form, import format, rate-schedule validation) |
| 82 | Label estimated vs actual reads | read_type enum: ACTUAL, ESTIMATED, CORRECTED, FINAL, AMI |
| 83 | Retain raw interval data | TimescaleDB hypertable, raw reading field preserved |
| 84 | Meter events (leaks, tamper, reverse flow) | exception_code=REVERSE_FLOW; MeterEvent entity Phase 2 |
| 86 | Freeze validated reads after billing | is_frozen field; Phase 3 implementation |
| 87 | Before/after for corrected reads | corrects_read_id + AuditLog |
| 88 | Audit trail for reads | AuditLog entity |
| 89 | Manual entry/correction with audit | Phase 2: manual create + correction endpoint |
| 91 | Replaced meters mid-cycle, reads total to usage | Phase 2: FINAL + ACTUAL reads, billing engine sums |
| 92 | Mid-cycle final reads and billing | FINAL read_type + proration in Phase 3 billing |
| 93 | Configurable exception thresholds | Phase 2: ExceptionThreshold entity |
| 94–95 | Flag abnormal/invalid reads to exception queue | Phase 2: exception_code + exception queue UI |
| 96 | Estimation rules for missing reads | Phase 2: trailing average estimation |
| 97 | Error handling for failed imports | Phase 2: ImportBatch error tracking |
| 98 | Backflow/reverse flow handling | exception_code=REVERSE_FLOW, rollover detection |
| 100 | Exception reports | Phase 3: exception report dashboard |
