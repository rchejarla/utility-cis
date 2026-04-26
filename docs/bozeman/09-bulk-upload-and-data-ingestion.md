# 09 — Bulk Upload & Data Ingestion

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/api/src/routes/imports/*` (channel-specific endpoints), `packages/api/src/services/ingestion/*` (channel-agnostic pipeline core), `packages/api/src/workers/sftp-poller.ts` (scheduled file drops), `packages/api/src/workers/import-processor.ts` (async batch worker), and `packages/web/app/(admin)/imports/*` (operator UI). Cross-cuts with [07-data-validation.md](./07-data-validation.md) (Tier 4 integration-time validation), [04-attachments.md](./04-attachments.md) (multipart upload primitives reused for file reception), [06-custom-fields.md](./06-custom-fields.md) §4.4 (custom-field columns appear in CSV templates), and [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) (ImportBatch + raw-file retention class).
**Status:** Drafted — substantial gaps. The web UI for meter-read import exists as a three-stage wizard, but the backend it calls (`POST /api/v1/meter-reads/import`) does not. No XML parsing, no Excel parsing, no SFTP, no reference-data bulk endpoints, no per-row error collection, and the existing `ImportBatch` table is wired to nothing. The validation pipeline this doc relies on is itself partial — see [07-data-validation.md](./07-data-validation.md).
**Effort estimate:** L (~10-13 weeks engineering). The largest cost is the **channel-agnostic ingestion pipeline core** (validate → stage → commit-or-reject → report → audit), reused across UI/API/SFTP and across all 6+ entity types. Once the core lands, each new channel and each new reference-data entity type is M effort. The critical-path dependency is finishing doc 07's entity-rules registry — without it, "validation report" can only return type-error noise.

---

## 1. RFP commitment (verbatim)

> Bulk upload of transactions and reference data is supported via UI (CSV/Excel), API (JSON/XML), and SFTP for scheduled file drops. All uploads pass through validation; only valid records are committed. Validation report (success count, failure count, per-row error reasons) is produced for every upload and retained in the audit log.

The commitment decomposes into **four guarantees**:

1. **Three ingest channels** — UI, API, SFTP — must all work, all flow through the same validation, and all support the same entity types.
2. **Two transaction types** — operational transactions (meter reads, payments, adjustments) and reference data (commodities, rate schedules, premises, meters, customers).
3. **Validation gate is non-bypassable** — only valid records are committed; invalid records are rejected and reported.
4. **Validation report is generated for every upload** — success count, failure count, per-row reasons — and the report itself is retained in the audit log (not just transient).

This doc defines the shape of the **ingestion pipeline** and the per-channel, per-entity rules. Where validation logic itself is concerned, this doc references [07-data-validation.md](./07-data-validation.md) rather than restating.

---

## 2. Current state — what exists today

### 2.1 UI channel — CSV/Excel ⚠ Partial

**Status: UI exists for one entity (meter reads); backend missing; Excel not supported.**

- **Web UI:** `packages/web/app/meter-reads/import/page.tsx` — three-stage wizard (Upload → Preview → Commit) accepting `.csv` and `.json` via drag-and-drop or paste. Client-side parser validates required fields (`meter_number`, `read_datetime`, `reading`). Preview shows first 10 rows.
- **`@fastify/multipart` is installed** but not used by any import route.
- **Backend endpoint:** `POST /api/v1/meter-reads/import` does **not exist**. The UI code (line 175-181 of the page) explicitly says: *"Backend endpoint not yet implemented — the import route is a Phase 2/3 follow-up."*
- **Excel parsing:** zero dependencies (`xlsx`, `exceljs`) in `package.json`.
- **No other entity has a bulk-import UI** — no admin page for commodities, rate schedules, premises, meters, customers.

### 2.2 API channel — JSON/XML ⚠ Partial (JSON shape only)

**Status: A multi-row JSON shape exists for meter reads; no XML; no other entities.**

- `POST /api/v1/meter-reads` (`packages/api/src/routes/meter-reads.ts:68-87`) accepts a `{ readings: [...] }` array via `createMeterReadEventSchema`. Each row validated; transactional commit per the multi-register event semantics in [docs/specs/08-meter-reading.md](../specs/08-meter-reading.md).
- This is **not** a dedicated batch endpoint — it's the existing single-event endpoint that happens to accept multiple registers per event. There is no `/batch` or `/bulk` endpoint that accepts an array of independent rows with per-row error collection.
- **XML:** zero parsing dependencies (`fast-xml-parser`, `xml2js`). The web UI mentions XML in its file-type list but no server-side parser exists. No MV-90 / MV-90A standard meter-data-exchange format support.
- **No batch endpoints for any other entity** — payment, adjustment, customer, premise, meter, rate, commodity all expose single-row CRUD only.

### 2.3 SFTP channel — scheduled file drops ✗

**Status: Not implemented.**

- Zero SFTP libraries (`ssh2-sftp-client`, `ssh2`) in `package.json`.
- No SFTP polling worker. No cron-scheduled file fetch. No "drop directory" abstraction.
- The BullMQ worker infrastructure exists (per [scheduler migration](../specs/14-service-requests.md)) and is the natural place to add a polling worker — but the worker doesn't yet exist.
- No tenant configuration for SFTP credentials, host, key fingerprint, drop path.

### 2.4 Validation pipeline — per-row ⚠ Partial

**Status: Strong field-level + meter-read-specific exception detection; no batch-level "collect-all-errors-then-report" pattern.**

- Field-level validation via Zod is strong for every entity (32 validators in `packages/shared/src/validators/` per [07-data-validation.md](./07-data-validation.md) §2).
- Meter-read-specific exception detection (`computeConsumption()` flags ROLLOVER, METER_DEFECT, REVERSE_FLOW; `resolveServiceAgreementId()` validates active agreement at read date) lives in `packages/api/src/services/meter-read.service.ts`.
- **Critical gap:** when import runs, the existing services throw on first error. There is no try-catch-and-collect pattern for "import 990 of 1000 rows, report 10 errors." A single bad row aborts the whole batch.
- **No premise-eligibility validation on meter reads** (RFP-cited example) — see [07-data-validation.md](./07-data-validation.md) §2.4. Doc 07 commits FR-VAL-030 to add it.

### 2.5 Validation report ✗

**Status: Schema exists, never populated, no retrieval endpoint.**

`ImportBatch` table exists at `packages/shared/prisma/schema.prisma:1031-1049`:

```prisma
model ImportBatch {
  id             String   @id @default(uuid()) @db.Uuid
  utilityId      String   @map("utility_id") @db.Uuid
  source         ImportBatchSource  // AMR | AMI | MANUAL_UPLOAD | API
  fileName       String?
  recordCount    Int @default(0)
  importedCount  Int @default(0)
  exceptionCount Int @default(0)
  errorCount     Int @default(0)
  status         ImportBatchStatus  // PENDING | PROCESSING | COMPLETE | FAILED
  errors         Json?  // shape undefined
  createdBy      String   @db.Uuid
  createdAt      DateTime
  completedAt    DateTime?
}
```

`MeterRead` carries `importBatchId` to link reads back to their batch. But:

- No code path writes `ImportBatch` rows. The table is empty.
- The `errors` JSON has no defined shape.
- No API endpoint returns `ImportBatch` rows (no `GET /api/v1/imports/:batchId`).
- The web UI has commit-stage placeholders for "IMPORTED / EXCEPTIONS / ERRORS" counts but no real backend feeds them.

### 2.6 Audit-log integration ✗

**Status: Imports emit no audit rows.**

- `meter-read.service.ts` emits domain events via `domainEvents.emitDomainEvent()` but does **not** call `auditCreate()`. Imported rows arrive silently.
- ImportBatch lifecycle events (start, progress, complete, fail) are not audited.
- Per-row validation failures are not individually logged; nothing audits "row 47 rejected because read_datetime is in the future."
- Per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md), the broader audit-log infrastructure has 9-of-15 gaps as well; this doc cannot rely on audit until those are closed.

### 2.7 Reference-data import ✗

**Status: No bulk-import path for any reference-data entity.**

- `Commodity` (`packages/api/src/routes/commodities.ts`) — CRUD only. No `/import`.
- `RateSchedule` (`packages/api/src/routes/rate-schedules.ts`) — CRUD only.
- `Premise` (`packages/api/src/routes/premises.ts`) — CRUD only.
- `Meter` — CRUD only.
- `Customer` — CRUD only.
- The repo-root `seed.js` is for test/dev data, not a user-facing import facility.

### 2.8 Idempotency / duplicate detection ⚠ Partial

**Status: Unique constraints prevent duplicate inserts but no skip-and-count handling.**

- `MeterRead` has a unique constraint on `(meter_id, register_id, read_datetime, read_source)` (`schema.prisma:504`). Re-uploading the same CSV throws `P2002` Prisma errors mid-batch and currently halts the import.
- No file-level idempotency token (`fileHash`, `externalRef`) on `ImportBatch`. Two SFTP fetches of the same file process it twice.
- No upsert semantics — re-importing a corrected reading fails with the same `P2002` error rather than updating.
- `ImportBatch` schema has no `skippedCount` field (only imported/exception/error).

### 2.9 File size, row count, async processing

- No documented row-count limit. A 1M-row CSV is parsed entirely in browser memory client-side.
- No streaming parser anywhere — the existing UI loads the whole file into a JS string before parsing.
- BullMQ infrastructure exists but no import-processor worker is defined; the (nonexistent) `POST /import` endpoint would have to enqueue jobs, which it cannot.

### Summary

| Dimension | Today |
|---|---|
| CSV upload via UI | ⚠ UI for meter reads only; backend missing |
| Excel upload | ✗ |
| API JSON bulk | ⚠ Multi-register meter-read shape only; no batch/array endpoint for other entities |
| API XML | ✗ |
| SFTP scheduled drops | ✗ |
| Per-row validation with error collection | ✗ — single error aborts batch |
| Validation report | ✗ — table exists, never populated |
| Audit-log integration for imports | ✗ |
| Reference-data bulk import | ✗ |
| Idempotency / duplicate skip-and-count | ⚠ Constraint exists, no handling |
| File size / row limits | ✗ |
| Async processing with progress | ✗ |
| Operator UI for import history/monitoring | ✗ |

---

## 3. Functional requirements

### 3.1 Channel-agnostic ingestion pipeline core

The system MUST converge UI, API, and SFTP onto a single pipeline. Everything channel-specific lives at the edges; the core (parse → validate → stage → commit → report → audit) is shared.

#### 3.1.1 Pipeline stages

```
[ Channel-specific ]                   [ Channel-agnostic core ]
  Receive bytes  ─→  Detect format  ─→  Parse to row stream  ─→  Validate per row
                                                                        ↓
                                            ┌─── valid rows ──────→ Stage  ─→  Commit  ─→  Report  ─→  Audit
                                            ↓
                                       invalid rows ───────────────→ Stage error rows ───────────→ (no commit)
```

- **FR-ING-001** — Every ingest channel (UI multipart, API JSON, API XML, SFTP file fetch) MUST converge into the same `ingestion.processBatch(batchInput, channelMetadata)` service entrypoint. The entrypoint receives a `Readable<RowInput>` stream + a metadata object identifying the channel, source identity, file name, file SHA-256, originating actor (user ID for UI/API, system actor for SFTP), and target `entityType`.
  - **Acceptance:** Unit test verifies that the same 10-row CSV uploaded via UI vs. submitted via API vs. delivered via SFTP produces three `ImportBatch` rows that are byte-identical except for `source`, `created_by`, and `external_ref`.

- **FR-ING-002** — Each entity type ingestible via this pipeline (meter reads, payments, adjustments, commodities, rate schedules, premises, meters, customers, plus extension points for future entities) MUST register an `EntityIngestor<TRow>` definition that supplies:
  - `entityType` — string key
  - `parseFormats` — list of supported formats (`["csv", "excel", "json", "xml"]`, subset per entity)
  - `csvHeaderTemplate` — column order + per-column header (drives template download in the UI)
  - `validateRow(row, ctx)` — returns either valid `TRow` or `RowError[]`
  - `commitBatch(rows, tx)` — single-transaction insert or upsert path
  - `auditClass` — retention class per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md)
  - `idempotencyKey(row)` — function returning natural key tuple for duplicate detection
  - **Acceptance:** Adding a new ingestible entity type means writing one `EntityIngestor` and registering it. The pipeline core changes zero.

- **FR-ING-003** — Pipeline runs in three phases: **dry-run / preview → stage → commit**.
  - *Dry-run / preview*: parse + validate without staging. Returns the per-row result (valid | error | duplicate-of-existing | duplicate-within-file) and rolls up counts. Default for the UI's preview step. Required pre-step for the SFTP channel as well — if dry-run fails the whole-batch rejection threshold (FR-ING-040), the file is moved to a quarantine directory and an alert fires.
  - *Stage*: write all rows to a temporary staging area (a per-batch row set keyed by `import_batch_id`, scoped to the same `RetentionClass.OPERATIONAL_LOG` as the batch itself). Allows a human approver to review N rows before commit.
  - *Commit*: move staged-and-valid rows to their target tables in a single transaction per chunk (chunk size configurable, default 1000 rows). Invalid rows stay in staging with their error reasons and are visible in the validation report.

  Channels MAY skip stage and commit directly (UI's "commit immediately" option, API's default) — but the option to stage exists for SFTP (auto-staged; commit on operator approval) and for sensitive entity types (rate schedules, customer mass-imports — both stage by default).

#### 3.1.2 Streaming-first

- **FR-ING-010** — The pipeline MUST be streaming-first. Files are not loaded fully into memory at any stage. Backpressure flows from the validate step (slow per-row work) back to the parser (fast). This is non-negotiable for SFTP files that may exceed available memory.
  - **Acceptance:** Importing a 5GB CSV holds steady at <500MB peak RSS in the worker process. Verified via integration test with a synthetic 10M-row CSV and `--max-old-space-size=512`.

- **FR-ING-011** — The CSV parser MUST be `csv-parse/sync` for small (<10K row) files and `csv-parse` (streaming) for everything else. The UI may use the sync variant for preview; the SFTP / API paths MUST use the stream variant. The Excel parser MUST be `exceljs` with its row-iteration API (also streaming).
  - **Acceptance:** Streaming variant used in worker code; verified via grep `csv-parse/sync` appears only in UI server-side preview path.

#### 3.1.3 Format detection

- **FR-ING-015** — Format is determined by a precedence chain: explicit `format` query param > `Content-Type` header > file extension > content sniff (`<?xml` prefix, BOM detection, `[` or `{` first character). Ambiguous content rejects with a clear error citing the precedence chain.
  - **Acceptance:** A file named `data.csv` with `Content-Type: application/json` is treated as JSON (header wins); a file with no extension and `Content-Type: application/octet-stream` and content `meter_id,reading,...` falls back to content sniff and parses as CSV.

### 3.2 UI channel — CSV/Excel

- **FR-ING-020** — A unified import UI at `/imports/<entityType>` for every ingestible entity. The page presents:
  1. **Format selector** — CSV / Excel / JSON. Each entity declares which it supports (meter reads support all three; rate schedules support CSV/Excel only).
  2. **Template download** — clicking "Download CSV template" generates a CSV with the entity's headers (per `EntityIngestor.csvHeaderTemplate`) plus all enabled custom-field columns ([06-custom-fields.md](./06-custom-fields.md) §4.4 commits this for CSV exports; this doc commits the same shape for **import** templates).
  3. **Drag-and-drop** + click-to-browse upload, max 100MB per file (configurable per tenant).
  4. **Preview stage** — server-side dry-run, returns first 50 rows + per-row status. UI renders a table with rows colored: green (valid), yellow (warning, e.g., duplicate-of-existing), red (error). Each red row has an inline error reason.
  5. **Commit stage** — operator clicks "Commit valid rows" to commit. Invalid rows are summarized in the post-commit report. UI surfaces a download link for the validation report.

- **FR-ING-021** — Excel files MUST support the first sheet by default. Multi-sheet Excel files trigger a sheet-picker. Sheets named `__metadata` or starting with `_` are reserved for future template-metadata use.

- **FR-ING-022** — UI must surface clear feedback for the boundary cases: empty file (rejected), header-only file (rejected as zero data rows), encoding mismatch (UTF-8 BOM stripped automatically; UTF-16 with BOM auto-detected; other encodings rejected with a "save as UTF-8 and retry" message), and CRLF vs. LF line endings (both accepted).

- **FR-ING-023** — File parsing happens server-side, not in browser JavaScript. The current client-side CSV parser in `meter-reads/import/page.tsx` is deprecated; previews are computed server-side via the new dry-run endpoint. (Reasoning: client-side parsing is fragile across CSV dialects and impossible for large Excel files in the browser. Single source of truth = server.)

### 3.3 API channel — JSON/XML

- **FR-ING-030** — A new `POST /api/v1/imports/<entityType>` endpoint accepts:
  - `Content-Type: multipart/form-data` with a file part (`csv` / `xlsx` / `json` / `xml`)
  - `Content-Type: application/json` with a body `{ "rows": [...] }` — rows are JSON objects matching the entity schema.
  - `Content-Type: application/xml` with a body containing `<rows><row>...</row></rows>` — XML structure mirrors the JSON shape.
  - Query params: `?dry_run=true|false` (default false), `?stage_only=true|false` (default false), `?on_error=reject_batch|reject_rows` (default reject_rows).
  - **Acceptance:** OpenAPI spec generated for every entity's endpoint — auto-generated from `EntityIngestor` definitions per the same pattern as [06-custom-fields.md](./06-custom-fields.md) FR-CF-090 (per-tenant OpenAPI variant). Run integration tests for all three content types per entity.

- **FR-ING-031** — XML support uses `fast-xml-parser`. The XML schema for each entity matches the JSON shape via attribute or element preference (configurable per tenant). Default: elements (`<row><meter_id>...</meter_id></row>`). MV-90 / MV-90A meter-data-exchange format is supported as a **specialized format** for the meter-read entity only (FR-ING-061).

- **FR-ING-032** — The endpoint returns `202 Accepted` with `{ "import_batch_id": "...", "links": { "self": "/api/v1/imports/<id>", "rows": "/api/v1/imports/<id>/rows" } }` for async processing (default for files >10MB or >10K rows). Smaller submissions return `200 OK` with the full validation report inline.

- **FR-ING-033** — The endpoint enforces the same per-row rate-limiting + tenant quota (FR-ING-110) as the UI and SFTP channels. Submissions exceeding the per-day row-count quota are rejected with `429 Too Many Requests` and a clear retry-after header.

- **FR-ING-034** — An idempotency-key header (`Idempotency-Key`) is supported. Submitting the same key twice within 24h returns the original `ImportBatch` instead of creating a new one. Idempotency keys are tenant-scoped; collisions across tenants don't matter.

### 3.4 SFTP channel — scheduled file drops

- **FR-ING-040** — A new `sftp_drop_config` table holds per-tenant SFTP configuration:

  ```prisma
  model SftpDropConfig {
    id                 String    @id @default(uuid()) @db.Uuid
    utilityId          String    @map("utility_id") @db.Uuid
    name               String    // operator label, e.g., "AMI vendor daily"
    host               String
    port               Int       @default(22)
    username           String
    authMethod         String    @map("auth_method")  // "key" | "password"
    privateKeySecretRef String?  @map("private_key_secret_ref")  // KMS path; never stored in DB
    passwordSecretRef   String?  @map("password_secret_ref")     // ditto
    knownHostFingerprint String  @map("known_host_fingerprint")  // SHA-256, required
    pollPath           String    @map("poll_path")  // "/incoming/"
    archivePath        String    @map("archive_path")  // "/processed/"
    quarantinePath     String    @map("quarantine_path")  // "/quarantine/"
    fileGlob           String    @default("*")  // e.g., "AMI_*.csv"
    targetEntityType   String    @map("target_entity_type")  // which EntityIngestor handles these files
    targetFormat       String    @map("target_format")  // "csv" | "xml" | "mv90"
    pollIntervalMinutes Int      @default(15) @map("poll_interval_minutes")
    enabled            Boolean   @default(false)
    onErrorPolicy      String    @default("quarantine") @map("on_error_policy")
    notifyEmails       String[]  @map("notify_emails")  // alert recipients on quarantine
    @@unique([utilityId, name])
    @@map("sftp_drop_config")
  }
  ```

  Credentials are **NEVER** stored in the database — the `*SecretRef` columns hold KMS reference strings. Actual keys/passwords live in AWS Secrets Manager (or equivalent per tenant infrastructure). `enabled = false` default — same defense-in-depth as retention policies in [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md).

- **FR-ING-041** — A new `sftp-poller` BullMQ scheduler ticks every 5 minutes (the worker's clock; not per-tenant). Each tick:
  1. Queries `sftp_drop_config WHERE enabled = true`.
  2. For each config, computes whether the next poll is due (lastPolledAt + pollIntervalMinutes < now).
  3. Connects with `ssh2-sftp-client`, verifies the host fingerprint against `knownHostFingerprint` (mismatch → quarantine + alert + disable config), lists files matching the `fileGlob`, and for each file:
     - Downloads to a tenant-scoped local temp directory.
     - Computes SHA-256 of the file.
     - Checks `import_batch WHERE source = 'SFTP' AND file_sha256 = <hash>` — if exists, the file has already been processed; move to `archivePath` without re-importing (idempotency at the file level).
     - Otherwise enqueues a `process-file` job to the `import-processor` queue with `{ tenantId, dropConfigId, localPath, fileName, fileSha256 }`.
  4. The poller does not parse or validate. Its only job is fetch + dedupe + enqueue.

- **FR-ING-042** — The `import-processor` worker dequeues `process-file` jobs, runs the file through the pipeline core (FR-ING-001+), and on completion:
  - On success → moves the file from temp dir to the SFTP `archivePath` (rename via SFTP) AND deletes the local temp copy.
  - On hard failure (file unparseable, exceeds rejection threshold) → moves to `quarantinePath` AND sends an alert email per `notifyEmails` AND emits an `AUDIT_OPERATIONAL` audit row.
  - On partial failure (some rows rejected, batch within threshold) → moves to `archivePath` AND emits the validation report; the operator inspects via the operator UI.

- **FR-ING-043** — `onErrorPolicy` controls behavior when validation rejects rows:
  - `quarantine` (default for sensitive imports, e.g., rate schedules): even partial failure quarantines the whole file.
  - `partial_commit` (default for high-volume imports, e.g., AMI meter reads): commit valid rows, report invalid ones, archive the file.
  - `dry_run_only` (for testing a new SFTP integration): dry-run only, never commits, always quarantines for human review.

- **FR-ING-044** — SFTP host-key fingerprints MUST be set out of band (not auto-trusted on first connection). The `sftp_drop_config` row cannot save with an empty `knownHostFingerprint`. Setup workflow: operator runs `saaslogic-sftp-fetch-fingerprint <host>` from a trusted client, copies the SHA-256 fingerprint into the UI. Saving the config without a fingerprint returns a 422 with explanatory text.

- **FR-ING-045** — Per-tenant SFTP polling MUST be rate-limited at the worker level: at most 5 concurrent SFTP connections per tenant; at most 50 across all tenants on a single worker. Configurable via `WORKER_SFTP_CONCURRENCY` env.

### 3.5 Validation gates — non-bypassable

- **FR-ING-050** — Every ingest channel MUST flow through the same validation gate. There is no "skip validation" option — even operator-bypass requests go through the gate, and bypass is implemented as a *post-gate manual override per-row* with required reason text and audit emission, never as a gate skip.

- **FR-ING-051** — Validation runs in the order defined by [07-data-validation.md](./07-data-validation.md):
  1. **Tier 1 — Field-level** (Zod): type/format/range/required/regex per column.
  2. **Tier 2 — Cross-field** (`.refine()` calls in the validator): e.g., start-date < end-date, dependent picklists.
  3. **Tier 3 — Entity-level** (entity-rules registry from doc 07 FR-VAL-020): e.g., a meter-read row's `meter_id` exists in the tenant's meter table; a payment row's `account_id` is in `OPEN` status.
  4. **Tier 4 — Integration-time** (per-entity, per-channel): e.g., meter-read `read_datetime` not in the future; meter's premise eligible at read time per doc 07 FR-VAL-030; reading not less than the prior read for the same register (rollover detection); payment amount not exceeding the open balance + a configurable tolerance.

  Tiers 1-2 are stateless (pure functions); tiers 3-4 require database lookups. The pipeline batches tier-3 lookups (e.g., one query for "all meter_ids in this batch") to avoid per-row DB roundtrips.

- **FR-ING-052** — Every validation failure MUST produce a structured `RowError`:

  ```typescript
  type RowError = {
    rowNumber: number;        // 1-based row in input file (header is row 0)
    rowData: Record<string, unknown>;  // verbatim input row
    severity: "error" | "warning";
    code: string;             // e.g., "FIELD_TYPE", "REGISTER_NOT_FOUND", "FUTURE_READ_DATETIME"
    field?: string;           // e.g., "read_datetime" — null for cross-row/entity errors
    message: string;          // actionable, per doc 07 FR-VAL-040 — never raw Zod text
    rule: string;             // human-readable rule citation, e.g., "Tier 4 / FR-ING-061 / read_datetime must not be in the future"
  };
  ```

  The `message` is operator-actionable, never raw error stringification. Examples (good vs. bad):
  - ✓ Good: `"read_datetime is 2027-04-29T10:00:00Z but the latest accepted read for meter M-1234 register R1 was 2027-04-29T11:00:00Z. Re-export from your AMI head-end with the correct timestamps."`
  - ✗ Bad: `"Invalid date"`

- **FR-ING-053** — Multiple errors per row MUST be collected and reported (don't short-circuit on first failure). A row with 3 problems shows 3 error rows in the report. Per-row error count is bounded (max 10 errors per row; further errors collapse into "and N more").

### 3.6 Commit-only-valid semantics

- **FR-ING-060** — Default behavior: **valid rows commit; invalid rows are rejected and reported.** The configuration this overrides comes via `?on_error=reject_batch` (or per-channel/per-entity policy):
  - `reject_rows` (default): commit valid, reject invalid.
  - `reject_batch`: any invalid row aborts the entire batch — nothing commits.
  - `reject_batch_threshold:<percent>`: if more than X% of rows are invalid, abort; otherwise commit valid.

- **FR-ING-061** — Per-entity defaults are set in `EntityIngestor.defaultErrorPolicy`:
  - Meter reads (high volume; one bad row shouldn't lose the day's data): `reject_rows`.
  - Payments (financial; selective commit risks money mismatches): `reject_batch_threshold:0` (any error aborts).
  - Rate schedules (sensitive reference data; partial commit corrupts pricing): `reject_batch`.
  - Customers (mass migration; selective commit may leave orphan accounts): `reject_batch_threshold:5`.

- **FR-ING-062** — Commit MUST be transactional per chunk (default 1000 rows). A worker crash mid-commit leaves N committed chunks visible and N+1...M staged-but-uncommitted. The worker resumes from the last committed chunk on restart (state in `import_batch.last_committed_chunk_index`). Commits are idempotent — re-running a chunk that's already committed is a no-op via the per-row idempotency key (FR-ING-080).

- **FR-ING-063** — Within a chunk, individual row failures during commit (rare — race conditions like a meter being deleted between validation and commit) are caught, logged as `RowError`s with `severity: "error"` and `code: "COMMIT_RACE"`, and the chunk's other rows still commit. The batch report tells the operator "row 47 failed at commit time because meter M-1234 was deleted at 2027-04-29T03:00:00Z by user U-5678."

### 3.7 Validation report — generation, retrieval, retention

- **FR-ING-070** — At the end of every batch run, the system produces a **validation report** with structure:

  ```json
  {
    "batchId": "...",
    "tenantId": "...",
    "entityType": "meter_read",
    "channel": "sftp",
    "fileName": "AMI_20270429.csv",
    "fileSha256": "...",
    "submittedBy": "...",
    "startedAt": "...",
    "completedAt": "...",
    "summary": {
      "totalRows": 12345,
      "committed": 12300,
      "rejected": 40,
      "skippedDuplicate": 5,
      "warnings": 12
    },
    "errors": [
      { "rowNumber": 47, "code": "FUTURE_READ_DATETIME", "field": "read_datetime", "message": "...", "rowData": { ... } },
      { "rowNumber": 102, "code": "REGISTER_NOT_FOUND", "field": "register_number", "message": "...", "rowData": { ... } },
      ...
    ],
    "warnings": [ /* same shape, severity: "warning" */ ]
  }
  ```

  Reports are written to:
  1. A new `ImportBatchReport` table (single row per batch, JSON column for the structured payload).
  2. An S3 object at `s3://saaslogic-imports/{tenantId}/reports/{yyyymmdd}/{batchId}.json` with KMS encryption — per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) lifecycle for `OPERATIONAL_LOG` retention class (default 2 years).
  3. The audit log — one `AUDIT_OPERATIONAL` row per batch with `action: "IMPORT_BATCH_COMPLETE"`, `metadata: { batchId, summary }`, `s3ReportKey` reference. The full report is **not** inlined into `audit_log` (would explode row sizes); the audit row points at the S3 object.

