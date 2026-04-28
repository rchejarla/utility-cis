# Import Infrastructure — Slice 1 Plan (Foundation + meter-reads migration)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Build the cross-cutting bulk-import framework defined in spec 22 and migrate the existing meter-read import to use it. After this slice, every entity that wants bulk import writes one ~150-line handler file instead of building everything from scratch. Sync-only — async + worker + cancel/retry/notifications are Slice 2.

**Spec:** [`docs/specs/22-import-infrastructure.md`](../../specs/22-import-infrastructure.md). Read **§Domain model**, **§Upload & parsing**, **§API surface**, **§Handler contract** before starting.

**Slice 1 scope:**
- Schema migration (ImportBatch extensions, ImportRow, InAppNotification).
- Server-side parsing via `papaparse` (shared between client and server).
- Kind registry + meter-read handler.
- Generic `/api/v1/imports` routes (POST multipart, GET list/detail/rows/errors).
- `<ImportWizard kind="..." />` React component (upload → mapping → preview → commit, all sync).
- `/imports` list + `/imports/:id` detail pages.
- Original uploaded files persisted via existing `Attachment` table.
- Refactor `/meter-reads/import` to mount the new wizard; delete the old endpoint.
- Integration tests rewritten through the generic path; new framework-level tests.

**Slice 1 deferred to Slice 2:** BullMQ worker, async/sync threshold, status polling, cancel, retry, in-app + email notifications, zombie-batch sweep. The `cancel_requested` column and `processing_started_at`/`last_progress_at` columns ship in Slice 1 (they're cheap), but no code reads them yet.

**Tech additions:** `papaparse` npm package (added to `packages/shared`).

---

## File Structure

### Created

| Path | Responsibility |
|---|---|
| `packages/shared/src/parsing/csv.ts` | Tiny wrapper around `papaparse` exposing `parseCsvText(text) → { headers, rows }`. Same module loaded both client and server. |
| `packages/shared/src/imports/types.ts` | `CanonicalFieldDef`, `ImportKindHandler`, `HandlerContext`, `ImportRowResult` types. Pure types — no runtime. |
| `packages/shared/prisma/migrations/<TS>_import_infrastructure/migration.sql` | Hand-written: ImportBatch column adds + status-enum widen + drop-errors-col + import_row table + in_app_notification table + enums + backfill entity_kind. |
| `packages/api/src/imports/registry.ts` | `registerImportKind(handler)`, `getKindHandler(kind)`, `listKinds()`. Module-load registration. |
| `packages/api/src/imports/handlers/index.ts` | Registers each handler. Imported once at API boot from `app.ts`. |
| `packages/api/src/imports/handlers/meter-read.ts` | The first kind handler. Owns canonicalFields, templateRows, parseRow, processRow (encapsulating the existing meter-read import logic). |
| `packages/api/src/services/imports.service.ts` | `createImport(utilityId, actor, fileBytes, fileName, kind, source, mapping)`, `listImports`, `getImport`, `getImportRows`, `getErrorSummary`, `errorsAsCsv`. All sync; async dispatch is Slice 2. |
| `packages/api/src/routes/imports.ts` | All generic routes per spec §API surface. Wired from `app.ts`. |
| `packages/api/src/__tests__/integration/imports.integration.test.ts` | Framework-level tests: dispatch by kind, mapping validation, error reporting, attachment link, list/detail. |
| `packages/web/components/imports/import-wizard.tsx` | `<ImportWizard kind={...} />`. Stages: upload → mapping → preview → commit. Local papaparse for preview; multipart POST on commit. Re-uses ConfirmDialog where appropriate. |
| `packages/web/app/imports/page.tsx` | Cross-kind history list. |
| `packages/web/app/imports/[id]/page.tsx` | Detail: status, counts, error summary, rows table, errors table, "Download original file" link. |

### Modified

| Path | Change |
|---|---|
| `packages/shared/package.json` | Add `papaparse` (^5.x) and `@types/papaparse` (devDep). |
| `packages/shared/prisma/schema.prisma` | Reflect the migration: ImportBatch new columns, ImportRow + InAppNotification models + enums. |
| `packages/api/src/app.ts` | Register `importsRoutes`, import `imports/handlers/index.ts` to trigger handler registration at boot. |
| `packages/api/src/routes/meter-reads.ts` | **Delete** the `/api/v1/meter-reads/import` route handler and the `/template.csv` route handler. |
| `packages/api/src/services/meter-read.service.ts` | **Delete** the `importMeterReads` function and `mapBatchSourceToReadSource` helper. The processing logic moves into the meter-read handler (with adjustments for per-row dispatch). |
| `packages/shared/src/validators/meter-read.ts` | **Delete** `importMeterReadsSchema` (the new framework owns payload validation). Update barrel exports. |
| `packages/web/app/meter-reads/import/page.tsx` | Replace existing wizard logic with a thin shell: `<ImportWizard kind="meter_read" />`. |
| `packages/api/src/__tests__/integration/meter-read-import.integration.test.ts` | **Rewrite** to drive the generic POST `/api/v1/imports` route with `kind=meter_read` (multipart). Test parity preserved or improved. |

### Deleted

- `POST /api/v1/meter-reads/import` (route + handler)
- `GET /api/v1/meter-reads/import/template.csv` (route)
- `importMeterReads()` (service function)
- `importMeterReadsSchema` (validator)

---

## Task 1 — `papaparse` + shared CSV wrapper

**Goal:** One CSV parser usable from both browser and Node, so the wizard's preview matches the server's actual processing exactly.

**Files:**
- Modify: `packages/shared/package.json`
- Create: `packages/shared/src/parsing/csv.ts`
- Modify: `packages/shared/src/index.ts` (export the wrapper)

**Steps:**
- [ ] Add `papaparse: ^5.4.1` to `packages/shared/package.json` dependencies; `@types/papaparse: ^5.x` to devDependencies. `pnpm install`.
- [ ] Create `parsing/csv.ts` with `parseCsvText(text: string): { headers: string[]; rows: Record<string, string>[] }`. Use `Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() })`. Wrap result.
- [ ] Export from `src/index.ts`.

**Verification:**
- [ ] `pnpm --filter @utility-cis/shared exec tsc --noEmit` clean.
- [ ] Quick scratch test: parse a sample CSV with embedded quoted commas, get the right headers and rows.

---

## Task 2 — Schema migration

**Goal:** Database supports the framework. ImportBatch becomes entity-kind-aware. ImportRow stores per-row state. InAppNotification ready for Slice 2.

**Files:**
- Create: `packages/shared/prisma/migrations/<TS>_import_infrastructure/migration.sql`
- Modify: `packages/shared/prisma/schema.prisma`

**Steps:**
- [ ] Write the migration:
  ```sql
  -- ImportBatch column adds
  ALTER TABLE import_batch
    ADD COLUMN entity_kind varchar(50) NOT NULL DEFAULT 'meter_read',
    ADD COLUMN processing_started_at timestamptz,
    ADD COLUMN last_progress_at timestamptz,
    ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false,
    ADD COLUMN mapping jsonb,
    DROP COLUMN errors;

  ALTER TABLE import_batch
    ALTER COLUMN entity_kind DROP DEFAULT;

  -- Widen status enum
  ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
  ALTER TYPE "ImportBatchStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

  -- New enums
  CREATE TYPE "ImportRowStatus" AS ENUM ('PENDING', 'IMPORTED', 'ERROR', 'SKIPPED');
  CREATE TYPE "InAppNotificationKind" AS ENUM ('IMPORT_COMPLETE', 'IMPORT_FAILED', 'IMPORT_CANCELLED', 'IMPORT_PARTIAL');
  CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

  -- import_row
  CREATE TABLE import_row (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
    row_index integer NOT NULL,
    raw_data jsonb NOT NULL,
    status "ImportRowStatus" NOT NULL DEFAULT 'PENDING',
    result_entity_id uuid,
    error_code varchar(64),
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
  );
  CREATE INDEX import_row_batch_status_idx ON import_row (import_batch_id, status);
  CREATE INDEX import_row_batch_index_idx ON import_row (import_batch_id, row_index);

  -- in_app_notification
  CREATE TABLE in_app_notification (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    utility_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind "InAppNotificationKind" NOT NULL,
    severity "NotificationSeverity" NOT NULL,
    title varchar(200) NOT NULL,
    body text NOT NULL,
    link varchar(500),
    metadata jsonb,
    is_read boolean NOT NULL DEFAULT false,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX in_app_notification_unread_idx
    ON in_app_notification (utility_id, user_id, is_read, created_at DESC);
  ```
- [ ] Update `schema.prisma`:
  - Add the new columns + status values on `ImportBatch`.
  - Add `ImportRow` model + `ImportRowStatus` enum.
  - Add `InAppNotification` model + `InAppNotificationKind`, `NotificationSeverity` enums.
  - Drop `errors` from `ImportBatch`.
  - Note: don't run `prisma migrate dev` (hash mismatch risk on existing applied migrations); use `prisma migrate deploy`.
- [ ] Apply: `DATABASE_URL=... pnpm --filter @utility-cis/shared exec prisma migrate deploy`.

**Verification:**
- [ ] Migration applies cleanly to dev DB.
- [ ] `psql ... -c "\d+ import_row"` shows the table.
- [ ] `psql ... -c "\d+ import_batch"` shows new columns + missing `errors` column.
- [ ] `psql ... -c "SELECT enum_range(NULL::\"ImportBatchStatus\")"` includes `PARTIAL` and `CANCELLED`.
- [ ] Existing meter-read import_batch rows (if any) have `entity_kind = 'meter_read'`.
- [ ] `pnpm --filter @utility-cis/shared exec tsc --noEmit` clean (Prisma client regenerated).

---

## Task 3 — Handler interface + kind registry

**Goal:** Type-safe interface every kind handler must implement; runtime registry the routes dispatch through.

**Files:**
- Create: `packages/shared/src/imports/types.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/api/src/imports/registry.ts`
- Create: `packages/api/src/imports/handlers/index.ts`

**Steps:**
- [ ] In shared: `CanonicalFieldDef { name, label, required, description?, example? }`. `ImportKindHandlerMeta { kind, label, module, permission, canonicalFields, templateRows }` — the metadata-only piece exposed to the wizard. `HandlerContext { utilityId, actorId, actorName, tx }`. `RowResult = { ok: true; entityId?: string } | { ok: false; code: string; message: string }`.
- [ ] In api: `ImportKindHandler<TRow>` extends `ImportKindHandlerMeta` with `parseRow(raw: Record<string,string>) => TRow | { __error: { code, message } }` and `processRow(ctx: HandlerContext, row: TRow) => Promise<RowResult>`. Stays in `packages/api/src/imports/types.ts` since it imports Prisma tx type.
- [ ] Registry: `registerImportKind(handler)` (throws on duplicate kind), `getKindHandler(kind)` (throws if missing), `listKinds()` returns metadata array.
- [ ] `handlers/index.ts` is the explicit registration list — empty at first, fills as Tasks 4 + future slices add handlers. Imported once at API boot for side effect.

**Verification:**
- [ ] Type-check both packages clean.
- [ ] Unit test for registry: register two handlers, listKinds returns both, getKindHandler dispatches correctly, duplicate kind throws.

---

## Task 4 — meter-read kind handler

**Goal:** First handler implementing the registry interface. Encapsulates the meter-read processing logic in the handler-shaped form.

**Files:**
- Create: `packages/api/src/imports/handlers/meter-read.ts`
- Modify: `packages/api/src/imports/handlers/index.ts` (register it)

**Steps:**
- [ ] Define `MeterReadRow` type (canonical-field-shaped: `{ meterNumber, readDatetime, reading, readType?, readSource? }`).
- [ ] Define `canonicalFields` per spec §Mapping with aliases for auto-detect.
- [ ] Define `templateRows` (2 example rows for the template.csv download).
- [ ] `parseRow(raw)`: validate required fields populated, parse reading as number, normalize datetime to ISO. Return `{ __error }` on validation failure with code `INVALID_DATE` / `INVALID_READING` / `MISSING_FIELD`.
- [ ] `processRow(ctx, row)`: lookup meter by `meterNumber` within the tenant (cache the resolution map across rows in the same batch via context — Task 5 wires this), bail with `METER_NOT_FOUND` / `METER_REMOVED` if applicable, resolve serviceAgreementId, computeConsumption, insert MeterRead, write audit row, return `{ ok: true, entityId: meterRead.id }`. All inside the `ctx.tx` transaction passed by the framework.
- [ ] Reuse helpers from existing meter-read.service.ts (resolveServiceAgreementId, computeConsumption) — keep them in the service file as exported helpers; the handler imports them.
- [ ] Map batch source → read source (existing `mapBatchSourceToReadSource` lives in the handler now).

**Verification:**
- [ ] Unit tests for `parseRow` (happy + each error case).
- [ ] Unit tests for `processRow` with mocked Prisma covering: meter not found, meter removed, no SA at date, happy path.
- [ ] Type-check api clean.

---

## Task 5 — Generic import service (sync)

**Goal:** The engine. Takes a multipart upload, parses, dispatches row-by-row to the registered handler, persists results, returns a summary.

**Files:**
- Create: `packages/api/src/services/imports.service.ts`

**Steps:**
- [ ] `createImport({ utilityId, actor, fileBytes, fileName, kind, source, mapping })`:
  1. Validate the kind is registered.
  2. Validate mapping covers all `required: true` canonical fields (return 400 if not).
  3. Save the file via existing `attachment.service.ts` helpers — `entityType: "ImportBatch"`, `entityId: <new uuid (we'll use this on the batch row)>`. Capture the attachment id.
  4. Parse the file using `parseCsvText` from shared. Apply mapping to produce `Record<string, string>` rows keyed by canonical field. (Server parser is the source of truth.)
  5. Hard-cap row count at 10000 in this slice (will become the async threshold in Slice 2).
  6. Create `ImportBatch` row in `PROCESSING` status (sync) with utility, kind, source, fileName, mapping, recordCount = parsed.length, createdBy = actor.id.
  7. Bulk-insert `import_row` rows in `PENDING` status (`prisma.importRow.createMany`) with rowIndex 1..N and `rawData` set to the mapped row.
  8. Dispatch sequentially:
     ```
     for each importRow in PENDING order:
       run prisma.$transaction(async (tx) => {
         const result = await handler.processRow({ utilityId, actorId, actorName, tx }, parsedRow)
         tx.importRow.update({...status, errorCode, errorMessage, resultEntityId, processedAt: now})
       })
       update batch counts (importedCount/errorCount) periodically
     ```
  9. After all rows processed, finalise batch status: COMPLETE if errorCount=0, PARTIAL if 0<imported<recordCount, FAILED if imported=0, set completedAt.
  10. Emit one `import_batch.created` audit row at the start and one `import_batch.completed`/`failed`/`partial` at the end.
- [ ] `listImports(utilityId, query)`: paginated, filterable by kind/status/source/createdBy/dateRange. Mirrors paginatedTenantList.
- [ ] `getImport(utilityId, id)`: returns batch + attachment id (so the UI can build the download link).
- [ ] `getImportRows(utilityId, batchId, query)`: paginated rows, filterable by status.
- [ ] `getErrorSummary(utilityId, batchId)`: SQL aggregation `SELECT error_code, COUNT(*) FROM import_row WHERE batch_id = ? AND status = 'ERROR' GROUP BY error_code`.
- [ ] `errorsAsCsv(utilityId, batchId)`: stream-friendly generator that yields the CSV rows for download.

**Verification:**
- [ ] Type-check clean.
- [ ] Unit tests with mocked prisma covering: kind not registered (400), mapping incomplete (400), file too large (400), happy path counts, mixed success/error → status PARTIAL, all-fail → FAILED.

---

## Task 6 — Generic `/api/v1/imports` routes

**Goal:** Wire the service to HTTP. Handle multipart upload, kind dispatch, permission checks per kind.

**Files:**
- Create: `packages/api/src/routes/imports.ts`
- Modify: `packages/api/src/app.ts`

**Steps:**
- [ ] Multipart `POST /api/v1/imports`:
  - Read multipart fields: `file` (binary), `kind`, `source`, `fileName?`, `mapping` (JSON-encoded).
  - Permission: resolve handler's `module` + `permission` from registry; manually check via `getUserRole` (the per-route static config doesn't work for dynamic permission). Return 403 with kind-specific error if permission missing.
  - Pass to `createImport`. Return result (the summary object: batchId, status, counts, errors[]).
