# 04 — Attachments

**RFP commitment owner:** SaaSLogic Utilities (`packages/api` + `packages/web`)
**Status:** Drafted — partial implementation. The basic upload / list / download / delete plumbing exists for five entity types and seven MIME-type families. The RFP commits two additional entity types, three additional capabilities (audit trail, multi-field search, optional DMS integration), and broader file-type coverage that aren't built today.
**Effort estimate:** L (~3-4 weeks engineering, plus dependent work on the Adjustment domain that isn't in this doc).

---

## 1. RFP commitment (verbatim)

> Every major business entity — customer, account, premise, meter, service agreement, service request, adjustment — supports an Attachments tab where users with appropriate permissions can upload, view, download, and delete files (PDF, image formats, Office formats, plain text, CSV). Each attachment carries metadata (uploader, timestamp, size, type, optional description) and a complete audit trail.

> Attachments are searchable by filename, description, uploader, date range, and the parent entity to which they are attached. Full-text search across PDF and Office document content is on the product roadmap; today, attachment-content search is available through integration with the City's existing document-management system if that capability is required at go-live.

> SaaSLogic Utilities integrates with third-party document management systems (SharePoint, Laserfiche, OnBase, M-Files, etc.) through Apptorflow. Documents can be stored externally with pointers maintained in SaaSLogic Utilities, or stored in SaaSLogic Utilities with replication to the external system. The integration approach will be agreed with the City during design.

> Data retention: Retention policies are configurable by entity type and document category (e.g., utility bills retained 7 years; service request attachments 5 years). Archival moves attachments to lower-cost AWS S3 tiers without removing them from search. Purges are governed by policy, require dual approval where configured, and are recorded in the audit log with an immutable manifest of purged items.

The commitment breaks into eight distinct capability areas:

1. **Entity coverage** — seven entity types (claim adds ServiceRequest + Adjustment to current five).
2. **CRUD with permissions** — upload, view, download, delete; permission-gated.
3. **File-type coverage** — PDF, images, Office formats, plain text, CSV.
4. **Metadata + audit trail** — uploader, timestamp, size, type, description, plus full audit history.
5. **Search** — filename, description, uploader, date range, parent entity.
6. **Content search** — explicit roadmap item for native FTS; conditional commitment for DMS integration if required at go-live.
7. **Apptorflow-mediated DMS integration** — SharePoint / Laserfiche / OnBase / M-Files connectors via the company's integration platform. Two patterns: external-storage-with-pointer or internal-with-replication. Pattern chosen per tenant in the design phase.
8. **Retention + archival + purge** — per-entity-type AND per-document-category retention policies, S3 lifecycle archival to lower-cost tiers without losing search, dual-approved purges that emit an immutable signed manifest to the audit-log infrastructure from doc 01.

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
| DMS integration | ✗ No connector path | Build via Apptorflow (see §4.7); two patterns (external pointer / internal-with-replication) chosen per tenant at design time |
| **Apptorflow connection** | ✗ No Apptorflow client in codebase | Add Apptorflow client + per-tenant config + pattern selector |
| **External-pointer storage** | ✗ Schema doesn't carry external IDs | Add `externalDmsSystem`, `externalDmsId`, `externalDmsUrl` columns; storage path optional under this pattern |
| **Per-entity-type retention** | ✗ One tenant-wide value only | New `retention_policy` table with `entityType × documentCategory × tenant` granularity |
| **Document categories** | ✗ Don't exist | New `document_category` enum + per-attachment classification at upload time |
| **S3 lifecycle archival to lower-cost tiers** | ✗ All files would land in Standard | Standard → Standard-IA → Glacier IR → Glacier Deep Archive. Metadata stays in Postgres so search is unaffected. |
| **Restore from archive** | ✗ | `archiveStatus` column + restore endpoint + UI "Restoring..." state with completion notification |
| **Dual-approved purge** | ✗ | Reuse approval pattern from doc 01 §3.5 (`pending_security_change` table generalized to `pending_administrative_change`) |
| **Immutable purge manifest** | ✗ | Reuse Merkle + object-lock infrastructure from doc 01 §3.3 (signed manifest in object-lock-compliance bucket) |
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

### 4.7 DMS integration via Apptorflow

The RFP commits to integration with SharePoint, Laserfiche, OnBase, M-Files, and similar DMS platforms **through Apptorflow** — the company's integration platform that owns the connectors. SaaSLogic Utilities does not implement DMS connectors directly; it talks to Apptorflow over a stable API, and Apptorflow translates to whatever DMS the City has selected.

Two integration patterns are supported. Pattern selection is per-tenant, agreed during the design phase, and reversible (a tenant can switch later — at the cost of a one-time migration job).

#### Pattern 1: External storage with pointer

- The DMS is the system of record for the file content.
- SaaSLogic Utilities stores only **metadata + a pointer** (DMS document ID, source system identifier, optional pre-signed-URL recipe).
- The Apptorflow upload flow: user uploads through SaaSLogic UI → API streams file body to Apptorflow → Apptorflow forwards to DMS → DMS returns its document ID → Apptorflow returns it to API → API persists the row with `externalDmsId` populated and `storagePath` null.
- Download flow: API requests a download URL from Apptorflow → Apptorflow asks the DMS for one (or fetches the bytes via DMS API and pipes back) → API responds with a redirect or stream depending on adapter shape.
- Search by metadata still works (filename, description, uploader, date range, parent entity) — the metadata is in Postgres regardless of where the bytes live.
- Native full-text content search (when built) works against DMS-indexed content via Apptorflow's search interface.

#### Pattern 2: Internal storage with replication

- SaaSLogic Utilities S3 bucket is the system of record for the file content.
- Every upload triggers an asynchronous replication job that pushes the file to the configured external DMS via Apptorflow. Replication is write-through; deletes are mirrored to the DMS with the same dual-approval gating defined in §4.8.
- Download flow: served from local S3 (per §4.6 with pre-signed URLs). The DMS holds the disaster-recovery + compliance copy.
- Pattern 2 is the default for tenants that don't pick Pattern 1 and is the recommendation when the DMS is brittle, has poor read latency, or has a storage cost that doesn't scale linearly.

#### Functional requirements

- **FR-ATT-060** — An `ApptorflowClient` MUST exist in `packages/api/src/integrations/apptorflow/`. It exposes:
  - `dms.upload(file, metadata)` — Pattern 1 entry point; returns `{ externalDmsId, externalDmsSystem, externalDmsUrl }`
  - `dms.download(externalDmsId)` — Pattern 1 download; returns either a stream or a pre-signed URL the API can redirect to
  - `dms.replicate(attachmentId, file, metadata)` — Pattern 2 entry point; queued, not synchronous
  - `dms.delete(externalDmsId, options)` — propagate delete to the DMS; honors soft-delete vs hard-delete semantics
  - `dms.searchContent(query, tenantId)` — full-text search against DMS-indexed content; returns `{ attachmentId, snippet, score }[]`
  - **Acceptance:** Each method has a contract test against a recorded Apptorflow stub. The stub records every call; we replay against staging Apptorflow before production cutover.

- **FR-ATT-061** — Tenant config MUST select between three modes via `tenant_config.dms_integration_mode`:
  - `"none"` — no DMS integration; storage per §4.6 only. Default.
  - `"pattern_1_external"` — Pattern 1, file body never lands in SaaSLogic S3. Requires `dms_target_system` (one of `sharepoint | laserfiche | onbase | mfiles | other`) and credentials passed through to Apptorflow.
  - `"pattern_2_replication"` — Pattern 2, file body in SaaSLogic S3 + replicated. Requires same fields.
  - **Acceptance:** Each mode covered by an integration test using the Apptorflow stub.

- **FR-ATT-062** — Pattern 2 replication runs as a BullMQ job on a new `dms-replication` queue (per the scheduler-migration plan from `../superpowers/plans/2026-04-24-job-scheduler-migration.md`). Retries per Apptorflow's documented retry policy. Persistent failures land in `dlq-dms-replication` and surface to operators with the original attachment row preserved (the SaaSLogic S3 copy remains the truth).
  - **Acceptance:** Upload with Pattern 2 + simulated Apptorflow failure → DLQ row visible in Bull Board; original attachment downloadable from SaaSLogic S3.

- **FR-ATT-063** — Pattern 1 upload flow MUST stream the file body to Apptorflow rather than buffering through the API process. The API process never holds more than one chunk in memory at a time; total upload time ≤ Apptorflow's documented latency + ~10% overhead.
  - **Acceptance:** A 100 MB upload with Pattern 1 doesn't increase API process RSS by more than 50 MB.

- **FR-ATT-064** — Pattern switch (per-tenant, e.g., from Pattern 2 to Pattern 1 mid-deployment) MUST be supported via a one-shot migration job:
  - Pattern 2 → Pattern 1: re-upload every existing attachment to the DMS via Apptorflow, persist the returned external IDs, then null out `storagePath` and remove from S3.
  - Pattern 1 → Pattern 2: pull every existing attachment from the DMS, push to S3, leave `externalDmsId` for compliance lineage.
  - **Acceptance:** Migration job tested with 10k attachments on a staging tenant; failure recovery is idempotent (re-running picks up where it left off).

- **FR-ATT-065** — Apptorflow connection state (latency, error rate, queue backlog) MUST be exposed via the existing `prom-client` registry so the worker process's `/metrics` endpoint reports it. Operators add a Grafana panel per tenant once Ship 2's observability stack lands (per scheduler-migration spec §7).

- **FR-ATT-066** — When `dms_integration_mode` is set, the design phase document captures: the target DMS system, the Apptorflow connector version, expected latency budget, retention-policy handoff (does the DMS apply its own retention, or does SaaSLogic alone govern? — see §4.8), and the disaster-recovery test cadence.
  - **Note:** This is a process requirement, not an automated test. The handoff document is signed by the City, the SaaSLogic implementation lead, and the Apptorflow integration lead before go-live.

### 4.8 Retention, archival, and purge

The RFP commits per-entity-type and per-document-category retention, archival to lower-cost S3 tiers without losing search, dual-approved purges, and an immutable manifest of purged items. This section operationalizes those four commitments.

#### Document categories

A new `document_category` classifier sits **alongside** the entity-type tag. The same parent entity can have attachments in multiple categories with different retention policies. Default categories (extensible per tenant):

| Category | Typical retention | Examples |
|---|---|---|
| `IDENTIFICATION` | 7 years | Driver's license, passport copies for customer onboarding |
| `BILLING_DOCUMENT` | 7 years | Generated bills, payment receipts |
| `CONTRACT` | 10 years | Service agreements, signed contracts |
| `CORRESPONDENCE` | 5 years | Emailed correspondence, letters |
| `SR_EVIDENCE` | 5 years | SR description photos, proof of work |
| `METER_PHOTO` | 3 years | Field-tech meter-read photos |
| `MISC` | 1 year | Catch-all; tenant default if not specified |

The category is captured at upload time. Default category per entity type (uploader can override):

| Entity type | Default category |
|---|---|
| Customer | `IDENTIFICATION` |
| Account | `BILLING_DOCUMENT` |
| Premise | `MISC` |
| Meter | `METER_PHOTO` |
| ServiceAgreement | `CONTRACT` |
| ServiceRequest | `SR_EVIDENCE` |
| Adjustment | `BILLING_DOCUMENT` |

#### Functional requirements — retention

- **FR-ATT-080** — A `retention_policy` table MUST capture per-tenant policies keyed by `(entityType, documentCategory)`. Each row carries:
  - `retentionDays` — total days from upload before purge
  - `archiveAfterDays` — when to lifecycle-transition to a lower S3 tier (typically retentionDays - 365 or 50% of retentionDays, whichever is later)
  - `requireDualApprovalForPurge` — boolean
  - `lastModifiedBy` / `lastModifiedAt`
  - **Floor enforcement:** financial-class categories (`BILLING_DOCUMENT`, `CONTRACT`) have a 7-year floor that the tenant cannot reduce below the regulatory minimum (matches doc 01 §3.6 FR-AUDIT-050).

- **FR-ATT-081** — `/settings/automation` UI page (already shipped per scheduler-migration Task 5) MUST be extended with a "Retention policies" section. Operators view a matrix of `(entityType, documentCategory)` cells, each editable in place. Floors are visible but non-editable. Save commits a new `retention_policy` row + emits an audit log entry of class `SECURITY`.

- **FR-ATT-082** — Default retention values are seeded from the table above when a tenant first onboards. Custom per-tenant values override defaults; the UI shows both.

- **FR-ATT-083** — The retention engine evaluates each attachment against `(retentionPolicy.retentionDays - createdAt) > now()`. The evaluation runs in the same daily worker introduced in §4.4 (the soft-delete purger) — but for retention-policy purges, the path is different: dual approval gate first (FR-ATT-091), then purge.

#### Functional requirements — archival

- **FR-ATT-085** — Lifecycle transitions on the SaaSLogic S3 bucket (Pattern 2 default) MUST be configured to:
  - Days 0-90: S3 Standard (live data; immediate access)
  - Days 90-365: S3 Standard-IA (Infrequent Access; same retrieval latency, lower cost)
  - Days 365-730: S3 Glacier Instant Retrieval (still ~milliseconds, much lower cost)
  - Days 730+: S3 Glacier Deep Archive (cheapest, ~12-hour retrieval latency)
  - Per-tenant override: tenants in `dms_integration_mode = pattern_1_external` skip lifecycle entirely (their bytes live in the DMS, not in our bucket).

- **FR-ATT-086** — `attachment.archive_status` column tracks the current S3 storage class (`STANDARD | STANDARD_IA | GLACIER_IR | GLACIER_DEEP_ARCHIVE | RESTORING`). A nightly reconciliation job cross-references S3's reported storage class with our tracked value and corrects drift.
  - **Acceptance:** Manually transition an object via AWS Console; verify the next reconciliation update aligns the column.

- **FR-ATT-087** — **Search remains functional regardless of archive status.** All search filters (filename, description, uploader, date range, parent entity, file type) operate on Postgres metadata that is never archived. The result row carries an `archiveStatus` field so the UI can show a "Restoring..." or "Archived" badge instead of a download button.
  - **Acceptance:** A Glacier-Deep-Archive-tier attachment appears in search results with the correct badge; the row's metadata is fully readable.

- **FR-ATT-088** — A "Restore from archive" endpoint `POST /api/v1/attachments/:id/restore` MUST initiate an S3 restore request and update `archive_status` to `RESTORING`. UI surfaces the in-progress state and notifies the user (in-app banner + optional email per the Module 13 notification engine) when the file is available.
  - **Acceptance:** Restore a Glacier Deep Archive object; verify the API call completes and a notification is sent on completion.

- **FR-ATT-089** — Restore costs (proportional to the size of restored files and tier) MUST be capped per tenant per day via `tenant_config.attachment_restore_daily_cap_mb` (default 1024 MB / 1 GB). Exceeding the cap rejects the restore with a clear error directing the user to operator support.

#### Functional requirements — purge

- **FR-ATT-090** — Purge candidates are evaluated by the retention worker daily (the existing `attachment-purge` queue from §4.4 expanded). For each candidate:
  - If `requireDualApprovalForPurge = false` for the policy: the worker hard-deletes the attachment row + all storage backends (SaaSLogic S3 + DMS via Apptorflow if Pattern 1 or Pattern 2-with-replication), and emits the manifest entry per FR-ATT-093.
  - If `requireDualApprovalForPurge = true`: the worker enqueues a `pending_administrative_change` row (the generalized form of `pending_security_change` from doc 01 §3.5) with `operationType = "purge_attachment"` and a 30-day TTL. Two designated tenant admins must approve; the actual purge runs only after approval.
  - **Acceptance:** Test both code paths; verify dual-approval gate blocks unapproved purges; verify expired pending changes are reported (not silently dropped).

- **FR-ATT-091** — Dual-approval workflow reuses the pattern from doc 01 §3.5 (FR-AUDIT-040..044): the requester is the retention worker (a system actor), and at least two human admins of the tenant must explicitly approve from a notifications inbox. Self-approval is impossible because the requester is not a human user.

- **FR-ATT-092** — Bulk purge approval: when N attachments fall under the same policy on the same day, the approval request batches them into a single decision (admins approve a list, not N individual requests). The manifest still itemizes every purged row.

- **FR-ATT-093** — **Immutable purge manifest.** Every purge run (whether dual-approved or auto) produces a manifest stored in the audit-log infrastructure from doc 01:
  - Manifest content: tenant ID, run ID, run timestamp (UTC), retention policy snapshot, list of `{ attachmentId, sha256, fileName, fileType, fileSize, uploadedBy, uploadedAt, parentEntityType, parentEntityId, documentCategory, deletedAt, deletedFromBackends: ["saaslogic-s3" | "dms-apptorflow"] }[]`
  - Storage: S3 bucket with object-lock in compliance mode (per doc 01 §3.2), separate from the daily Merkle root bucket
  - Signing: same Ed25519 KMS key used for the daily Merkle roots in doc 01 §3.3; signature over the canonical-JSON manifest body; included alongside the manifest payload
  - Audit log: a row of class `SECURITY` with `action: "PURGE"`, `entityType: "attachment_batch"`, `entityId`: the run ID, `metadata`: the manifest's S3 URI + signature
  - **Acceptance:** A purge run produces a signed manifest in the documented S3 bucket; the verification CLI from doc 01 (FR-AUDIT-024) accepts the signature and prints the manifest body.

- **FR-ATT-094** — Manifest retention: manifests themselves are stored with a 25-year retention (longer than any attachment-content retention). The City's compliance team should be able to prove what was purged and when, decades after the underlying files are gone.

#### Out-of-band purge (operator support path)

- **FR-ATT-095** — A second purge path supports legal hold / GDPR / CCPA "right to be forgotten" requests, where retention should be overridden. Operators (SaaSLogic support, not a tenant admin) trigger this via an internal tool that:
  - Requires a written rationale + ticket reference
  - Emits an audit row of class `SECURITY` with `action: "OUT_OF_BAND_PURGE"`, including the rationale
  - Generates a manifest entry per FR-ATT-093
  - Bypasses the dual-approval policy (the operator + ticket review is the equivalent control)
  - **Acceptance:** Run an out-of-band purge in staging; verify the audit + manifest outputs match the standard purge path.

### 4.9 Native full-text content search (roadmap)

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
enum DocumentCategory {
  IDENTIFICATION
  BILLING_DOCUMENT
  CONTRACT
  CORRESPONDENCE
  SR_EVIDENCE
  METER_PHOTO
  MISC
}

enum ArchiveStatus {
  STANDARD
  STANDARD_IA
  GLACIER_IR
  GLACIER_DEEP_ARCHIVE
  RESTORING
}

enum DmsIntegrationMode {
  NONE
  PATTERN_1_EXTERNAL
  PATTERN_2_REPLICATION
}

enum DmsTargetSystem {
  SHAREPOINT
  LASERFICHE
  ONBASE
  MFILES
  OTHER
}

model Attachment {
  id                  String    @id @default(uuid()) @db.Uuid
  utilityId           String    @map("utility_id") @db.Uuid
  entityType          String    @map("entity_type") @db.VarChar(100)
  entityId            String    @map("entity_id") @db.Uuid
  fileName            String    @map("file_name") @db.VarChar(500)
  originalFileName    String    @map("original_file_name") @db.VarChar(500)
  fileType            String    @map("file_type") @db.VarChar(100)
  fileSize            Int       @map("file_size")
  documentCategory    DocumentCategory @map("document_category")

  // Storage backends — exactly one of {storagePath, externalDmsId} non-null
  // depending on the tenant's dms_integration_mode. Pattern 2 may have BOTH
  // because the file lives in S3 AND has been replicated to the DMS.
  storagePath         String?   @map("storage_path") @db.VarChar(1000)
  archiveStatus       ArchiveStatus @default(STANDARD) @map("archive_status")
  externalDmsSystem   DmsTargetSystem? @map("external_dms_system")
  externalDmsId       String?   @map("external_dms_id") @db.VarChar(500)
  externalDmsUrl      String?   @map("external_dms_url") @db.VarChar(2000)

  sha256Hash          String    @map("sha256_hash") @db.Char(64)
  uploadedBy          String    @map("uploaded_by") @db.Uuid
  description         String?   @db.VarChar(500)
  softDeletedAt       DateTime? @map("soft_deleted_at") @db.Timestamptz
  softDeletedBy       String?   @map("soft_deleted_by") @db.Uuid
  createdAt           DateTime  @default(now()) @map("created_at") @db.Timestamptz

  @@index([utilityId, entityType, entityId])
  @@index([utilityId, uploadedBy])
  @@index([utilityId, createdAt])
  @@index([utilityId, documentCategory, createdAt])  // retention engine
  @@index([utilityId, sha256Hash])
  @@index([utilityId, archiveStatus])  // archival reconciliation
  // Trigram GIN index on original_file_name added via raw SQL migration

  @@map("attachment")
}

// Per-tenant retention policy keyed by (entityType, documentCategory).
// Floor enforcement on financial-class categories per FR-ATT-080.
model RetentionPolicy {
  id                            String           @id @default(uuid()) @db.Uuid
  utilityId                     String           @map("utility_id") @db.Uuid
  entityType                    String           @map("entity_type") @db.VarChar(100)
  documentCategory              DocumentCategory @map("document_category")
  retentionDays                 Int              @map("retention_days")
  archiveAfterDays              Int              @map("archive_after_days")
  requireDualApprovalForPurge   Boolean          @default(false) @map("require_dual_approval_for_purge")
  lastModifiedBy                String?          @map("last_modified_by") @db.Uuid
  lastModifiedAt                DateTime         @updatedAt @map("last_modified_at") @db.Timestamptz
  createdAt                     DateTime         @default(now()) @map("created_at") @db.Timestamptz

  @@unique([utilityId, entityType, documentCategory])
  @@index([utilityId])
  @@map("retention_policy")
}

// New TenantConfig fields
model TenantConfig {
  // ... existing fields ...
  attachmentMaxSizeMb           Int                  @default(25)   @map("attachment_max_size_mb")
  attachmentPurgeDays           Int                  @default(90)   @map("attachment_purge_days")  // soft-delete purge window
  attachmentRestoreDailyCapMb   Int                  @default(1024) @map("attachment_restore_daily_cap_mb")  // FR-ATT-089

  // DMS integration via Apptorflow (FR-ATT-061)
  dmsIntegrationMode            DmsIntegrationMode   @default(NONE) @map("dms_integration_mode")
  dmsTargetSystem               DmsTargetSystem?     @map("dms_target_system")
  apptorflowConnectionId        String?              @map("apptorflow_connection_id") @db.VarChar(64)
  // Apptorflow handles credentials internally — we only carry the connection ID.
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
1. `add_attachment_metadata_columns` — sha256, originalFileName, soft-delete columns, document_category enum + column.
2. `add_attachment_search_indexes` — `(utility_id, created_at)` btree; `pg_trgm` GIN on `original_file_name`.
3. `add_attachment_archival_columns` — archive_status enum + column, retention-engine + reconciliation indexes.
4. `add_attachment_external_dms_columns` — externalDmsSystem, externalDmsId, externalDmsUrl; storage_path becomes nullable.
5. `extend_attachment_entity_types` — no schema change (the enum is in `shared/`); regenerate types.
6. `migrate_service_request_attachments` — one-shot migration moving any existing `service_request.attachments` JSON entries to `attachment` rows, then dropping the column.
7. `create_retention_policy_table` — per-tenant policies + seed defaults from §4.8 table.
8. `tenant_config_attachment_settings` — config fields (retention cap, DMS mode, target, Apptorflow connection ID).

**API additions:**
- `GET /api/v1/attachments/search` — multi-field search (FR-ATT-040)
- `POST /api/v1/attachments/:id/restore` — un-soft-delete OR un-archive depending on context (the service decides based on `softDeletedAt` and `archiveStatus`)
- `GET/PATCH /api/v1/settings/retention-policies` — list + edit per-tenant retention policies (FR-ATT-081)
- `POST /api/v1/admin/attachments/:id/out-of-band-purge` — operator-only path for legal-hold / right-to-be-forgotten (FR-ATT-095)

**New BullMQ queues:**
- `attachment-purge` — daily soft-delete sweep + retention-policy purge (extends the §4.4 purge worker)
- `attachment-archival-reconcile` — nightly check that S3 storage class matches `archive_status` column (FR-ATT-086)
- `dms-replication` — Pattern 2 write-through to Apptorflow (FR-ATT-062)
- `dlq-dms-replication` — failed replications

**S3 bucket configuration:**
- Lifecycle policy per FR-ATT-085 (Standard → Standard-IA at day 90 → Glacier IR at day 365 → Deep Archive at day 730)
- Object-lock-compliance bucket for purge manifests (separate bucket per FR-ATT-093, distinct from the audit-export bucket from doc 01)

**Apptorflow integration:**
- `packages/api/src/integrations/apptorflow/client.ts` — typed client per FR-ATT-060
- `packages/api/src/integrations/apptorflow/contracts/dms.ts` — request/response types matching Apptorflow's DMS contract
- Replay-stub for tests (`packages/api/src/__tests__/integrations/apptorflow-stub.ts`)

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

Each step is independently shippable. The work splits into three layers: the foundation (1-5), Apptorflow + retention (6-9), and conditional/roadmap (10-12). The recommended pre-signature scope covers the foundation; the rest is contracted as Phase 1 or Phase 2 deliverables.

### Foundation (closes baseline RFP gap)

1. **Add ServiceRequest to entity types + mount AttachmentsTab on SR detail page.** Migrate any JSON-column data. Effort: S (~1-2 days).
2. **Document categories + per-attachment classification at upload time.** New enum + column + UI category-picker. Effort: S (~1-2 days).
3. **Audit trail wiring.** Add `auditCreate` on upload, `auditDelete` on soft-delete, new `auditDownload` action. Soft-delete migration. Effort: M (~3-4 days).
4. **Search endpoint + UI.** Indexes + service + route + `/attachments/search` page. Effort: M (~4-5 days).
5. **PowerPoint + HEIC + TIFF MIME-type allowlist** + magic-byte validation. Effort: S (~1 day).

### Production-grade storage (required before multi-replica deploy)

6. **S3 storage backend.** Implement the `AttachmentStorage` port; switch production via env. KMS key + bucket setup. Pre-signed URL download path. Effort: M (~3-4 days, plus 1 day infra).
7. **S3 lifecycle archival** + archive_status reconciliation worker. Effort: M (~2-3 days).

### Apptorflow integration + retention engine

8. **Apptorflow client + Pattern 1 (external) and Pattern 2 (replication) flows.** Build the `ApptorflowClient` per FR-ATT-060 with both upload/download/delete paths; per-tenant `dms_integration_mode` config. Pattern 2 replication queue + DLQ. Effort: L (~5-7 days, plus Apptorflow-side connector work that runs in parallel by the Apptorflow team).
9. **Retention engine — policies + UI + dual-approved purges + immutable manifests.** Reuses doc-01 approval pattern + Merkle/object-lock for manifests. Effort: L (~5-7 days, plus the doc-01 prerequisite of `pending_administrative_change` table being generalized).

### Conditional / blocked / roadmap

10. **Adjustment domain attachments.** Blocked by Module 10 build. Half-day work once Adjustment exists.
11. **Specific DMS connector implementations (SharePoint / Laserfiche / OnBase / M-Files).** Owned by Apptorflow team, not SaaSLogic Utilities. Conditional on City selection at design time. Outside this doc's scope.
12. **Native FTS (roadmap, NOT in this RFP).** Effort: L when prioritized.

**Recommended pre-signature scope:**
- **Foundation (1-5):** ~9-12 days. Closes the baseline audit + search + entity-coverage + file-type gaps. All seven RFP-listed entity types covered except Adjustment.
- **Storage (6-7):** ~5-7 days. Required for any multi-replica prod deploy + lifecycle archival. Should be in scope before signature so the City sees the production-grade story.

That's a 14-19 day pre-signature scope (~3 weeks with one engineer). Items 8 (Apptorflow) and 9 (retention engine) are committed as Phase 1 sprint work in the SOW with explicit milestone dates. The Apptorflow connector implementations themselves (item 11) are conditional and depend on which DMS the City names during design.

---

## 7. Out of scope for this RFP

- **Native full-text content search across PDF/Office** — explicitly roadmap per the RFP. Acceptable unless City overrides.
- **Specific DMS connector implementations** — SaaSLogic Utilities owns the Apptorflow client and the two integration patterns (FR-ATT-060..064). The actual SharePoint / Laserfiche / OnBase / M-Files connectors live in Apptorflow and are agreed during the design phase; their delivery is the Apptorflow team's responsibility.
- **Direct DMS integration without Apptorflow** — every external DMS path goes through Apptorflow. Bespoke connectors that bypass Apptorflow are explicitly not supported (the integration contract would fragment across teams).
- **Two-way sync of edits made directly in the DMS** — when a tenant uses Pattern 1 (external storage with pointer) and edits a document directly in SharePoint/Laserfiche, those edits are not pulled back into SaaSLogic Utilities' metadata. The DMS is treated as a content store, not a collaborative editor.
- **Per-document custom retention overrides** — retention is configured at the `(entityType, documentCategory)` level, not per individual attachment. Legal-hold needs are handled via the out-of-band purge path (FR-ATT-095), not by editing a single document's retention.
- **Glacier-Deep-Archive restore-cost predictability** — restore latency and cost are AWS's responsibility; we expose them in operator UI but don't promise a fixed SLA on restore time (12-hour AWS guideline applies).
- **Audit-log retention for purge manifests via the standard policy** — manifests use a fixed 25-year retention (FR-ATT-094) above whatever the tenant's `audit_retention_by_class` settings say. This is a deliberate floor.
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
| S3 + KMS cost grows faster than expected | Per-tenant cost surfaced in the operator dashboard. Lifecycle archival to lower-cost tiers (FR-ATT-085) bounds storage cost at scale. |
| Trigram GIN index on `original_file_name` slows inserts | Negligible at our write rate. Documented in migration notes. |
| Magic-byte validation rejects a file that's technically valid but unusually-formed (legacy DOC files from old Office versions) | Allowlist explicitly lists the older MIME types. If validation rejects, the user sees a clear error pointing to support. |
| HEIC support requires server-side decoding for thumbnails | Browser support is fine; thumbnail generation falls back to a generic file-type icon for HEIC if no decoder is present. Not blocking. |
| Pre-signed URLs leak via referrer or browser history | URLs are 5-minute expiry; downloaded once by the user, irrelevant after. Documented as accepted. |
| A user with `attachments:VIEW` on any module sees attachments from another module their role doesn't grant access to | Search endpoint applies post-query filtering against the user's permission set per entity-type. Test the cross-permission case explicitly. |
| **Apptorflow availability becomes a SaaSLogic availability dependency in Pattern 1** | Pattern 1 (external storage) means an Apptorflow outage blocks attachment uploads + downloads. Mitigation: tenants choosing Pattern 1 are warned of this coupling at design time; SaaSLogic monitors Apptorflow's health endpoint and surfaces a degraded-mode banner. Critical workflows (SR intake, etc.) continue to function with attachment uploads queued for retry. |
| **Apptorflow contract drift between versions** | Apptorflow's DMS contract is versioned. SaaSLogic pins to a specific Apptorflow API version per release; upgrades go through an integration test against the recorded stub before promotion. |
| **DMS-side retention policy conflicts with SaaSLogic policy** | The handoff document (FR-ATT-066) explicitly captures who governs retention: SaaSLogic alone, DMS alone, or both in lockstep. Most City deployments will pick "SaaSLogic alone — DMS holds the bytes but doesn't expire them." |
| **Glacier Deep Archive restore latency surprises field tech who needs an old photo** | Field-tech UI surfaces the archive status before the user requests; restore notification reaches the tech by email + in-app banner; restore-cap (FR-ATT-089) prevents accidental cost spikes. |
| **Lifecycle policy drift between S3 bucket configuration and SaaSLogic's `archive_status` column** | Nightly reconciliation worker (FR-ATT-086) corrects drift; alerts fire if the drift rate exceeds a threshold. |
| **Dual-approved purge gets stuck — one approver always declines** | `pending_administrative_change` rows have a 30-day TTL; expiry emits a `SECURITY`-class audit row. Operators can escalate to out-of-band purge (FR-ATT-095) with a documented rationale if a legitimate purge is being blocked. |
| **Purge manifest signing key compromise** | Manifest signing reuses the audit-signing KMS key from doc 01 §3.3. If that key rotates, manifests retain their original signatures; the verification CLI accepts any historically-published key fingerprint. |
| **Pattern 2 replication lag during high-write periods** | Per-tenant queue depth metric exposed in observability; alert if depth > 500 entries for >15 min. Reads always serve from SaaSLogic S3 first, so user-visible latency is unaffected. |
| **City requests a DMS that Apptorflow doesn't have a connector for** | The Apptorflow team is responsible for connector availability. SaaSLogic's commitment is the integration *path* via Apptorflow. The handoff document (FR-ATT-066) confirms connector availability before contract signature. |
| **Restoring 1000+ archived files at once exceeds the daily restore cap** | The cap is per-tenant per-day (default 1 GB). Bulk operations either chunk across days or escalate to operator support to lift the cap for a documented reason. |

---

## 9. Acceptance criteria summary

The Attachments commitment is satisfied when ALL of the following pass:

**Foundation (FRs 001-053)**
- [ ] Upload + view + download + delete works on Customer, Account, Premise, Meter, ServiceAgreement, ServiceRequest. Adjustment is gated on Module 10 build (FR-ATT-001, FR-ATT-002).
- [ ] All RFP-listed file types accepted: PDF, PNG/JPEG/GIF/WebP, PPT/PPTX, DOC/DOCX, XLS/XLSX, plain text, CSV. Magic-byte validation rejects mismatched declared types (FR-ATT-010, FR-ATT-011).
- [ ] Document categories captured at upload time; default category per entity type applied if uploader doesn't override (§4.8 categories table).
- [ ] Each upload creates an `audit_log` row with full state + actor; soft-delete creates a corresponding row; downloads create rows with IP + user agent (FR-ATT-030, FR-ATT-031, FR-ATT-032).
- [ ] Search endpoint supports filename, description, uploader, date range, file-type, parent-entity filters individually and combined; performance p95 ≤500ms on 1M-row tenant for indexed combinations (FR-ATT-040, FR-ATT-042).
- [ ] Search UI surfaces at `/attachments/search` with all filter chips; results virtualized; thumbnails for images and PDFs (FR-ATT-043).
- [ ] Production storage runs against S3 with SSE-KMS; pre-signed URLs serve downloads; API process bandwidth independent of file size (FR-ATT-050, FR-ATT-051, FR-ATT-053).

**Apptorflow integration (FRs 060-066)**
- [ ] `ApptorflowClient` exists with all five contract methods (upload, download, replicate, delete, searchContent); contract tests pass against the recorded stub (FR-ATT-060).
- [ ] Tenant config exposes `dms_integration_mode` with three modes (`none`, `pattern_1_external`, `pattern_2_replication`); switching modes triggers the documented migration path (FR-ATT-061, FR-ATT-064).
- [ ] Pattern 1 upload streams the file body through Apptorflow without buffering in API memory; verified by RSS measurement on 100 MB upload (FR-ATT-063).
- [ ] Pattern 2 replication queue + DLQ visible in Bull Board; simulated Apptorflow failure results in DLQ entry without losing the SaaSLogic S3 copy (FR-ATT-062).
- [ ] Design-phase handoff document signed by City + SaaSLogic + Apptorflow before go-live (FR-ATT-066). [Process gate, not a test.]

**Retention, archival, purge (FRs 080-095)**
- [ ] Per-tenant retention policies configurable by `(entityType, documentCategory)`; financial-class floor (7 years) enforced and visible in UI as non-editable (FR-ATT-080, FR-ATT-081).
- [ ] Default retention values seeded on tenant onboarding match the §4.8 table (FR-ATT-082).
- [ ] S3 lifecycle policy moves files: Standard → Standard-IA at 90d → Glacier IR at 365d → Deep Archive at 730d. Verified via AWS CLI + reconciliation worker (FR-ATT-085, FR-ATT-086).
- [ ] Search remains functional for archived files; UI surfaces archive-status badge instead of download button (FR-ATT-087).
- [ ] Restore endpoint initiates S3 restore + updates `archive_status`; user notified on completion. Restore daily cap enforced per tenant (FR-ATT-088, FR-ATT-089).
- [ ] Purge worker honors `requireDualApprovalForPurge`; without dual-approval flag, purge is automatic; with the flag, two human admins must approve via the `pending_administrative_change` workflow (FR-ATT-090, FR-ATT-091).
- [ ] Bulk purge approvals batch into a single decision; manifest itemizes every purged row (FR-ATT-092).
- [ ] Every purge run produces a signed manifest in the object-lock-compliance bucket; the verification CLI from doc 01 (FR-AUDIT-024) accepts the manifest signature (FR-ATT-093).
- [ ] Manifest retention is 25 years; cannot be overridden by tenant settings (FR-ATT-094).
- [ ] Out-of-band operator-purge path produces an equivalent audit + manifest output to the standard purge path (FR-ATT-095).

**Negative tests / non-commitments**
- [ ] Native FTS NOT implemented (verifies the roadmap statement) (FR-ATT-070).
- [ ] No specific DMS connector code in the SaaSLogic codebase — confirms the Apptorflow-mediated boundary (§7).
- [ ] No two-way DMS sync; edits made in SharePoint don't appear in SaaSLogic (§7).

Sign-off: backend lead + frontend lead + security review + Apptorflow integration lead + proposal owner.