- **FR-ING-071** — The validation report is retrievable via:
  - `GET /api/v1/imports/<batchId>` — returns batch summary + status + S3 link.
  - `GET /api/v1/imports/<batchId>/report` — proxies the S3 object (KMS-decrypted, streamed). Permission-checked against the original submitting tenant.
  - `GET /api/v1/imports/<batchId>/rows?status=error|warning|committed` — paginated rows from the staging area. (Staging persists for 30 days post-batch-completion; configurable per tenant.)

- **FR-ING-072** — The operator UI (FR-ING-100) renders the report with: summary stats card, error table (sortable, filterable, exportable as CSV for resubmission after fixes), warning table, committed-rows table.

- **FR-ING-073** — Every batch's report is **discoverable** via the audit log even decades later: the audit row contains the S3 key, and the S3 lifecycle (per doc 08) tiers the report to Glacier IR after 1 year, Glacier Deep Archive after 2 years, then deletes per the `OPERATIONAL_LOG` retention class. Reports for batches affecting `FINANCIAL`-class data (payments, adjustments) are retained on the FINANCIAL floor (7 years) per doc 08 FR-RET-002.

### 3.8 Audit-log integration

- **FR-ING-080** — Imports MUST write to the audit log at three lifecycle points:
  1. **Submission** — an `AUDIT_OPERATIONAL` row with `action: "IMPORT_BATCH_SUBMITTED"`, actorId, channel, target entityType, file metadata.
  2. **Per-row commit** — when a row commits, an audit row of the row's natural class (`AUDIT_FINANCIAL` for payment imports; `AUDIT_OPERATIONAL` for meter-read imports; etc.) with `action: "CREATE"` or `"UPDATE"` (for upserts), `entity_id` of the new row, `metadata: { importBatchId }`. This is consistent with how non-import writes audit per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md).
  3. **Completion** — an `AUDIT_OPERATIONAL` row with `action: "IMPORT_BATCH_COMPLETE"`, summary stats, S3 report key.

  Per-row audit writes are batched into the same transaction as the data row commit (consistent with the existing `auditCreate()` wrapper pattern in `packages/api/src/lib/audit-wrap.ts`). Volume note: a 100K-row import emits ~100K + 2 audit rows. This is the cost of completeness; doc 01 and doc 08 retention engines manage the volume.