- [ ] `GET /api/v1/imports`: `imports.VIEW`. Calls `listImports`.
- [ ] `GET /api/v1/imports/:id`: `imports.VIEW` + dispatch to kind's VIEW. Calls `getImport`.
- [ ] `GET /api/v1/imports/:id/rows`: same permissions. Paginated.
- [ ] `GET /api/v1/imports/:id/error-summary`: same permissions.
- [ ] `GET /api/v1/imports/:id/errors.csv`: same permissions. Sets headers + streams CSV.
- [ ] `GET /api/v1/imports/kinds`: `imports.VIEW`. Returns `listKinds()`.
- [ ] `GET /api/v1/imports/kinds/:kind/fields`: `imports.VIEW`. Returns canonicalFields.
- [ ] `GET /api/v1/imports/kinds/:kind/template.csv`: `skipAuth`. Generates CSV from `canonicalFields` (header row) + `templateRows` (sample rows).
- [ ] Register the route module in `app.ts`. Also add `import "./imports/handlers/index.js"` to trigger handler registration at boot.
- [ ] Add `imports` module to the tenant module config so it's enabled by default for the dev tenant.

**Verification:**
- [ ] Type-check clean.
- [ ] Manual: curl multipart upload of a small CSV → returns the summary.
- [ ] Curl `GET /imports/kinds` → returns `[{ kind: "meter_read", ...}]`.
- [ ] Curl `GET /imports/kinds/meter_read/template.csv` → returns CSV with header row + 2 sample rows.

