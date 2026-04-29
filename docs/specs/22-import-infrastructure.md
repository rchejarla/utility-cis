# Import Infrastructure

**Module:** 22 — Import Infrastructure (cross-cutting)
**Status:** Design (this doc) — implementation pending
**Entities:** ImportBatch (extended), ImportRow (new), InAppNotification (new)
**Cross-cuts:** every entity that supports bulk import (meter reads first, then customers, premises, meters, accounts).

## Overview

Bulk file uploads — operators landing CSVs full of vendor-supplied data, legacy migrations dropping decades of history, GIS sync re-loads — show up across the system with the same shape every time:

> Pick a file. We need to read it, map vendor headers to our fields, validate per row, ingest the good rows, report the bad ones, leave a paper trail, and tell the operator when it's done.

Today only meter reads has any of this, and even there it's incomplete. This module pulls the recurring shape into a shared primitive so:

- Each new entity that supports bulk import writes **one handler file** (~150 lines) instead of an endpoint + service + service tests + routes + parser + mapping UI + history page (~1500 lines).
- Operators see one consistent UX across **/customers/import**, **/meters/import**, **/premises/import**, etc.
- Imports running in the background notify the operator when complete via in-app + email.
- Stuck or partial imports can be **resumed** without re-importing successful rows.
- Errors are first-class data — listed, downloadable, drillable.

**Who uses it:** CSRs running bulk customer move-in, meter-read import operators, billing analysts importing rate-schedule revisions, data-migration teams loading legacy history. Internal ops tooling.

**Why it matters:** Bulk imports touch every revenue-affecting table. Half-finished imports, double-imports, lost error reports, and "did it actually work?" anxiety are the day-to-day reality of operations teams. A real framework removes that.

---

## Goals & non-goals

### Goals

1. **One pattern for every bulk import** — same routes, same UI, same lifecycle, parameterised by entity kind.
2. **Track every batch** — durable record (status, counts, errors, who, when) reachable through a cross-kind history page.
3. **Async by default for non-trivial batches** — operators don't watch spinners for 8 minutes, and connection drops don't kill imports.
4. **Resumable imports** — a batch interrupted by a worker crash, deploy, or pod restart picks back up where it left off, not from the top.
5. **Per-row error reporting** — every error has row number, source value, error code, message; aggregate counts per code; downloadable as CSV.
6. **Notify on completion** — in-app notification (always) + email (opt-in) when an async batch reaches a terminal state.
7. **Field mapping** — operators map vendor headers to canonical fields, with auto-detection and per-vendor recall.
8. **Throw away nothing** — preserve existing meter-read import URLs and behavior; the existing endpoint becomes a thin wrapper.

### Non-goals

- Streaming uploads (multipart/form-data with chunked parsing). All files are parsed in-memory; max 100k rows per batch suffices for the foreseeable workload.
- File-format support beyond CSV and JSON (no XML, no Excel directly — operators export to CSV).
- Two-way sync / continuous integration. This is one-shot batches.
- Cross-tenant imports. Each batch belongs to one utility.
- Authoring tools. Operators bring their own files; we don't generate them (other than the per-kind template skeleton).

---

## Domain model

### `ImportBatch` (extended)

Existing table. Already has source, fileName, recordCount, importedCount, exceptionCount, errorCount, status, errors, createdBy, createdAt, completedAt.

**New columns:**

| Field | Type | Notes |
|-------|------|-------|
| `entity_kind` | `String @db.VarChar(50)` | `meter_read`, `customer`, `premise`, `meter`, `account`, ... — drives handler dispatch |
| `processing_started_at` | `DateTime?` | Set when worker picks up the job; lets us detect zombie batches (PROCESSING for > N min with no progress) |
| `last_progress_at` | `DateTime?` | Set every 100 rows; another zombie-detection signal |
| `cancel_requested` | `Boolean @default(false)` | User clicked Cancel; worker checks this between rows and exits gracefully |
| `mapping` | `Json?` | The {sourceHeader → canonicalField} map used by this batch — recorded for audit and replay |

**Original file storage:** the operator's uploaded file is stored via the existing `Attachment` table, polymorphic on `entityType="ImportBatch"` and `entityId=batch.id`. The Attachment infrastructure already handles bytes-to-disk persistence, traversal-safe download, and tenant scoping. The Imports detail page exposes a "Download original file" link that uses the existing attachment download endpoint. No new blob-storage dependency needed for Phase 1.