- **FR-ING-081** — Failures (validation rejections) emit a single `AUDIT_OPERATIONAL` row with `action: "IMPORT_BATCH_FAILED"` referencing the report. Per-row rejection details live in the report, not in `audit_log`, to bound audit-log size.

- **FR-ING-082** — Manual operator overrides (FR-ING-050 mentions "post-gate manual override per-row") emit `AUDIT_SECURITY` rows because the operator is bypassing system validation, which is a privilege requiring elevated trust.

### 3.9 Reference-data imports

- **FR-ING-090** — The pipeline supports reference-data entities via the same `EntityIngestor` registry. Initial set:

  | Entity | Channel(s) | Idempotency key | Default error policy |
  |---|---|---|---|
  | `Commodity` | UI, API | `(utility_id, code)` | `reject_batch` |
  | `RateSchedule` | UI, API | `(utility_id, code, version)` | `reject_batch` |
  | `Premise` | UI, API, SFTP | `(utility_id, premiseNumber)` | `reject_batch_threshold:1` |
  | `Meter` | UI, API, SFTP | `(utility_id, meterNumber)` | `reject_batch_threshold:1` |
  | `Customer` | UI, API, SFTP | `(utility_id, customerNumber)` | `reject_batch_threshold:5` |
  | `MeterRead` | UI, API, SFTP | `(meter_id, register_id, read_datetime, read_source)` | `reject_rows` |
  | `Payment` | UI, API | `(utility_id, externalRef)` | `reject_batch_threshold:0` |
  | `Adjustment` | UI, API | `(utility_id, externalRef)` | `reject_batch_threshold:0` |