---

## Task 7 — Delete old meter-reads import code

**Goal:** Remove the now-redundant code paths. Single source of truth for meter-read imports is the new framework.

**Files:**
- Modify: `packages/api/src/routes/meter-reads.ts` (remove 2 routes)
- Modify: `packages/api/src/services/meter-read.service.ts` (remove `importMeterReads`, keep helpers if the handler imports them)
- Modify: `packages/shared/src/validators/meter-read.ts` (remove `importMeterReadsSchema`)
- Modify: `packages/shared/src/index.ts` (drop barrel exports for removed types)

**Steps:**
- [ ] Delete `POST /api/v1/meter-reads/import` and `GET .../template.csv` route handlers.
- [ ] Delete `importMeterReads` and `mapBatchSourceToReadSource` from `meter-read.service.ts`. Keep `resolveServiceAgreementId` and `computeConsumption` exported (the handler in Task 4 imports them).
- [ ] Delete `importMeterReadsSchema` and the `ImportMeterReadsInput` type. Update barrel exports.
- [ ] Run all package type-checks.

**Verification:**
- [ ] `pnpm exec tsc --noEmit` clean across api, shared, web.
- [ ] `curl POST /api/v1/meter-reads/import` returns 404 (route is gone).

---

## Task 8 — `<ImportWizard>` React component

