# 04 — Attachments

**RFP commitment owner:** SaaSLogic Utilities (`packages/api` + `packages/web`)
**Status:** Drafted — partial implementation. The basic upload / list / download / delete plumbing exists for five entity types and seven MIME-type families. The RFP commits two additional entity types, three additional capabilities (audit trail, multi-field search, optional DMS integration), and broader file-type coverage that aren't built today.
**Effort estimate:** L (~3-4 weeks engineering, plus dependent work on the Adjustment domain that isn't in this doc).

---

## 1. RFP commitment (verbatim)

> Every major business entity — customer, account, premise, meter, service agreement, service request, adjustment — supports an Attachments tab where users with appropriate permissions can upload, view, download, and delete files (PDF, image formats, Office formats, plain text, CSV). Each attachment carries metadata (uploader, timestamp, size, type, optional description) and a complete audit trail.

> Attachments are searchable by filename, description, uploader, date range, and the parent entity to which they are attached. Full-text search across PDF and Office document content is on the product roadmap; today, attachment-content search is available through integration with the City's existing document-management system if that capability is required at go-live.

The commitment breaks into five distinct capability areas:

1. **Entity coverage** — seven entity types (claim adds ServiceRequest + Adjustment to current five).
2. **CRUD with permissions** — upload, view, download, delete; permission-gated.
3. **File-type coverage** — PDF, images, Office formats, plain text, CSV.
4. **Metadata + audit trail** — uploader, timestamp, size, type, description, plus full audit history.
5. **Search** — filename, description, uploader, date range, parent entity.
6. **Content search** — explicit roadmap item for native FTS; conditional commitment for DMS integration if required at go-live.

---

## 2. Current state — what exists today

### 2.1 Prisma model

`packages/shared/prisma/schema.prisma:668-684`:

```prisma
model Attachment {
  id          String   @id @default(uuid()) @db.Uuid
  utilityId   String   @map("utility_id") @db.Uuid
  entityType  String   @map("entity_type") @db.VarChar(100)
  entityId    String   @map("entity_id") @db.Uuid
  fileName    String   @map("file_name") @db.VarChar(500)
  fileType    String   @map("file_type") @db.VarChar(100)  // MIME type
  fileSize    Int      @map("file_size")
  storagePath String   @map("storage_path") @db.VarChar(1000)
  uploadedBy  String   @map("uploaded_by") @db.Uuid
  description String?  @db.VarChar(500)
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, entityType, entityId])
  @@index([utilityId, uploadedBy])
}
```

### 2.2 API surface

`packages/api/src/routes/attachments.ts`:

| Method | Route | Permission | Returns |
|---|---|---|---|
| GET | `/api/v1/attachments?entityType=&entityId=` | `attachments:VIEW` | List of attachments for the parent entity |
| POST | `/api/v1/attachments` (multipart) | `attachments:CREATE` | Created attachment row |
| GET | `/api/v1/attachments/:id/download` | `attachments:VIEW` | File bytes with Content-Disposition |
| DELETE | `/api/v1/attachments/:id` | `attachments:DELETE` | 204 |

### 2.3 Supported entity types

Single source of truth in `packages/shared/src/modules/constants.ts:13-21`:

```ts
export const ATTACHMENT_ENTITY_TYPES = [
  "Customer",
  "Account",
  "Premise",
  "Meter",
  "ServiceAgreement",
  "RateSchedule",
  "BillingCycle",
] as const;
```

Five of the seven are RFP-committed entities. **Two RFP-committed types missing**: `ServiceRequest`, `Adjustment`. Two unmentioned-by-RFP types (`RateSchedule`, `BillingCycle`) are already supported — keep them.

### 2.4 Supported MIME types

`packages/api/src/services/attachment.service.ts`:

```
application/pdf
image/png
image/jpeg
image/gif
image/webp
text/plain
text/csv
application/vnd.ms-excel                 (XLS)
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet  (XLSX)
application/msword                       (DOC)
application/vnd.openxmlformats-officedocument.wordprocessingml.document  (DOCX)
```

**Missing for "Office formats" credibility**: PowerPoint (`application/vnd.ms-powerpoint` PPT, `application/vnd.openxmlformats-officedocument.presentationml.presentation` PPTX), legacy Excel binary 2007+ (`application/vnd.ms-excel.sheet.binary.macroEnabled.12` XLSB if used), OpenDocument formats (ODT, ODS) — optional but City may use them.

### 2.5 Storage backend

Local filesystem at `../../uploads/` relative to API process working directory. Path-traversal protection in `safeResolveStoragePath`. **This will not work in a multi-instance deployment** — each API replica has its own local FS, and uploads to one node aren't visible to the others. Acceptable for the current single-instance dev/staging; a hard requirement-blocker for any production multi-replica deploy.

### 2.6 Web UI

`packages/web/components/ui/attachments-tab.tsx` is consumed by:

- `app/customers/[id]/page.tsx`
- `app/accounts/[id]/page.tsx`
- `app/premises/[id]/page.tsx`
- `app/meters/[id]/page.tsx`
- `app/service-agreements/[id]/page.tsx`

**Missing tab usage**: `service-requests/[id]/page.tsx` (entity exists, attachments column reserved as `Json @default("[]")` — separate stub mechanism, NOT wired to the Attachment table), `adjustments/[id]/page.tsx` (page doesn't exist; Adjustment domain not built).

### 2.7 Audit trail

`grep "auditCreate\|auditUpdate" packages/api/src/services/attachment.service.ts` returns **zero matches.** Uploads and deletes are silent. The `audit_log` table sees no rows from this domain.

This is the most significant gap relative to the RFP claim: the proposal commits "a complete audit trail" — we have none.

### 2.8 Search

The `GET /api/v1/attachments` endpoint requires both `entityType` AND `entityId`. Cannot query "all attachments by uploader X" or "all attachments matching filename pattern *.pdf" or "attachments uploaded in the last 30 days." No global search route.

### 2.9 File size limit

10MB hard cap per upload. Multipart-body limit matches in `app.ts`. RFP doesn't specify a limit, but City users uploading scanned engineering drawings or signed contracts may need higher.

### 2.10 Other gaps relative to industry baseline

- **No SHA-256 hash on file content** — no integrity verification, no duplicate detection.
- **No virus / malware scan on upload** — not promised by the RFP, but most government procurement requires it.
- **No encryption at rest** — files sit on disk in cleartext.
- **No soft-delete** — DELETE is hard. The audit trail (once we add it) won't have access to the deleted file content for forensic review.
- **No download audit** — even adding upload/delete audit doesn't capture WHO downloaded WHICH file. For sensitive documents (signed contracts, ID copies), download access tracking is often a compliance requirement.
- **No DMS integration adapter** — the conditional RFP commitment ("integration with the City's existing document-management system if that capability is required at go-live") has no architectural anchor.

---

## 3. Gap matrix

| RFP capability | Current state | Gap |
|---|---|---|
| Customer attachments | ✓ Full | None |
| Account attachments | ✓ Full | None |
| Premise attachments | ✓ Full | None |
| Meter attachments | ✓ Full | None |
| Service Agreement attachments | ✓ Full | None |
| **Service Request attachments** | ✗ Missing — `service_request.attachments` is a Json stub, not wired to `attachment` table | Add `ServiceRequest` to `ATTACHMENT_ENTITY_TYPES`; mount `<AttachmentsTab>` on the SR detail page; migrate any existing JSON-column data |
| **Adjustment attachments** | ✗ Adjustment domain doesn't exist (Module 10 not built) | Out of this doc — pre-condition is the Adjustment entity itself; the attachment surface is trivially added once the entity ships |
| Upload | ✓ POST /api/v1/attachments | None |
| View / download | ✓ GET /api/v1/attachments/:id/download | None |
| Delete | ✓ DELETE /api/v1/attachments/:id | Convert to soft-delete (FR-ATT-031) so audit trail can reference the deleted artifact |
| Permissions | ✓ Module-based RBAC (VIEW/CREATE/DELETE) | Add a separate `DOWNLOAD` audit event (not a separate permission — VIEW already gates download) |
| PDF support | ✓ application/pdf | None |
| Image support | ✓ PNG/JPEG/GIF/WebP | Optional: HEIC (iOS default photo format), TIFF for scanned docs |
| Office formats | ✓ DOC/DOCX/XLS/XLSX | **Missing PPT/PPTX**; consider OpenDocument (ODT/ODS) |
| Plain text + CSV | ✓ text/plain + text/csv | None |
| Uploader metadata | ✓ uploadedBy column | None |
| Timestamp metadata | ✓ createdAt | None |
| Size metadata | ✓ fileSize | None |
| Type metadata | ✓ fileType | None |
| Description metadata | ✓ description column (optional, ≤500 chars) | UI must surface it on upload + display |
| **Audit trail** | ✗ No audit emits in attachment.service.ts | Wire `auditCreate` for upload, `auditDelete` for delete, and add a download audit event |
| **Search by filename** | ✗ Endpoint requires entityType+entityId | New search route |
| **Search by description** | ✗ | New search route |
| **Search by uploader** | ✗ | New search route |
| **Search by date range** | ✗ | New search route |
| **Search by parent entity** | ✓ Partial (must specify both type and id) | Extend search to allow entity-type-only or filename-only |
| Content search (PDF/Office) | ✗ Roadmap | Stay roadmap; build the architectural placeholder (content-extraction job + tsvector column) |
| DMS integration | ✗ No adapter | Build a generic adapter contract (see §4.7) so a connector can be implemented if City requests at go-live |
| Multi-instance storage | ✗ Local FS | Migrate to S3 (or compatible object storage) before any multi-replica production deploy |

---

## 4. Functional requirements

### 4.1 Entity coverage

- **FR-ATT-001** — `ATTACHMENT_ENTITY_TYPES` MUST include all of: `Customer`, `Account`, `Premise`, `Meter`, `ServiceAgreement`, `ServiceRequest`, `Adjustment`. Existing types `RateSchedule` and `BillingCycle` MAY be retained but are not required by the RFP.
  - **Implementation:** Append `ServiceRequest` and `Adjustment` to the list. The validator and the Web UI both pick up the change at compile time because the list is in `packages/shared`.
  - **Acceptance:** Compile-time TypeScript check passes for both API + Web; `<AttachmentsTab entityType="ServiceRequest">` and `<AttachmentsTab entityType="Adjustment">` type-check.

- **FR-ATT-002** — Service Request detail page (`/service-requests/[id]`) MUST mount `<AttachmentsTab>` for `entityType="ServiceRequest"`. The existing `service_request.attachments` JSON column is deprecated; any data is one-time migrated to `attachment` rows during the schema migration.
  - **Acceptance:** A field tech (Tier-3 mobile, [02-mobile §3.4 FR-MOB-T3-005](./02-mobile-and-responsive-ui.md)) attaches a photo to an SR; the file appears on the desktop SR detail page in the same Attachments tab.

- **FR-ATT-003** — Adjustment detail page (path TBD by Module 10 build) MUST mount `<AttachmentsTab>` for `entityType="Adjustment"`. **Pre-condition:** the Adjustment entity itself must exist. This requirement is contingent on Module 10's build; until Adjustment ships, this FR is parked.
  - **Acceptance:** Same pattern as FR-ATT-002, against the Adjustment domain when it lands.

### 4.2 File-type coverage

- **FR-ATT-010** — `ALLOWED_MIME_TYPES` MUST include the following beyond today's set:
  - `application/vnd.ms-powerpoint` (PPT)
  - `application/vnd.openxmlformats-officedocument.presentationml.presentation` (PPTX)
  - `image/heic` (iOS Photos default — recommended; field techs photographing meters)
  - `image/tiff` (scanned-document workflow)
  - `application/vnd.oasis.opendocument.text` (ODT) — optional, City confirmation
  - `application/vnd.oasis.opendocument.spreadsheet` (ODS) — optional, City confirmation
  - **Acceptance:** Upload one of each via the API; row is created and download returns the file.

- **FR-ATT-011** — File-type validation MUST verify both the declared `Content-Type` AND a magic-number sniff of the first 8 bytes for the high-risk types (PDF, Office, executable formats). A renamed `.exe → .pdf` upload MUST be rejected.
  - **Implementation:** Use `file-type` npm package or equivalent. Inconsistent types reject with HTTP 415.
  - **Acceptance:** Manual test: rename a .exe to .pdf, upload, verify 415 with a clear error.

- **FR-ATT-012** — File size limit per upload: configurable, default 25 MB (up from 10 MB). Tenant-level override via `tenant_config.attachment_max_size_mb` with a hard ceiling of 100 MB to protect platform resources.
  - **Acceptance:** Default behavior + tenant-override behavior both verified.

### 4.3 Metadata fields

- **FR-ATT-020** — Each attachment MUST capture: `id`, `utilityId`, `entityType`, `entityId`, `fileName`, `fileType` (MIME), `fileSize` (bytes), `uploadedBy` (CisUser id), `createdAt`, `description` (optional, ≤500 chars).
  - **Plus new fields:**
    - `sha256Hash` — SHA-256 of file content. Set at upload time, used for integrity verification + duplicate detection.
    - `originalFileName` — the user-supplied name preserved verbatim. `fileName` may be normalized (Unicode NFC, path-stripped) for storage; `originalFileName` is the display value.
    - `softDeletedAt` — null for active rows; set at delete time (see FR-ATT-031).
    - `softDeletedBy` — actor of the delete.

- **FR-ATT-021** — Upload endpoint MUST return all metadata fields (excluding `storagePath` for security). The response shape is the source of truth for the client UI.

### 4.4 Audit trail

- **FR-ATT-030** — Every upload MUST emit an audit log entry of class `OPERATIONAL` (per [01-audit §3.4 FR-AUDIT-032](./01-audit-and-tamper-evidence.md)) with:
  - `entityType`: `"attachment"`
  - `entityId`: the new attachment row's ID
  - `action`: `"CREATE"`
  - `actorId`: uploader's CisUser ID
  - `beforeState`: null
  - `afterState`: full attachment row excluding storage path
  - **Acceptance:** Upload an attachment; verify a corresponding `audit_log` row exists with classified `event_class`.

- **FR-ATT-031** — Delete is **soft-delete**. The DELETE endpoint sets `softDeletedAt` + `softDeletedBy` and emits an audit row of class `OPERATIONAL` with `action: "DELETE"`, `beforeState`: full row, `afterState`: null. The file content is retained on storage for 90 days (configurable per tenant via `tenant_config.attachment_purge_days`), after which a sweeper job hard-deletes both the row and the storage object.
  - **Rationale:** Forensic review of removed evidence is a frequent need; immediate hard-delete prevents that. 90 days mirrors the typical financial-investigation discovery window.
  - **Acceptance:** Delete an attachment; verify it disappears from `listAttachments` (which now filters `softDeletedAt IS NULL`); verify the file is still on disk; verify the sweeper purges after the configured window.

- **FR-ATT-032** — Download MUST emit an audit log entry of class `OPERATIONAL` with `action: "DOWNLOAD"`, `actorId`: requester's CisUser ID, `metadata`: `{ ipAddress, userAgent, attachmentId }`. Download tracking is a frequent compliance requirement that the RFP doesn't explicitly require but is the tier-1 interpretation of "complete audit trail."
  - **Note:** This is high-volume — a CSR opening a PDF attachment is a download. Audit volume bounded by the per-class retention from doc 01.
  - **Acceptance:** Download an attachment; verify the audit row exists with the IP and user agent.

### 4.5 Search

- **FR-ATT-040** — A new search endpoint `GET /api/v1/attachments/search` MUST support the following query parameters, all optional, all combinable with AND semantics:
  - `entityType` — one of `ATTACHMENT_ENTITY_TYPES` (or `"any"`)
  - `entityId` — UUID; ignored if `entityType` is unset
  - `fileName` — substring match (case-insensitive) against `originalFileName`
  - `description` — substring match (case-insensitive) against `description`
  - `uploadedBy` — CisUser ID OR a free-text matcher against `actor_name` from the audit row (resolves to user IDs internally)
  - `from` — ISO datetime; lower bound on `createdAt`
  - `to` — ISO datetime; upper bound on `createdAt`
  - `fileType` — MIME-type prefix (e.g., `image/`, `application/pdf`)
  - `includeDeleted` — boolean; default false
  - `cursor` — pagination cursor (compound `(createdAt, id)`)
  - `limit` — page size, default 25, max 100
  - **Permission:** `attachments:VIEW` PLUS the user must have VIEW on the parent module of any returned row. RLS enforces tenant scope; the row-level permission filter applies post-query (filter then page).
  - **Acceptance:** Each filter exercised individually + at least three combination cases verified by integration test.

- **FR-ATT-041** — Search results MUST include all attachment metadata + a denormalized `parentEntityLabel` (e.g., the customer's name, the SR's request number) so the UI can show meaningful row labels without a follow-up fetch per row.
  - **Implementation:** Service joins the appropriate parent table by `entityType`. For seven entity types the join is a `switch`; the result type is uniform.

- **FR-ATT-042** — Search performance: ≤500ms p95 for queries hitting any single index combination on a tenant with 1M attachments. The two existing indexes (`(utility_id, entity_type, entity_id)` and `(utility_id, uploaded_by)`) are enough for parent-entity and uploader filters; add `(utility_id, created_at)` for date-range queries and a trigram GIN on `original_file_name` for filename-substring. Description searches over a tenant's 1M rows will be slower (p95 ≤2s acceptable).
  - **Implementation:** New migration adds the indexes. Trigram extension `pg_trgm` is enabled tenant-wide.

- **FR-ATT-043** — A web UI surface lives at `/attachments/search`, gated by `attachments:VIEW`. Filter chips for each query parameter. Results render as a virtualized list (10k rows on screen without jank) with thumbnail for image/PDF previews where feasible.
  - **Acceptance:** Manual + automated UI test.

### 4.6 Storage backend

- **FR-ATT-050** — Production storage MUST be S3-compatible object storage. The local filesystem implementation is dev-only and MUST be guarded by `config.NODE_ENV === "development"` at the service-resolver level. Production deploys configure `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (optional, for non-AWS providers like MinIO), and KMS key ARN.
  - **Implementation:** Two implementations of an `AttachmentStorage` interface — `LocalFsStorage` and `S3Storage`. Service factory picks based on `config.STORAGE_BACKEND`.
  - **Acceptance:** Same integration tests pass against both backends. Production smoke test verifies upload + download round-trip against the configured S3 endpoint.

- **FR-ATT-051** — All file content stored in S3 MUST be encrypted at rest with SSE-KMS and a customer-managed key. The KMS key is per-tenant where the deployment topology supports it (multi-tenant SaaS) or per-deployment otherwise (single-tenant).
  - **Acceptance:** AWS CLI verification in deployment runbook. Bucket policy denies non-encrypted writes.

- **FR-ATT-052** — Storage-path naming: `<utilityId>/<YYYY>/<MM>/<DD>/<attachmentId>--<sha256Prefix>--<safeFileName>`. The prefix structure aids both human inspection and S3 listing performance (no prefix-collision hot-spotting).
  - **Acceptance:** New uploads land under the documented path structure.

- **FR-ATT-053** — Download responses MUST be served via S3 pre-signed URLs in production (5-minute expiry). The API endpoint redirects to the pre-signed URL rather than streaming bytes through the API process. This shifts bandwidth off the API tier and makes the API pod size independent of attachment volume.
  - **Acceptance:** A 200MB download doesn't traffic through the API process; the API responds with 302 to a signed URL.

### 4.7 DMS integration adapter

- **FR-ATT-060** — A `DocumentManagementSystem` interface MUST exist as a port (in the hexagonal-architecture sense) with the following operations:
  - `index(attachment)` — push the attachment metadata + content to the DMS
  - `search(query, tenantId)` — full-text search across DMS content; returns `{ attachmentId, snippet, score }[]`
  - `delete(attachmentId)` — propagate a delete (soft or hard) to the DMS
  - **No-op default:** when no DMS is configured, the interface is satisfied by a `NoopDms` implementation that returns empty search results and rejects nothing.

- **FR-ATT-061** — The first concrete DMS adapter built (when the City requests it) targets one of: Laserfiche, OnBase, M-Files, or SharePoint. Adapter selection happens at deploy time via `config.DMS_ADAPTER` and corresponding credentials. **No specific DMS is committed by this RFP.**
  - **Acceptance:** Adapter contract test runs against a stub server that records the calls; verify each interface method is called with the expected payload.

- **FR-ATT-062** — When a DMS is configured, every upload event triggers an asynchronous `dms-index` job (BullMQ, see [scheduler-migration plan](../superpowers/plans/2026-04-24-job-scheduler-migration.md)). Failures retry per the DMS adapter's policy; persistent failures land in a DLQ surfaced to operators.
  - **Acceptance:** Upload an attachment with a configured DMS stub; verify the index job fires; verify a DLQ entry on simulated failure.

### 4.8 Native full-text content search (roadmap)

The RFP commits this as roadmap. The doc captures the architectural placeholder so the team can ship it without a major refactor when prioritized.

- **FR-ATT-070 (roadmap, not in this RFP)** — Native FTS MUST extract text from PDF and Office formats at upload time, store extracted text in a `attachment_content` table with a `tsvector` index, and support search via `GET /api/v1/attachments/search?content=...`.
  - **Pre-conditions:**
    - PDF text extraction: `pdf-parse` or `pdf2json` (Node) or PostgreSQL extension `pg_pdf` (heavier).
    - Office extraction: `mammoth` (DOCX → text), `xlsx` (XLSX → CSV-ish), `node-pptx` or LibreOffice-headless for PPTX.
    - Async extraction job runs after upload and populates the search table.
  - **Note:** This is documented but not promised by the RFP. The DMS adapter (FR-ATT-060) is the substitute for go-live if content search is required.

---

## 5. Data + infrastructure changes

```prisma
model Attachment {
  id                String    @id @default(uuid()) @db.Uuid
  utilityId         String    @map("utility_id") @db.Uuid
  entityType        String    @map("entity_type") @db.VarChar(100)
  entityId          String    @map("entity_id") @db.Uuid
  fileName          String    @map("file_name") @db.VarChar(500)
  originalFileName  String    @map("original_file_name") @db.VarChar(500)
  fileType          String    @map("file_type") @db.VarChar(100)
  fileSize          Int       @map("file_size")
  storagePath       String    @map("storage_path") @db.VarChar(1000)
  sha256Hash        String    @map("sha256_hash") @db.Char(64)
  uploadedBy        String    @map("uploaded_by") @db.Uuid
  description       String?   @db.VarChar(500)
  softDeletedAt     DateTime? @map("soft_deleted_at") @db.Timestamptz
  softDeletedBy     String?   @map("soft_deleted_by") @db.Uuid
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, entityType, entityId])
  @@index([utilityId, uploadedBy])
  @@index([utilityId, createdAt])
  @@index([utilityId, sha256Hash])
  // Trigram GIN index added via raw SQL migration (Prisma doesn't model GIN)

  @@map("attachment")
}