- **FR-ING-091** — Reference-data imports default to **upsert** semantics (insert-or-update on the idempotency key). Operational-data imports (meter reads, payments, adjustments) default to **insert-only** (duplicates skipped and counted, not overwritten). Each entity overrides this default in its `EntityIngestor`.

- **FR-ING-092** — Reference-data updates via import emit per-row audit rows with `action: "UPDATE"` and full before/after-state diff. Insertions emit `action: "CREATE"`. Skipped duplicates emit nothing (counted in summary, not audited individually — to bound audit volume).

- **FR-ING-093** — The custom-fields engine ([06-custom-fields.md](./06-custom-fields.md)) hooks into reference-data imports identically to operational imports: the entity's CSV template includes all enabled custom-field columns; values are validated by the field's data type + custom validation rules; the same `RowError` shape covers custom-field validation failures.

### 3.10 Idempotency / duplicate detection

- **FR-ING-100** — Three idempotency layers:
  1. **File-level** (SFTP only): SHA-256 of the file. If `import_batch.file_sha256` already exists for the tenant, the file is skipped at the poller layer and not re-processed. Operator UI shows "skipped — duplicate of batch <id>" in the SFTP polling history.
  2. **Submission-level** (API only): `Idempotency-Key` header. Same key within 24h returns the original batch.
  3. **Row-level** (all channels): per `EntityIngestor.idempotencyKey()`. The pipeline pre-fetches existing rows matching the batch's keys, then for each row decides: insert (key not seen) | update (upsert mode) | skip-as-duplicate (insert-only mode).