**Removed:** the existing `errors` JSON column on `ImportBatch` is dropped in the migration. Per-row errors live in `import_row`; the JSON column was only used by the meter-reads-specific import path that's being refactored.

**Status enum widened:**

```
PENDING → PROCESSING → COMPLETE
                     → PARTIAL          (some rows succeeded, some errored)
                     → FAILED           (every row errored, or fatal pre-row error)
                     → CANCELLED        (user requested cancel; some rows may have committed)
```

`PARTIAL` is new — distinguishes "import did nothing" (FAILED) from "import did something but not everything" (PARTIAL). UI surfaces these differently.

### `ImportRow` (new)

Per-row state. **Reason for a separate table over a JSON column:** a 100k-row import fits poorly in a JSON column on `ImportBatch`. Per-row search, filtering, paginated UI lists, and resume-after-crash all want row-level rows in the database.

```
model ImportRow {
  id              String      @id @default(uuid()) @db.Uuid
  importBatchId   String      @map("import_batch_id") @db.Uuid
  rowIndex        Int         @map("row_index")          // 1-based, matches what the operator sees
  rawData         Json        @map("raw_data")           // the source row (post-mapping) used by the handler
  status          ImportRowStatus  @default(PENDING)
  resultEntityId  String?     @map("result_entity_id") @db.Uuid  // FK to whatever the handler creates (loose; nullable)
  errorCode       String?     @map("error_code") @db.VarChar(64)
  errorMessage    String?     @map("error_message") @db.Text
  createdAt       DateTime    @default(now())
  processedAt     DateTime?

  @@index([importBatchId, status])
  @@index([importBatchId, rowIndex])
}

enum ImportRowStatus {
  PENDING       // not yet attempted
  IMPORTED      // handler succeeded
  ERROR         // handler returned an error for this row
  SKIPPED       // pre-empted (e.g., kind handler said "skip silently")
}
```

This table is bounded — rows are created at batch creation and never updated except to flip status / record errorCode. After a batch is COMPLETE for ≥ 90 days, a retention sweep can drop `import_row` rows for it, keeping just the aggregate counts on `ImportBatch`. Out-of-scope for Phase 1.

### `InAppNotification` (new)

```
model InAppNotification {
  id          String                  @id @default(uuid()) @db.Uuid
  utilityId   String                  @map("utility_id") @db.Uuid
  userId      String                  @map("user_id") @db.Uuid
  kind        InAppNotificationKind   // IMPORT_COMPLETE, IMPORT_FAILED, IMPORT_CANCELLED, ...
  severity    NotificationSeverity    // INFO | SUCCESS | WARNING | ERROR
  title       String                  @db.VarChar(200)
  body        String                  @db.Text
  link        String?                 @db.VarChar(500)   // e.g., /imports/<id>
  metadata    Json?
  isRead      Boolean                 @default(false)
  readAt      DateTime?
  createdAt   DateTime                @default(now())

  @@index([utilityId, userId, isRead, createdAt(sort: Desc)])
}
```

Used by import infrastructure first; designed to be reused by future modules that need a bell-icon inbox (suspension activations, billing-cycle completion, etc.). Out of scope: the bell-icon UI itself — Phase 1 ships the table + emit; the topbar bell can come later.

---

## State machine

```
        ┌──────┐  multipart POST /imports — server stores file via Attachment,
        │ PEND │  parses with mapping, creates import_row rows.
        └──┬───┘  Sync (≤ 250 rows) or async (> 250) decided server-side.
           │ worker pulls (or sync handler starts)
           ▼
       ┌────────┐  worker processes rows; updates importedCount + errorCount + last_progress_at
       │ PROCESS│  every 50 rows; writes per-row result to import_row
       └──┬─────┘
          │
   ┌──────┴────────────┬─────────────────┬──────────────┐
   │ all rows succeeded│ some rows failed│ all failed   │ cancel_requested seen
   ▼                   ▼                 ▼              ▼
┌──────────┐       ┌──────────┐       ┌────────┐    ┌───────────┐
│ COMPLETE │       │ PARTIAL  │       │ FAILED │    │ CANCELLED │
└──────────┘       └──────────┘       └────────┘    └───────────┘
         │              │                   │              │
         └──────────────┴───────────────────┴──────────────┘
                                │
                                ▼
                        emit InAppNotification + (opt-in) email
```