**Goal:** Generic wizard the entity-specific pages mount. Stages: upload → mapping → preview → commit.

**Files:**
- Create: `packages/web/components/imports/import-wizard.tsx`
- Create: `packages/web/components/imports/import-wizard.module.css` (or inline styles — match existing import page)

**Steps:**
- [ ] Component contract: `<ImportWizard kind="meter_read" />`. On mount, fetch `/api/v1/imports/kinds/:kind/fields` to populate canonicalFields.
- [ ] **Upload stage**: drag-drop or browse file; on file selected, locally `parseCsvText(text)` (using shared wrapper) → `{ headers, rows }`. Source dropdown.
- [ ] **Mapping stage**: render one row per source header; dropdown of canonical fields (+ "Ignore"). Auto-detect on entry: try localStorage first (key: `import-mapping:<kind>:<sha1(headers)>`), fall back to alias matching against canonicalFields' aliases. Validate required fields covered before allowing Continue. Persist back to localStorage on Continue.
- [ ] **Preview stage**: show first 10 mapped rows + valid/error counts (validation re-uses the same canonical-aware checks as parseRow). Back / Commit buttons.
- [ ] **Commit stage**: build `FormData` with `file`, `kind`, `source`, `fileName`, `mapping`. Multipart POST to `/api/v1/imports`. Render the response: counts, error summary, link to `/imports/<batchId>` for full detail.
- [ ] Loading + error UI for each stage.