- **FR-ING-101** — The validation report's `summary` distinguishes the three duplicate dispositions:
  - `committed` — row newly inserted or updated.
  - `skippedDuplicate` — row skipped because identical row exists (insert-only mode).
  - `updated` — row updated by upsert (separate count from committed for clarity).

### 3.11 File size, row count, async, quotas

- **FR-ING-110** — Per-tenant quotas configurable via `tenant_config`:
  - `import_max_file_size_mb` (default 100)
  - `import_max_rows_per_file` (default 1,000,000)
  - `import_max_rows_per_day` (default 10,000,000)
  - `import_max_concurrent_batches` (default 5)

  Exceeding any quota rejects the submission with `429` and a clear retry-after header. SFTP polling skips files exceeding `import_max_file_size_mb` and quarantines them with an explanatory note.

- **FR-ING-111** — Submissions exceeding 10MB or 10K rows are processed asynchronously via the `import-processor` BullMQ worker. The endpoint returns `202 Accepted` immediately. The operator UI polls `GET /api/v1/imports/<batchId>` every 2 seconds to render progress (committed rows / total rows).

- **FR-ING-112** — A batch's `status` lifecycle: `PENDING` → `PARSING` → `VALIDATING` → `STAGED` (only if stage-only) → `COMMITTING` → `COMPLETE` | `FAILED` | `PARTIAL`. The current `ImportBatchStatus` enum (`PENDING | PROCESSING | COMPLETE | FAILED`) is extended.