### Restart paths

A batch can re-enter PROCESSING from any non-terminal state:

- **Crash recovery** — startup hook: any batch in PROCESSING with `last_progress_at` older than the worker heartbeat threshold (5 min) is considered abandoned. Re-enqueue automatically. Worker skips rows already in `IMPORTED` status.
- **User-driven retry** — failed batch can be retried via `POST /imports/:id/retry`. Re-enqueues the batch; worker re-attempts only rows in `ERROR` status (configurable: retry-error-rows-only vs. start-from-scratch). Useful when an underlying problem (missing reference data, deployment bug) is fixed and the operator wants the half that failed to land.
- **User-driven resume after cancel** — cancelled batch becomes resumable: same as retry, but processes both PENDING and ERROR rows.

Restarts are NOT in-place mutations — they emit new audit rows: `import_batch.retried`, `import_batch.resumed`. The original batch's existing import_row rows stay; their status flips on re-processing.

### Cancellation

`POST /imports/:id/cancel`:

1. Set `cancel_requested = true` on the batch (no immediate stop).
2. Worker checks `cancel_requested` between rows. When true, finishes current row's transaction (consistency), marks status `CANCELLED`, exits.
3. Wizard polling sees CANCELLED → shows result panel.

This is "soft cancel" — already-imported rows stay. Resume picks back up from where the worker stopped.

---

## Error reporting

Per-row errors live on `import_row` rows. Every error has:

- `errorCode` — machine-readable, finite enum per kind (e.g. `METER_NOT_FOUND`, `INVALID_DATE`, `DUPLICATE`, `FK_MISSING`)
- `errorMessage` — human-readable
- `rowIndex` — 1-based, matches what the operator sees in their CSV
- `rawData` — the row's source values, so the operator can see exactly what was rejected

**API surface:**

- `GET /api/v1/imports/:id/rows?status=ERROR&page=1` — paginated, filterable
- `GET /api/v1/imports/:id/errors.csv` — full error list as CSV (rowIndex, source columns, errorCode, errorMessage)
- `GET /api/v1/imports/:id/error-summary` — aggregate `{ errorCode → count }` so the UI can render "23 rows: METER_NOT_FOUND, 5 rows: INVALID_DATE" instead of scrolling through 28 rows

UI:

- Detail page shows error summary at top.
- Table of error rows with paginated rowIndex + first-3-source-columns + errorCode + errorMessage.
- Filter by errorCode pill.
- "Download errors CSV" button → operator opens in Excel, fixes, re-uploads.

---

## Upload & parsing

### Server is the parser of record

The client POSTs `multipart/form-data` containing the original file plus the operator-confirmed mapping. The server parses the file (using `papaparse` from the shared package — same library used in the browser for the mapping preview), applies the mapping, and creates one `import_row` per parsed row.

The client's mapping-stage preview is local: it reads the file via `FileReader`, runs `papaparse` against the first ~50 rows, and renders the dropdowns. This is fast feedback — no roundtrip to confirm a mapping. Because client and server share the parser, "what the operator saw at preview" matches "what the server processes" exactly. (Edge cases involving very large or unusual files where the server-side parse diverges from the client peek would surface as per-row errors — recoverable but ugly. Sharing papaparse keeps that risk near zero.)

### Threshold

Sync vs. async decision is **server-side**, made after parsing has produced a row count:

- `recordCount ≤ 250` → process inline within the same HTTP request, return final result.
- `recordCount > 250` → create batch in PENDING, enqueue to BullMQ, return `202 { batchId }` immediately.

250 is the initial threshold; tune based on observed timing. 250 rows × 80ms ≈ 20s, comfortably within HTTP timeout windows.

### Multipart upload

Single endpoint accepts the upload + mapping together. No staged-upload step, no separate preview round-trip. Body shape:

```
POST /api/v1/imports
Content-Type: multipart/form-data

  file: <binary, the operator's CSV or JSON>
  kind: meter_read | customer | premise | meter | account | ...
  source: AMR | AMI | MANUAL_UPLOAD | API
  fileName: "2026-04-15-route-A.csv"   (optional, defaults to multipart's file name)
  mapping: '{"fields": ["meterNumber", "ignore", "readDatetime", "reading"]}'  (JSON-encoded)
```

If parsing fails (unreadable bytes, no header row, mapping doesn't cover required fields), the request fails synchronously with a 400 — no batch is created. Once parsing succeeds, an `ImportBatch` always exists, even if every row errors.

For very large files the upload itself may take a while; multipart progress events are surfaced to the wizard's progress bar so the operator sees movement. The server caps file size at 50 MB in Phase 1 (covers ~500k rows of typical CSV); larger files are a Phase 3 concern.

### Worker

New BullMQ queue: `import-jobs`. Job payload: `{ batchId }`.

```
worker(job) {
  while (rows in PENDING or ERROR-with-retry):
    if (cancel_requested) → finalize CANCELLED, exit
    process next batch of 50 rows in one transaction:
      for each row:
        try: handler.processRow(row.rawData) → flip row to IMPORTED, save resultEntityId
        catch: flip row to ERROR, store errorCode + message
    update batch.importedCount, batch.errorCount, batch.lastProgressAt
  finalize: status = COMPLETE | PARTIAL | FAILED based on counts
  emit InAppNotification + (if user opted in) email
}
```

Concurrency: one worker instance per batch (BullMQ guarantees one consumer). Multiple batches process in parallel across worker instances.

Heartbeat: every 50 rows, worker updates `last_progress_at`. Batches in PROCESSING with `last_progress_at` > 5 min are zombies — re-enqueued by a startup sweep.

### Polling

Wizard's commit stage polls `GET /imports/:id` every 2 seconds while status is PENDING or PROCESSING. Renders progress bar from `(importedCount + errorCount) / recordCount`. Stops polling on terminal state.

When the operator navigates away, the in-app notification arrives in their bell when complete; email arrives independently if they've opted in.

---

## Mapping

### Canonical fields per kind

Each handler exports:

```typescript
interface CanonicalFieldDef {
  name: string;                 // "meterNumber"
  label: string;                // "Meter number"
  required: boolean;
  description?: string;         // shown as helper text in the wizard
  example?: string;             // sample value for the template
}
```

Surfaced via `GET /api/v1/imports/kinds/:kind/fields` so the wizard can render dropdowns dynamically. Also drives `template.csv` generation.

### Client-side peek

The wizard parses the operator's file locally to drive the mapping UI:

1. `FileReader` reads file bytes.
2. `papaparse` (shared between client and server) extracts the header row and first 50 data rows.
3. Auto-detect runs against the headers; operator confirms or overrides.
4. Sample rows render in the preview pane keyed by canonical field.

No server roundtrip is needed during the mapping stage. The file is not uploaded until the operator clicks Commit.

### Auto-detection

On entering the mapping stage, the wizard auto-detects header → canonical mappings using:

1. Exact lowercase match against canonical name.
2. Match against handler-supplied alias regexes (e.g., `^meter(_?id|_?number|_?code)?$`).
3. If multiple headers match the same canonical, first match wins; later headers fall through to other targets or `ignore`.

### Persistence

Per the earlier discussion: **in-memory + localStorage by header signature**.

```typescript
const key = `import-mapping:${kind}:${sha1(headers.join("|"))}`;
localStorage.setItem(key, JSON.stringify({ fields, savedAt }));
```

Re-uploading a file with the same header order → mapping pre-fills automatically. Operator can override per-import.

**Out-of-scope (Phase 2):** server-side `ImportMappingPreset` for shared, named team templates. Add when operators request.

### Validation

Before allowing Continue from the mapping stage:

- Every `required: true` canonical field must be mapped exactly once.
- The same canonical can't be mapped to two source headers.
- Unmapped source headers default to `ignore`.

Server re-validates the mapping on POST (defense-in-depth). Mapping is recorded on the `ImportBatch.mapping` column for replay/debug.

---

## Notification

### Trigger

When a batch transitions to a terminal state (COMPLETE, PARTIAL, FAILED, CANCELLED), the worker (or sync handler) emits notifications:

- **In-app**: always. One `InAppNotification` row per terminal event, addressed to the batch's `createdBy`.
- **Email**: opt-in. User preference `notify_on_import_complete: BOOLEAN` on `cis_user`. Default `true` for async batches, `false` for sync (the user is watching the wizard).
- **SMS**: not supported for imports — it's not a customer-facing event.

### In-app payload

```json
{
  "kind": "IMPORT_COMPLETE",
  "severity": "SUCCESS",       // SUCCESS for COMPLETE/PARTIAL, ERROR for FAILED, WARNING for CANCELLED
  "title": "Customer import complete",
  "body": "1,234 rows · 1,200 imported · 5 errors · 29 skipped",
  "link": "/imports/<id>"
}
```

### Email payload

Reuses the existing notification template system (`spec 13`). New event type: `import.complete` with template variables: `kind`, `imported`, `errored`, `skipped`, `link`, `actorName`. Templates are tenant-customizable.

### Topbar bell

Phase 1 emits the in-app row but doesn't ship the bell UI. The detail page already shows status; the bell is a follow-up. Once shipped, the bell polls `GET /api/v1/notifications/unread` and renders a dropdown.

---

## Permission model

### Per-kind permission

Each handler declares the permission required to **create** an import:

```typescript
{
  kind: "customer",
  module: "customers",
  permission: "CREATE",
  ...
}
```

The generic `POST /api/v1/imports` route resolves the kind, then checks `module:permission` like any other route.

Reading import history: `imports.VIEW` (a new permission group on a new `imports` module). All authenticated users with this permission see imports across kinds — listing is not gated per-kind because operators often need cross-kind visibility ("what did I run yesterday?"). Per-kind detail access is additionally gated by the kind's VIEW permission to prevent leakage.

### Audit

Every batch state transition emits an audit row (`import_batch.created`, `import_batch.completed`, `import_batch.cancelled`, `import_batch.retried`). Per-row entity creation emits its normal audit row from the kind's processRow (e.g., `meter_read.created`). One audit row per terminal in-app + email notification (`notification.sent`).

---

## API surface

### Generic routes (all under `imports` module, permission as documented)

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/api/v1/imports/kinds` | `imports.VIEW` | List registered kinds with metadata (label, description, permission required) |
| `GET` | `/api/v1/imports/kinds/:kind/fields` | `imports.VIEW` | Canonical field definitions for the wizard's mapping stage |
| `GET` | `/api/v1/imports/kinds/:kind/template.csv` | `skipAuth` | Template skeleton for download |
| `POST` | `/api/v1/imports` | dispatch to kind | `multipart/form-data` with `file`, `kind`, `source`, `mapping`, optional `fileName`. Returns sync result OR `202 { batchId }` based on parsed row count |
| `GET` | `/api/v1/imports` | `imports.VIEW` | Paginated list, filter by `kind`, `status`, `source`, `createdBy`, date range |
| `GET` | `/api/v1/imports/:id` | `imports.VIEW` + kind's VIEW | Batch detail (counts, status, mapping, summary stats, link to original-file Attachment) |
| `GET` | `/api/v1/imports/:id/rows` | as above | Paginated row list, filter by `status` |
| `GET` | `/api/v1/imports/:id/error-summary` | as above | `{ errorCode → count }` |
| `GET` | `/api/v1/imports/:id/errors.csv` | as above | Error list as CSV download |
| `POST` | `/api/v1/imports/:id/cancel` | dispatch to kind | Soft-cancel; sets `cancel_requested` |
| `POST` | `/api/v1/imports/:id/retry` | dispatch to kind | Re-enqueue failed/error rows |

The original-uploaded-file is fetched through the existing attachment download endpoint (`GET /api/v1/attachments/:id/download` resolved via the batch detail's attachment id) — no new route needed.

### No backwards compatibility

The existing `POST /api/v1/meter-reads/import` endpoint and its `/meter-reads/import/template.csv` companion are **removed** by this work. Slice 1 migrates the existing meter-reads import wizard to the generic `<ImportWizard kind="meter_read" />` mount and deletes the old endpoints. Existing meter-reads import tests are rewritten against the new generic path; nothing depends on the old URLs externally.

---

## Worker design

### Queue

`import-jobs` queue, payload `{ batchId }`. Single attempt per job (no automatic BullMQ retries — we manage retry through the user-driven `/retry` endpoint, with explicit user intent and audit).

Queue config:
- **Concurrency**: 4 workers per node. Multiple batches run in parallel across workers; one batch is always one worker.
- **Removal**: completed jobs purged after 7 days (BullMQ's default), failed jobs kept for inspection.

### Heartbeat / zombie detection

A startup sweep (run on every API/worker boot):

```sql
UPDATE import_batch
SET status = 'PENDING'
WHERE status = 'PROCESSING'
  AND last_progress_at < now() - interval '5 minutes';
-- Then for each, enqueue a job.
```

This catches batches whose worker died (deploy, crash, OOM). Resume picks back up at the first non-IMPORTED row.

### Throughput

Per-row processing is dominated by DB round trips (4–5 per row at 5–20ms each). Realistic: 200–500 rows/sec per worker. A 10k batch finishes in 20–50s on a warm cache. A 100k batch finishes in 4–10 minutes.

If we ever need higher throughput, the per-row path can move to **batched inserts**: process rows in groups of 100 within one transaction, doing a single `createMany` instead of N `create`s. Defer until we measure a need.

---

## Schema migration

```sql
ALTER TABLE import_batch
  ADD COLUMN entity_kind varchar(50) NOT NULL DEFAULT 'meter_read',  -- backfill default
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN last_progress_at timestamptz,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN mapping jsonb,
  DROP COLUMN errors;                       -- replaced by per-row import_row table

ALTER TABLE import_batch
  ALTER COLUMN entity_kind DROP DEFAULT;    -- only existed for backfill

CREATE TABLE import_row (...);              -- per the model above
CREATE TABLE in_app_notification (...);
```

Status enum gains `PARTIAL` and `CANCELLED` values (Postgres `ALTER TYPE ... ADD VALUE`).

Existing meter_read import_batch rows are backfilled to `entity_kind = 'meter_read'`. The old `errors` JSON column is dropped — its only callers are in code being refactored as part of Slice 1.

---

## UI

### `/imports` (list page)

Cross-kind history table:

| Started | Kind | Source | File | Status | Imported | Errors | Actor |
|---------|------|--------|------|--------|----------|--------|-------|
| 2026-04-28 09:14 | Meter Read | AMI | ami-2026-04-27.csv | ✓ Complete | 9,847 | 153 | jsmith |
| 2026-04-28 08:02 | Customer | MANUAL | move-ins-q2.csv | ⚠ Partial | 412 | 6 | jsmith |
| 2026-04-27 16:30 | Meter | API | (api) | ✓ Complete | 23 | 0 | system |

Filters: kind, status, date range, actor. Click row → detail page.

### `/imports/:id` (detail page)

Header: status, source, file name, kind, who/when, total rows, counts.

Tabs:

- **Summary** — progress bar (live during PROCESSING), counts, error code aggregation chart, mapping used.
- **Rows** — paginated table of all import rows; filter by status.
- **Errors** — only ERROR rows; filter by error code; "Download CSV" button.

Actions in header (when applicable): Cancel (during PROCESSING), Retry (when FAILED/PARTIAL/CANCELLED), View entities (link to filtered entity list — meter-reads list with `?importBatchId=...`).

### `<ImportWizard kind="..." />`

The component the four+ entity-specific pages mount. Stages:

1. **Upload** — file drop or paste. Source dropdown.
2. **Mapping** — auto-detected per-header dropdown of canonical fields. Pre-fills from localStorage if signature matches.
3. **Preview** — first 10 mapped rows + valid/error counts.
4. **Commit** — submit. If sync, shows result inline. If async, polls `/imports/:id` and renders progress.

Component contract: takes `kind` prop, fetches canonical fields from API, renders. No per-kind code in the wizard itself.

### Per-entity pages

Trivial:

```tsx
// app/customers/import/page.tsx
export default function CustomerImportPage() {
  return <ImportWizard kind="customer" />;
}
```

Each lives at `/<entity>/import`.

---

## Handler contract

```typescript
// packages/api/src/imports/types.ts
export interface ImportKindHandler<TRow> {
  /** Stable enum value, also used in URLs. */
  kind: string;

  /** Human label rendered in UI. */
  label: string;

  /** Permission required to create an import of this kind. */
  module: string;
  permission: "CREATE" | "EDIT";

  /** Canonical fields the wizard mapping stage offers. */
  canonicalFields: CanonicalFieldDef[];

  /** Sample rows for the template.csv download. */
  templateRows: Record<string, string>[];

  /**
   * Convert a raw mapped row (object keyed by canonical field name)
   * into the typed shape `processRow` accepts. Pre-validation and
   * normalisation live here. Returning `__error` skips the row at
   * `processRow` time and records the error.
   */
  parseRow: (raw: Record<string, string>) => TRow | { __error: string; __code: string };

  /**
   * Process one parsed row. Runs in its own transaction wrapper
   * provided by the framework. Return the created entity's id on
   * success; throw a tagged error (with `code`) on failure.
   */
  processRow: (
    ctx: HandlerContext,
    row: TRow,
  ) => Promise<{ entityId: string }>;
}

export interface HandlerContext {
  utilityId: string;
  actorId: string;
  actorName: string;
  /** Tx client the row should write through; framework manages commit/rollback. */
  tx: PrismaTx;
  /** Helper for handlers that need to emit audit rows or notifications. */
  audit: AuditFns;
}
```

Handlers register themselves at module load:

```typescript
// packages/api/src/imports/handlers/meter-read.ts
import { registerImportKind } from "../registry.js";

registerImportKind({
  kind: "meter_read",
  label: "Meter reads",
  module: "meter_reads",
  permission: "CREATE",
  canonicalFields: [...],
  templateRows: [...],
  parseRow: (raw) => { ... },
  processRow: async (ctx, row) => {
    // Existing meter-read import logic, refactored to take one row.
    ...
  },
});
```

The registry is loaded once at API boot from `packages/api/src/imports/handlers/index.ts`. No auto-discovery — explicit imports keep dependency graph honest.

---

## Test strategy

### Per-slice integration tests

Each slice ships with testcontainers tests:

- **Slice 1 (foundation)**: import-batch CRUD, kind registry dispatch, generic routes, meter-read handler still passes existing import tests, `/imports` list + detail page render correctly.
- **Slice 2 (async)**: BullMQ worker happy-path; zombie detection sweep; cancel mid-processing; retry flow; notification emission.
- **Slice 3 (customer)**: customer handler parse + process; field mapping; error reporting; second consumer validates the abstraction holds.

### Unit tests

- Mapping auto-detection across alias/edge cases (two headers matching same canonical, missing required field, etc.)
- Status transition logic (terminal states, can't transition back, retry rules)
- Notification payload formatting

### Manual QA checklist

- Upload 50k row meter-read import → async path → poll → notification on complete.
- Cancel a running import after ~5s → status CANCELLED, partial rows committed.
- Kill the worker mid-import → restart API → batch resumes from where it stopped.
- Upload with intentional bad rows → drill into errors, download CSV, fix in Excel, re-upload → succeeds.

---

## Migration path

Slice 1 ships the framework AND deletes the old meter-reads-specific import code in one cohesive change:

- `POST /api/v1/meter-reads/import` and `GET /api/v1/meter-reads/import/template.csv` are **removed**.
- The existing `importMeterReads` service function is gutted; its parsing/validation/processing logic moves into `packages/api/src/imports/handlers/meter-read.ts` as a kind handler.
- The existing `/meter-reads/import` UI page becomes a thin shell mounting `<ImportWizard kind="meter_read" />`.
- Existing integration tests for meter-reads import (`packages/api/src/__tests__/integration/meter-read-import.integration.test.ts`) are rewritten to test through the generic POST `/api/v1/imports` endpoint with `kind=meter_read`. Test coverage stays at parity (or higher).
- The existing `importMeterReadsSchema` validator is replaced by per-handler validation; the shared validator file is updated.

No external callers of the old endpoints exist (greenfield project), so removal is clean.

---

## Slicing

### Slice 1 — Foundation + meter-reads migration
Schema (entity_kind, ImportRow table, InAppNotification table, drops). Kind registry + handler interface. Generic routes (POST /imports multipart, GET list/detail/rows/error-summary/errors.csv, kinds metadata + template). Server-side `papaparse` ingest + Attachment storage. Refactor existing meter-read import logic into a kind handler; delete the old endpoint and wire the existing `/meter-reads/import` UI page to mount `<ImportWizard kind="meter_read" />`. New `/imports` list and `/imports/:id` detail pages. Existing meter-reads import tests rewritten through the generic path. Sync-only in this slice (≤ 250 rows).

### Slice 2 — Async + notifications + cancel/retry  *(✓ shipped 2026-04-28)*
BullMQ `imports` queue + `import-worker`. Sync/async threshold (≤ 250 rows runs inline; > 250 rows enqueues + 202 response). Wizard polls `/imports/:id` during PROCESSING and renders a progress bar. Zombie-batch detection on worker boot (PROCESSING with `last_progress_at` > 5 min flips back to PENDING and re-enqueues). `POST /imports/:id/cancel` (soft) and `/imports/:id/retry` (FAILED/PARTIAL → errors-only; CANCELLED → pending-and-errors). `InAppNotification` row emitted on terminal transitions. Email via existing notification template system (new `import.complete` event type, seeded for the dev tenant). Per-user opt-out lives at `UserPreference.preferences.notifyOnImportComplete` (default true) — read from the backend; the per-user toggle UI is deferred until a profile/preferences page exists. Hard cap raised to 100k rows.

### Slice 3 — Customer handler
First non-meter-read consumer. Customer canonical fields, parser, processRow. `/customers/import` page mounts `<ImportWizard kind="customer" />`. Integration tests mirror Slice 1's. Validates the abstraction holds; this is the slice that earns the framework.

### Slice 4a — Premise / Meter / Account handlers  *(✓ shipped 2026-04-29)*
Three new handlers (`premise`, `meter`, `account`) and three `/<entity>/import` pages mounting the existing `<ImportWizard>`. Premise resolves owner-by-email and commodity-codes via `prepareBatch`. Meter resolves premise (composite address+zip), commodity-by-code, and UoM-by-code-per-commodity in `prepareBatch`; ambiguous premises and unique-meter-number conflicts surface as row-level errors. Account resolves customer-by-email and surfaces unique-account-number conflicts as `DUPLICATE_ACCOUNT`.

### Slice 4b — Bell icon
Topbar bell renders unread `InAppNotification` rows (since by now there are enough notifications to make the bell worth its space). Backend endpoints (`GET /notifications/unread`, `POST /notifications/:id/read`, `POST /notifications/read-all`) are also part of this slice.

Each slice gets its own plan in `docs/superpowers/plans/`.

---

## Decisions resolved

| Decision | Outcome |
|---|---|
| Parsing location | Server is the parser of record; client peeks first 50 rows for the mapping UI. Both use `papaparse` (added to shared package). |
| File storage | Original uploaded file stored via existing `Attachment` table, polymorphic on `(entityType="ImportBatch", entityId=batch.id)`. No new blob storage. |
| Backwards compat | None — existing `/api/v1/meter-reads/import` is removed in Slice 1; greenfield project, no external callers. |
| Sync threshold | Start at 250 rows; revisit after we have real timing data. |
| Email default | ON for async (> 250 rows) imports. Email body includes a one-click "stop emailing me about imports" link that flips the user's `notify_on_import_complete` preference. Sync imports never email — operator was watching the wizard. |
| Bell-icon UI | Phase 1 emits `InAppNotification` rows but does NOT render a topbar bell. The detail page already shows status. Bell renders alongside the second batch of consumer pages (Slice 4) so the cost is amortised. |
| `import_row` retention | Defer the policy. Rows stay forever in Phase 1; a sweep can prune `> 90 days terminal` rows in a future slice without breaking anything. |
| `errors` JSON column on `ImportBatch` | Dropped in the migration. Per-row errors live in `import_row`. |
| Max file size | 50 MB in Phase 1. ~500k rows of typical CSV. Larger files are a Phase 3 streaming concern. |

---

## Phase Roadmap

- **Phase 1 (this slice plan)**: Slices 1+2+3 ship together (framework + async + customer consumer).
- **Phase 2**: premise / meter / account handlers; bell-icon UI; mapping presets server-side; original-file storage.
- **Phase 3**: streaming uploads for very-large batches; scheduled imports (cron-driven AMI ingest); webhook on completion.