**Verification:**
- [ ] Type-check web clean.
- [ ] Manual: drop a CSV in the wizard, see headers, confirm mapping, commit, see result.

---

## Task 9 — Refactor `/meter-reads/import` page

**Goal:** Existing page becomes a thin wrapper around the wizard.

**Files:**
- Modify: `packages/web/app/meter-reads/import/page.tsx`

**Steps:**
- [ ] First: discard the in-flight uncommitted parser refactor on this file (`git restore packages/web/app/meter-reads/import/page.tsx`).
- [ ] Replace contents with a ~20-line shell:
  ```tsx
  "use client";
  import { ImportWizard } from "@/components/imports/import-wizard";
  import { usePermission } from "@/lib/use-permission";
  import { AccessDenied } from "@/components/ui/access-denied";

  export default function MeterReadImportPage() {
    const { canCreate } = usePermission("meter_reads");
    if (!canCreate) return <AccessDenied />;
    return <ImportWizard kind="meter_read" />;
  }
  ```
- [ ] Remove the page-level `parseCsv` / `parseJson` / wizard state — all of it.

**Verification:**
- [ ] Page renders correctly at `/meter-reads/import` with the new wizard.
- [ ] Permission check still works.

---

## Task 10 — `/imports` list + detail pages

**Goal:** Cross-kind import history visible to operators.