- **FR-ING-113** — Cancellation: an in-flight batch can be cancelled by the operator if it's still in `STAGED` or earlier. Cancellation moves the batch to `FAILED` with `cancelReason`. `COMMITTING` cannot be cancelled (rows are partially committed; cancellation would create an inconsistent state).

### 3.12 Operator UI — `/imports`

- **FR-ING-120** — A new `/imports` admin page with:
  - **History tab**: table of all `ImportBatch` rows for the tenant, filterable by entity type, channel, status, date range, submitter. Columns: batch ID, channel, entity, status, total/committed/rejected, submitted by, submitted at, completed at.
  - **Active tab**: in-flight batches with progress bars and cancel buttons.
  - **SFTP tab**: per-tenant SFTP drop configurations (FR-ING-040), with status (last-poll-at, files-fetched-today, last-error). Add/edit/disable. Setup wizard guides operators through fingerprint capture.
  - **Templates tab**: download CSV/Excel templates per entity type (current set + custom fields).
  - **Quotas tab**: read-only display of current usage vs. configured quotas.

- **FR-ING-121** — Drill-into-batch view: click a batch ID → see the full validation report (summary, error table, warning table, committed rows). Errors are exportable as CSV (the rejected rows + an `error_message` column appended) for the operator to fix and resubmit.

- **FR-ING-122** — Real-time updates: the active-batch view subscribes to a Server-Sent Events endpoint (`GET /api/v1/imports/<batchId>/events`) for live row-count updates. SSE is preferred over WebSockets here because the data flow is one-way and short-lived.

### 3.13 Non-functional requirements

- **NFR-ING-001** — Throughput target: ≥10K rows/min for meter reads, ≥1K rows/min for payments (audit-row overhead is higher), on a single worker. Linear scaling with worker count.
- **NFR-ING-002** — Memory ceiling: <500MB per worker process during a 5GB CSV import (FR-ING-010 streaming).
- **NFR-ING-003** — Latency: API endpoint round-trip for a 100-row inline JSON submission ≤2s p99 (synchronous path).
- **NFR-ING-004** — Async batch completion: 100K-row meter-read import completes in ≤15 minutes p99 on standard infrastructure.
- **NFR-ING-005** — RLS continues to apply to all new tables (`import_batch`, `import_batch_report`, `import_batch_row` — see §4.1, `sftp_drop_config`). The import-processor worker runs with `app.current_utility_id` set per tenant per job, never cross-tenant.
- **NFR-ING-006** — SFTP credentials are KMS-encrypted at rest (per FR-ING-040) and decrypted only at connection time in a short-lived in-memory variable. Logs MUST NOT contain credentials. Connection failures log the host + auth method, not the secret.

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `import_batch_row` | Per-row staging area; carries error metadata for invalid rows; used to power the operator drill-down view | 3.1.1, 3.7 |
| `import_batch_report` | One row per completed batch, JSON column for structured report payload, S3 key for the off-Postgres copy | 3.7 |
| `sftp_drop_config` | Per-tenant SFTP configuration with KMS-referenced credentials | 3.4 |

### 4.2 Modified tables

| Table | Change | Reason |
|---|---|---|
| `import_batch` | Add columns: `file_sha256`, `committedCount`, `skippedDuplicateCount`, `updatedCount`, `last_committed_chunk_index`, `external_ref`, `cancel_reason`, `s3_report_key` | Track new pipeline outputs and resume points |
| `import_batch` | Extend `status` enum with `PARSING`, `VALIDATING`, `STAGED`, `COMMITTING`, `PARTIAL` | Lifecycle state machine per FR-ING-112 |
| `import_batch` | Extend `source` enum with `SFTP`, `EXCEL`, `XML` | Channel coverage |
| `tenant_config` | Add `import_max_file_size_mb`, `import_max_rows_per_file`, `import_max_rows_per_day`, `import_max_concurrent_batches` | Per-tenant quotas (FR-ING-110) |