// New TenantConfig fields
model TenantConfig {
  // ... existing fields ...
  attachmentMaxSizeMb     Int     @default(25)  @map("attachment_max_size_mb")
  attachmentPurgeDays     Int     @default(90)  @map("attachment_purge_days")
  dmsAdapter              String? @map("dms_adapter") @db.VarChar(50)  // 'laserfiche' | 'onbase' | 'mfiles' | 'sharepoint' | null
  dmsConfig               Json?   @map("dms_config")  // adapter-specific connection details (encrypted at rest)
}

// (Roadmap — not in this RFP)
// model AttachmentContent {
//   attachmentId  String  @id @db.Uuid
//   extractedText String  @map("extracted_text") @db.Text
//   searchVector  Unsupported("tsvector")? @map("search_vector")
//   extractedAt   DateTime @map("extracted_at") @db.Timestamptz
// }
```

**Migrations needed:**
1. `add_attachment_metadata_columns` — sha256, originalFileName, soft-delete columns.
2. `add_attachment_search_indexes` — `(utility_id, created_at)` btree; `pg_trgm` GIN on `original_file_name`.
3. `extend_attachment_entity_types` — no schema change (the enum is in `shared/`); regenerate types.
4. `migrate_service_request_attachments` — one-shot migration moving any existing `service_request.attachments` JSON entries to `attachment` rows, then dropping the column.
5. `tenant_config_attachment_settings` — three new config columns.

**API additions:**
- `GET /api/v1/attachments/search` — new search endpoint (FR-ATT-040)
- `POST /api/v1/attachments/:id/restore` — un-soft-delete (admin-only; helpful when accidental delete needs reversal within the 90-day purge window)

**New deps:**
- `file-type@^19` — magic-byte sniff
- `@aws-sdk/client-s3@^3` and `@aws-sdk/s3-request-presigner@^3` — S3 storage backend
- `pg_trgm` Postgres extension — enabled per migration

**New BullMQ queue:**
- `attachment-purge` — daily sweep that hard-deletes attachments where `softDeletedAt < now() - tenant.attachmentPurgeDays * 1day`. Uses the same pattern as the `audit-retention` worker from the scheduler migration.

**Optional new BullMQ queue (DMS):**
- `dms-index` — fires per upload when a DMS adapter is configured.

---

## 6. Implementation sequence

Each step is independently shippable. Steps 1-3 close the bulk of the RFP gap; steps 4-6 raise the bar to production-grade.

1. **Add ServiceRequest to entity types + mount AttachmentsTab on SR detail page.** Migrate any JSON-column data. Effort: S (~1-2 days).
2. **Audit trail wiring.** Add `auditCreate` on upload, `auditDelete` on soft-delete, and a new `auditDownload` action. Soft-delete migration. Background purge worker. Effort: M (~3-4 days).
3. **Search endpoint + UI.** Indexes + service + route + `/attachments/search` page. Effort: M (~4-5 days).
4. **S3 storage backend.** Implement the `AttachmentStorage` port; switch production via env. KMS key + bucket setup. Pre-signed URL download path. Effort: M (~3-4 days, plus 1 day infra).
5. **PowerPoint + HEIC + TIFF MIME-type allowlist** + magic-byte validation. Effort: S (~1 day).
6. **DMS adapter port + Noop implementation** + per-tenant config + `dms-index` queue scaffolding. **No specific DMS connector built** — that's a Phase 2 deliverable conditional on City selection. Effort: M (~3-4 days for the port + scaffolding).
7. **Adjustment domain attachments.** Blocked by Module 10 build. Trivially trivial (~half day) once Adjustment exists.
8. **Native FTS (roadmap, NOT in this RFP).** Effort: L when prioritized.

**Recommended pre-signature scope:** items 1, 2, 3, 5. The platform shows full audit trail, multi-field search, all RFP-listed entity types except Adjustment (called out as blocked), full file-type coverage. S3 storage (4) and DMS adapter (6) commit to Phase 1 deliverables but are explicit Phase 1 sprint work.

---

## 7. Out of scope for this RFP

- **Native full-text content search across PDF/Office** — explicitly roadmap per the RFP. Acceptable unless City overrides.
- **A specific DMS adapter implementation** — the port and scaffolding are committed; the choice of DMS (Laserfiche vs OnBase vs SharePoint vs M-Files) and the connector itself are conditional on City requirement at go-live.
- **Versioning** — re-uploading a file with the same name does not produce a version chain; it creates a new row. Versioning (per-file history with diff/rollback) is not in scope.
- **In-browser editing** — clicking a DOCX opens the system handler / downloads the file; no in-browser Word/Excel editor is provided.
- **Watermarking on download** — sensitive-document watermarking with viewer name + timestamp is not promised.
- **Digital signatures on attachments** — no S/MIME or PAdES signature verification.
- **Bulk download (zip)** — selecting N attachments and downloading as a single archive is not promised.
- **Drag-and-drop upload from email clients** — attachments must come from the file picker or camera capture.
- **Folder hierarchies within an entity's attachments** — the model is flat (one entity → N attachments). No subfolders.
- **Sharing links to non-CIS users** — every download requires a logged-in CIS user with `attachments:VIEW`. No public links.
- **Native support for medical imaging formats (DICOM)** or **CAD formats** — out of scope unless the City confirms a need.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Migrating SR JSON-column attachments mid-flight could lose data | Take a backup of `service_request.attachments` before the migration. Run the migration in dry-run mode first; verify row counts match. |
| 90-day purge window deletes legitimate evidence | Tenant-configurable. Surface clearly in `/settings/automation` UI. Operators can extend on a per-tenant basis when active investigations are open. |
| S3 + KMS cost grows faster than expected | Per-tenant cost surfaced in the operator dashboard. Audit-retention sweep + attachment-purge sweep keep storage bounded. |
| Trigram GIN index on `original_file_name` slows inserts | Negligible at our write rate. Documented in migration notes. |
| Magic-byte validation rejects a file that's technically valid but unusually-formed (legacy DOC files from old Office versions) | Allowlist explicitly lists the older MIME types. If validation rejects, the user sees a clear error pointing to support. |
| HEIC support requires server-side decoding for thumbnails | Browser support is fine; thumbnail generation falls back to a generic file-type icon for HEIC if no decoder is present. Not blocking. |
| DMS adapter contract drifts as connectors are built | Contract is versioned (`DocumentManagementSystem` interface in shared/). New connector additions extend the contract; never break it. |
| Pre-signed URLs leak via referrer or browser history | URLs are 5-minute expiry; downloaded once by the user, irrelevant after. Documented as accepted. |
| A user with `attachments:VIEW` on any module sees attachments from another module their role doesn't grant access to | Search endpoint applies post-query filtering against the user's permission set per entity-type. Test the cross-permission case explicitly. |

---

## 9. Acceptance criteria summary

The Attachments commitment is satisfied when ALL of the following pass:

- [ ] Upload + view + download + delete works on Customer, Account, Premise, Meter, ServiceAgreement, ServiceRequest. Adjustment is gated on Module 10 build (FR-ATT-001, FR-ATT-002).
- [ ] All RFP-listed file types accepted: PDF, PNG/JPEG/GIF/WebP, PPT/PPTX, DOC/DOCX, XLS/XLSX, plain text, CSV. Magic-byte validation rejects mismatched declared types (FR-ATT-010, FR-ATT-011).
- [ ] Each upload creates an `audit_log` row with full state + actor; soft-delete creates a corresponding row; downloads create rows with IP + user agent (FR-ATT-030, FR-ATT-031, FR-ATT-032).
- [ ] Search endpoint supports filename, description, uploader, date range, file-type, parent-entity filters individually and combined; performance p95 ≤500ms on 1M-row tenant for indexed combinations (FR-ATT-040, FR-ATT-042).
- [ ] Search UI surfaces at `/attachments/search` with all filter chips; results virtualized; thumbnails for images and PDFs (FR-ATT-043).
- [ ] Production storage runs against S3 with SSE-KMS; pre-signed URLs serve downloads; API process bandwidth independent of file size (FR-ATT-050, FR-ATT-051, FR-ATT-053).
- [ ] DMS adapter port exists in the codebase; Noop default; tenant config exposes `dmsAdapter` selection without committing to a specific implementation (FR-ATT-060).
- [ ] Native FTS NOT implemented (verifies the roadmap statement) (FR-ATT-070).
- [ ] Soft-delete window honors tenant config; attachment files purged after `attachment_purge_days` via the new BullMQ worker (FR-ATT-031).

Sign-off: backend lead + frontend lead + security review + proposal owner.