**Files:**
- Create: `packages/web/app/imports/page.tsx` (list)
- Create: `packages/web/app/imports/[id]/page.tsx` (detail)

**Steps:**
- [ ] List page: paginated table with columns Started / Kind / Source / File / Status / Imported / Errors / Actor. Filter pills for kind + status + date range. Click row → detail.
- [ ] Detail page header: status badge, kind label, source, file name, who/when, total/imported/error counts. **"Download original file"** link → uses the attachment id from the response to call `/api/v1/attachments/:id/download`.
- [ ] Detail tabs:
  - Summary: error-code aggregate (chart or list), mapping used, audit-style summary.
  - Rows: paginated table of all `import_row` rows. Filter by status.
  - Errors: only ERROR rows. Filter by errorCode pill. "Download CSV" button.
- [ ] Add link to `/imports` in the admin sidebar.

**Verification:**
- [ ] Both pages render with sample data.
- [ ] Type-check web clean.

---

## Task 11 — Integration tests

**Goal:** Test parity with what the old meter-read tests covered, plus new framework-level tests.

**Files:**
- Modify (rewrite): `packages/api/src/__tests__/integration/meter-read-import.integration.test.ts`
- Create: `packages/api/src/__tests__/integration/imports.integration.test.ts`

**Steps:**
- [ ] **meter-read-import.integration.test.ts**: rewrite tests to drive `POST /api/v1/imports` with `kind=meter_read` multipart upload (use `form-data` package or Fastify's inject with `payload` as Buffer). Cover the same scenarios: clean batch, chronological priorReading invariant, partial success, REMOVED meter rejection, all-fail → FAILED batch, source mapping.
- [ ] **imports.integration.test.ts** (new): kind-not-registered → 400; mapping missing required field → 400; multipart with no file → 400; correct file → ImportBatch + import_row rows + Attachment all created; getImport returns the right shape; getErrorSummary aggregates correctly; errors.csv downloads; list endpoint paginates and filters.
- [ ] All run under the existing testcontainers config; reuse `_effective-dating-fixtures.ts` for the tenant + meter setup.

**Verification:**
- [ ] `pnpm exec vitest --config vitest.integration.config.ts run src/__tests__/integration/meter-read-import.integration.test.ts src/__tests__/integration/imports.integration.test.ts` — all pass.
- [ ] Total integration count grows by 5+; total unit count unchanged or higher.

---

## Notes for the executing agent

1. **No backwards compat is required.** Slice 1 is allowed to break the old meter-reads import URLs; the spec calls this out explicitly. Don't add shims for them.

2. **Don't build the worker, don't build cancel/retry, don't emit notifications.** Slice 1 is sync-only. The schema columns for those (`cancel_requested`, `processing_started_at`, `last_progress_at`) are added in Task 2 but no code reads them yet.

3. **Permission model**: `imports` is a new tenant module. Add it to the seeded module list. The kind handler's permission (e.g. `meter_reads.CREATE`) is checked **dynamically inside the route handler**, not via the static `route.config.module/permission` mechanism, because the kind isn't known until the request body is parsed.

4. **Multipart** — the API already has `@fastify/multipart` registered (used by the attachments routes). Reuse it. File-size cap: 50MB.

5. **Audit emission**: each row's `processRow` emits its own audit row (the existing audit-wrap pattern). The framework also emits one `import_batch.created` row at start and one terminal `import_batch.<status>` row at end.

6. **Keep meter-read processing logic intact**. Task 4 is a refactor of *where* the logic lives, not *what* it does. The chronological-ordering invariant for `computeConsumption` still applies — sort rows by (meterId, readDatetime asc) before dispatch.

7. **Skill: superpowers:test-driven-development applies.** Write tests as you go, not all at the end.

8. The in-flight uncommitted changes in `packages/web/app/meter-reads/import/page.tsx` are **discarded** at the start of Task 9. Don't try to fold them in.