### 4.3 New worker queues

- `sftp-poller` — scheduled queue, ticks every 5 minutes; produces `process-file` jobs.
- `import-processor` — work queue; consumes `process-file` jobs (streaming parse → validate → stage → commit → report → audit).

### 4.4 RLS

All new tables get tenant RLS by `utility_id`. SFTP drop configs in particular MUST never be queryable cross-tenant (private credentials reference). Worker context-switches `app.current_utility_id` per job.

---

## 5. Implementation sequence

### Phase 1 — Pipeline foundation (~3 weeks)

1. **`EntityIngestor` registry interface + meter-read implementation** (~1 week). Defines the contract; first concrete entity is meter reads (because the UI is already half-built and waiting for backend).
2. **Pipeline core: parse → validate → stage → commit → report** (~1 week). Streaming-first via `csv-parse`. Single-channel test path (UI multipart). No audit, no SFTP yet.
3. **`POST /api/v1/imports/meter_read` (UI multipart)** (~3 days). Wires the existing meter-read import UI to the new endpoint. Replaces client-side parsing with server-side dry-run.
4. **Validation report writer** (~3 days). `import_batch_report` table + S3 upload + audit row emission for batch lifecycle (`IMPORT_BATCH_SUBMITTED`, `IMPORT_BATCH_COMPLETE`).

### Phase 2 — API channels (~2 weeks)

5. **API JSON endpoint with idempotency-key support** (~3 days).
6. **API XML endpoint** (~3 days). Adds `fast-xml-parser`. Tests cover meter-read XML format and one custom XML wrapper format.
7. **OpenAPI spec auto-generation per entity** (~2 days). Reuses the per-tenant variant pattern from doc 06.
8. **MV-90 / MV-90A meter-read format** (~2 days). Specialized parser; lives in `EntityIngestor.parseFormats` for meter-read entity.

### Phase 3 — SFTP channel (~3 weeks)

9. **`sftp_drop_config` table + KMS-backed credential storage** (~3 days).
10. **`sftp-poller` worker with host-fingerprint pinning** (~1 week). `ssh2-sftp-client`. Polls, downloads, deduplicates by SHA-256, enqueues.
11. **`import-processor` worker** (~3 days). Consumes `process-file` jobs, runs through the pipeline, archives or quarantines per `onErrorPolicy`.
12. **SFTP tab in operator UI + setup wizard** (~3 days).

### Phase 4 — Reference-data entities (~3 weeks)

13. **Commodity, RateSchedule, Premise, Meter, Customer EntityIngestors** (~1 week). Each ~1 day; the pipeline core does the heavy lifting.
14. **Payment + Adjustment EntityIngestors** (~3 days). Stricter error policy; audit class FINANCIAL; idempotency-key per-row required.
15. **`/imports/<entityType>` UI per entity** (~3 days). Generic UI driven by EntityIngestor metadata.
16. **Custom-fields-on-import-template integration** (~2 days). Pulls enabled custom fields into CSV template generation.

### Phase 5 — Polish (~2 weeks)

17. **Operator UI history/active/templates/quotas tabs** (~1 week).
18. **Async + progress + SSE** (~3 days).
19. **Quota enforcement + 429 responses** (~2 days).

**Total: ~13 weeks** with one engineer; ~8 weeks with two parallel tracks (Phase 2 API + Phase 3 SFTP can overlap once Phase 1 lands).

---

## 6. Out of scope

