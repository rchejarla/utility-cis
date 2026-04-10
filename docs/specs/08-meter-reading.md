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

**Indexes:** `[utility_id, meter_id, read_date DESC]`, `[utility_id, service_agreement_id, read_date DESC]`, `[utility_id, exception_code]` (partial: WHERE exception_code IS NOT NULL), `[import_batch_id]`

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

All endpoints are planned for Phase 2.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/meter-reads` | List reads (filterable by meter, date range, type, exception) |
| POST | `/api/v1/meter-reads` | Create a single manual meter read |
| GET | `/api/v1/meter-reads/:id` | Get read detail |
| PATCH | `/api/v1/meter-reads/:id` | Correct a read (creates CORRECTED read, marks original) |
| GET | `/api/v1/meters/:id/reads` | All reads for a specific meter, newest first |
| POST | `/api/v1/meter-reads/import` | Bulk import reads (AMR/AMI file upload or JSON payload) |
| GET | `/api/v1/meter-reads/import/:batchId` | Get import batch status and errors |
| GET | `/api/v1/meter-reads/exceptions` | Exception queue: reads flagged for review |
| POST | `/api/v1/meter-reads/:id/resolve-exception` | Mark exception resolved, optionally re-estimate |
| GET | `/api/v1/exception-thresholds` | List configured exception thresholds |
| POST | `/api/v1/exception-thresholds` | Create threshold rule |
| PATCH | `/api/v1/exception-thresholds/:id` | Update threshold |
| DELETE | `/api/v1/exception-thresholds/:id` | Deactivate threshold |

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

10. **Multi-register reads:** For meters with multiple MeterRegisters, a separate MeterRead row is created per register per read event. All registers must be read in the same import batch event for the billing cycle to proceed.

11. **Mid-cycle meter replacement:** When a meter is swapped mid-cycle, the outgoing meter receives a FINAL read and the incoming meter receives an ACTUAL read. The billing engine sums consumption from both reads for the period (Bozeman Req 91).

12. **Reverse flow:** If `consumption` is negative and no rollover condition is detected, flag as `exception_code=REVERSE_FLOW`. This may indicate backflow, cross-connection, or a tampered meter (Bozeman Req 98).

13. **Backfill imports:** Importing historical reads (past billing periods) is allowed only if `is_frozen=false` on any affected reads. Importing into already-billed periods requires supervisor authorization captured in AuditLog.

## UI Pages

All pages are planned for Phase 2.

### Meter Reads List (`/meter-reads`)

- Table: meter number, premise address, read date, reading, consumption, read_type badge, read_source, exception indicator
- Filters: date range, commodity, read_type, read_source, has exception toggle
- Quick-entry form for manual reads (meter lookup, read value, date)
- "Import Reads" button → import modal

### Exception Queue (`/meter-reads/exceptions`)

- Table of reads with unresolved exception_codes
- Grouped by exception type
- Per-row actions: Approve, Estimate, Correct, Flag for re-read
- Bulk resolve selected rows
- Exception summary counts by type (dashboard widget)

### Import Center (`/meter-reads/import`)

- Upload interface: drag-and-drop file or paste JSON
- Column mapping configuration (saved per tenant per source)
- Preview: first 10 rows with parsed values before confirming import
- Batch status tracking: progress bar for large imports
- Results summary: imported / exceptions / errors with downloadable error report

### Meter Read Detail (`/meter-reads/:id`)

- Full field display
- Consumption calculation shown step-by-step (reading - prior × multiplier)
- Exception history (if flagged and resolved)
- Correction chain (if this read corrects another, or has been corrected)
- Audit log entries for this read

### Meter Detail Enhancement (`/meters/:id`)

- Read history tab: chart of consumption over time, table of reads
- Exception history tab

## Phase Roadmap

- **Phase 1 (Complete):** MeterRead entity defined in schema, TimescaleDB hypertable, fields for read_type/read_source/exception_code. No API endpoints or UI.

- **Phase 2 (Complete):**
  - MeterRead CRUD API: list, get, per-meter history, manual create, correction (produces new CORRECTED row), exception queue, resolve-exception
  - MeterEvent entity + CRUD (LEAK, TAMPER, REVERSE_FLOW, HIGH_USAGE, NO_SIGNAL, BATTERY_LOW, COVER_OPEN, BURST_PIPE, FREEZE, OTHER)
  - ImportBatch entity (tracks bulk import jobs with error reporting)
  - Manual read entry UI (shell-based form at /meter-reads/new)
  - Meter Reads list page with exception indicator, read-type badges, frozen indicator, filter pills for type/source/exception/billed
  - Exception queue UI (/meter-reads/exceptions): grouped by exception code, sticky count strip with pulse indicator for open items, bulk approve / bulk hold-for-reread action bar, keyboard escape to clear selection
  - Import Center UI (/meter-reads/import): three-stage wizard (upload → preview → commit) with drag-and-drop file drop, CSV/JSON client-side parser, per-row validation status, progress bar, results summary with error panel
  - Consumption calculation in service layer with rollover detection (respects meter.dial_count)
  - Reverse-flow detection (negative consumption with no rollover flag)
  - Correction chain via corrects_read_id self-reference — correction inserts a new row instead of mutating the original
  - Freeze-after-bill guard: cannot resolve exceptions on frozen (already-billed) reads
- **Phase 2 (Deferred to Phase 3):**
  - Bulk import backend (CSV/XML/MV90 parser and ImportBatch job runner — the UI exercises the flow via client-side parsing only)
  - Estimated read generation (trailing 3-month average)
  - ExceptionThreshold entity + tenant-configurable rules
  - Multi-register read support end-to-end

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
| 81 | Multi-register meter handling | Phase 2: register_id on MeterRead, per-register reads |
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