1. **Real-time streaming ingestion** — we commit batch ingestion (file/array submitted, processed, reported). True streaming (Kafka, Kinesis, persistent gRPC streams) is Phase 5+.
2. **Bidirectional SFTP** — we commit SFTP **inbound** only (we read from the tenant's drop directory). Outbound exports via SFTP (writing reports back to the SFTP server) are out of scope.
3. **Custom transform DSL** — we commit one fixed CSV template per entity (with custom fields). Operators cannot define field-mapping transformations ("their column 'cust_id' maps to our column 'customer_number'"). A column-mapping UI is Phase 5.
4. **OAuth/API-key for SFTP-via-key-server** — credentials are AWS Secrets Manager (or equivalent) only. SSH certificate authorities are Phase 5.
5. **Real-time API for non-batch ingestion** — the existing per-row REST endpoints (e.g., `POST /api/v1/meter-reads`) remain as-is for real-time API consumers. This doc covers **batch** workflows.
6. **Redshift/data-warehouse direct loads** — bulk replication into a data warehouse is out of scope for ingestion. (Reverse direction — exporting *out* of the system to a warehouse — is Phase 5.)
7. **Image/PDF data extraction** — the pipeline does NOT OCR scanned forms or PDFs. Inputs must already be structured (CSV, Excel, JSON, XML).
8. **Compression-at-rest** — the staging area is plain Postgres rows; a 1M-row stage adds DB load but is acceptable per the FR-ING-010 streaming design. Compression-aware staging (e.g., gzip-compressed JSONB) is Phase 5 if volume warrants.
9. **EDI X12 / IDoc / industry-standard formats beyond MV-90** — supported on request, not committed in this RFP.
10. **PGP-encrypted SFTP files** — SaaSLogic-side decryption of PGP-encrypted SFTP drops is Phase 5. Tenants needing encryption-at-transit-and-rest combine our standard SFTP with their KMS at the storage layer.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| 5GB+ CSV uploads exhaust memory | High | Streaming-first design (NFR-ING-002 ceiling 500MB); integration tests with synthetic 10M-row files; per-tenant `import_max_file_size_mb` quota |
| SFTP credentials leak via logs / errors | High | KMS-only storage; logs scrub by allow-list (host, port, username only); credentials decrypted to short-lived in-memory variable; security review of every log statement in poller code |
| Concurrent SFTP polls fight over the same file | Medium | File-lock pattern: poller renames file to `<name>.processing.<workerId>` before fetching; only the worker that successfully renamed proceeds. Alternative file is left for next poll |
| Tenant SFTP server uses self-signed key, fingerprint changes | Medium | Mismatched fingerprint → quarantine + alert + disable config (FR-ING-041). Operator must explicitly re-enable after re-capturing the fingerprint. Never auto-trust |
| XML format variance across vendor implementations breaks parser | Medium | XML schema per entity is documented in the OpenAPI spec; vendors validate before submission. fast-xml-parser configured leniently for whitespace/case. New formats added per request |
| Validation report S3 cost grows unbounded | Low | Lifecycle to Glacier IR after 1 year, Deep Archive after 2 years (per doc 08); operational reports purged at 2-year retention class boundary; financial-import reports retained 7 years per FINANCIAL class |
| Idempotency-key collisions across tenants | Low (impossible) | Idempotency keys are tenant-scoped (`(utilityId, idempotencyKey)` unique constraint); collision across tenants is structurally prevented |
| Mid-batch operator cancellation produces inconsistent commits | Medium | Cancellation only allowed before `COMMITTING` (FR-ING-113); once committing starts, the chunk-resumable design means cancellation would only stop future chunks — and the report would clearly say "cancelled at chunk N of M with N committed" |
| Rate-schedule import partially commits and corrupts pricing | High | `RateSchedule` defaults to `reject_batch` policy (FR-ING-061); any error aborts everything; no partial commit possible. Plus rate schedules are versioned (per [docs/specs/07-rate-management.md](../specs/07-rate-management.md)), so even a bad commit can be rolled back by deactivating the version |
| Per-row audit rows blow up audit_log size | Medium | Skipped-duplicate rows do NOT emit audit (just counted in summary). Insert and update emit one row each, consistent with non-import writes. Audit retention via doc 08 tiers technical audits to 1 year. Volume modeling: 100K-row daily AMI import × 365 days × 5-tenant pilot = 180M audit rows/year — well within Postgres + partitioning capacity per doc 08 §3.3.1 |
| File arrives during commit; same file resubmitted via API; both run | Low | File-level idempotency (FR-ING-100 layer 1) catches via SHA-256 even across channels — both submissions point at the same `import_batch_id` |
| Per-tenant `import_max_concurrent_batches` quota too tight, blocks SFTP automation | Medium | Default 5 concurrent — fits typical workload (1 per AMI vendor, 1 per daily payment file, 1 per monthly customer migration, plus headroom). Operators see current concurrency in the Quotas tab; adjustable per tenant |
| Manual operator override (FR-ING-082) becomes routine, defeats validation | Medium | Override emits `AUDIT_SECURITY` rows; quarterly compliance dashboard surfaces override rate per tenant; tenant admins see "% of imports with override" trend; if it climbs over X%, support engages |

---

## 8. Acceptance criteria (consolidated)

### Pipeline core
- [ ] An `EntityIngestor` registry exists with implementations for: MeterRead, Payment, Adjustment, Commodity, RateSchedule, Premise, Meter, Customer.
- [ ] All channels (UI, API JSON, API XML, SFTP) flow through `ingestion.processBatch()`.
- [ ] A 5GB CSV imports without exceeding 500MB worker memory.
- [ ] Per-row error collection: a 1000-row file with 10 errors commits 990 rows and reports 10 errors with row numbers, codes, and actionable messages.

### UI channel
- [ ] `/imports/meter_read` page (and 7 others) exists with template download, drag-and-drop, preview, commit.
- [ ] Excel files import correctly; multi-sheet picker appears when needed.
- [ ] CSV templates include enabled custom-field columns.

### API channel
- [ ] `POST /api/v1/imports/<entityType>` accepts CSV, Excel, JSON, XML for every entity that supports them.
- [ ] Idempotency-Key header returns the original batch within 24h.
- [ ] Submissions >10MB return `202 Accepted` with batch-id + status link.
- [ ] OpenAPI spec includes import endpoints with per-tenant variant including custom fields.

### SFTP channel
- [ ] `sftp_drop_config` table holds per-tenant configs with KMS-referenced credentials only.
- [ ] `sftp-poller` ticks every 5 minutes; respects per-config `pollIntervalMinutes`.
- [ ] Host fingerprint pinning blocks unknown-host connections; setup wizard guides fingerprint capture.
- [ ] File-level SHA-256 deduplication: same file fetched twice processes once.
- [ ] Files moving from `pollPath` to `archivePath` (success) or `quarantinePath` (failure); operators see history in the SFTP tab.

### Validation report
- [ ] Every batch produces a structured report stored in `import_batch_report` + S3.
- [ ] `GET /api/v1/imports/<batchId>` returns batch metadata; `/report` returns the full structured payload.
- [ ] Reports retained per `OPERATIONAL_LOG` retention class (2 years) for non-financial imports; FINANCIAL class (7 years) for payment/adjustment imports per doc 08.

### Audit
- [ ] Every import lifecycle event (submission, completion, failure, cancellation) emits an audit row.
- [ ] Per-row commit emits one audit row of the row's natural class with `metadata: { importBatchId }`.
- [ ] Operator overrides emit `AUDIT_SECURITY` rows; SOC dashboard tracks override rate.

### Reference data
- [ ] Commodities, rate schedules, premises, meters, customers can each be imported via UI/API.
- [ ] Reference-data imports default to upsert; operational-data imports default to insert-only.
- [ ] Custom fields on each entity appear in the import template.

### Idempotency
- [ ] File-level: same SHA-256 from SFTP returns the original batch.
- [ ] Submission-level: same Idempotency-Key from API within 24h returns the original batch.
- [ ] Row-level: re-importing identical rows skips them and increments `skippedDuplicateCount`.

### Quotas
- [ ] Per-tenant `import_max_*` quotas enforced; `429` returned when exceeded with `Retry-After`.

### Async
- [ ] >10MB or >10K-row submissions process async; UI polls and renders progress.
- [ ] Worker crash mid-commit resumes from `last_committed_chunk_index` on restart.

### Cancellation
- [ ] In-flight batches in `STAGED` or earlier can be cancelled; `COMMITTING` cannot.

---

## 9. References

- **Internal**:
  - [07-data-validation.md](./07-data-validation.md) — Tier 1-4 validation framework, entity-rules registry, actionable error messages (FR-VAL-040). This doc reuses the framework for all per-row validation.
  - [04-attachments.md](./04-attachments.md) — multipart upload primitives (reused for file reception, not for data ingest); does not overlap with this doc's commitments.
  - [06-custom-fields.md](./06-custom-fields.md) §4.4 (CSV import/export of custom fields) — the same column-template extension applies to import paths.
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — retention classes for `ImportBatch`, `ImportBatchReport`, S3 lifecycle for stored reports.
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — audit-row emission, event class enum, append-only enforcement.
  - `packages/shared/prisma/schema.prisma:1031-1049` — existing `ImportBatch` table (extended by this doc, not replaced).
  - `packages/web/app/meter-reads/import/page.tsx` — existing UI (replaced by `/imports/<entityType>`).
  - `packages/api/src/services/meter-read.service.ts` — current per-row validation code (refactored into the meter-read `EntityIngestor`).
  - `packages/api/src/lib/audit-wrap.ts` — audit emission helper (reused; not rewritten).

- **External**:
  - RFC 4180 — CSV format conventions (UTF-8, CRLF, quoted-string handling).
  - MV-90 / MV-90A — utility meter-data exchange format (specialized format for the meter-read entity).
  - SSH protocol RFC 4251 + SFTP draft — base for `ssh2-sftp-client` integration.
  - AWS Secrets Manager — credential storage for SFTP `*SecretRef` columns.

---

**End of doc 09.**
