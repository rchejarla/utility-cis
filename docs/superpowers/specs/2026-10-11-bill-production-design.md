# Bill Production — Design

**Date:** 2026-10-11
**Status:** Design, awaiting review
**Closes:** Bozeman #130 (PDF generation + retained bill images), #133 (reprints with version tracking), #137 (bill message management). Makes #132 (paperless enrollment) meaningful.
**Module specs touched:** `docs/specs/09-billing.md`, `docs/specs/18-theme-and-configuration.md`

## 1. Intent

Bills compute today and stop there. `Bill`, `BillSegment` and `BillSegmentLine` are live and rated against Bozeman's real tariffs, AR posting moves `Account.balance`, and the portal shows a bill *summary* — but nothing in the system ever produces a bill document. A utility billing system that cannot render a bill is the most conspicuous gap in `docs/bozeman/17-implementation-gap-analysis.md`.

This slice makes a bill into a durable, itemised PDF that staff and customers can download, and that can be reprinted as a new version without destroying the original.

**Success criteria.** An operator can open a posted bill, download a PDF carrying the tenant's branding and issuer identity, with every charge line traceable to what produced it; a supervisor can reprint a corrected version and still retrieve the superseded one; a tenant can manage the messages that appear on bills.

## 2. Scope

**In:** the resolved bill presentation; a PDF renderer; `BillDocument` as the stored artifact; reprint versioning on `Bill`; `BillMessage` with targeting; issuer identity; download endpoints for admin and portal; a bill-messages settings page.

**Out, with reasons:**

| Deferred | Why |
|---|---|
| Print-and-mail vendor export (#131) | Its file format should be designed against a real vendor specification, not guessed. Additive once that spec exists — it is a second renderer over the same presentation model. |
| Email / paperless delivery (#132) | Needs the notification channel work and a delivery-status model. This slice makes `Account.paperlessBilling` meaningful by producing the artifact there is currently nothing to deliver. |
| **Layout design per utility (L3)** | **A confirmed product requirement, deliberately not now.** §5 states the seam it will target. Nothing in this slice may put layout decisions inside rendering machinery. |
| Bill holds (#136), rebill (#142, #103) | Separate requirements with their own semantics. Rebill in particular needs the correction chain from `docs/specs/09-billing.md` slice 5d. |
| `Bill` status enum (`DRAFT`/`VOID`) | `docs/specs/09-billing.md:28` defers it until "rendering and delivery need them". Rendering does not: supersession is derivable from the reprint chain (§4.3). Delivery will need it; it can arrive then. |

## 3. What exists today

Grounded, because the module spec is partly stale:

- `Bill` — `billNumber`, `periodStart/End`, `billDate`, `dueDate`, `subtotal`, `taxes`, `credits`, `total`, `postedAt`. No version, no status, no document.
- `BillSegmentLine` — `label`, `kindCode`, `amount`, `quantity`, `sortOrder`, plus `sourceScheduleId` and `sourceComponentId`. Every line is already traceable to the rate schedule version and component that produced it, which is what #139 (itemisation) needs.
- `TenantTheme` — `logoUrl`, `colors`, `typography`, `preset`. Per-tenant branding, already used by the web UI.
- Attachment storage — local disk at `../../uploads`, flat filenames, with a traversal guard (`safeResolveStoragePath` in `packages/api/src/services/attachment.service.ts`).
- `docs/specs/09-billing.md` designs this feature against a `BillingRecord` entity that was **superseded by `Bill`**. Its field list is the right intent on the wrong entity; this design maps it onto `Bill`.

### 3.1 The prerequisite nobody has

There is **no `Utility` model** and no issuer identity in the schema: no utility legal name, no remittance address, no billing phone number. Multi-tenancy is `utility_id` plus RLS, and the tenant has no row describing itself.

Every bill must say who issued it and where to send payment. This slice adds that, and it is a hard prerequisite — not a nicety.

## 4. Architecture

```
Bill + segments + lines + Account + Customer
  + TenantTheme + issuer identity + BillMessage
        │
        ▼
  BillPresentationLoader ──────► BillPresentation   (resolved, render-ready, no DB types)
                                      │
                      ┌───────────────┼────────────────┐
                      ▼               ▼                ▼
               BillPdfRenderer   (slice 2)        (slice 3)
                      │          export writer    html renderer
                      ▼
               BillDocument row + file on disk
```

### 4.1 Why a presentation model, and why that is not an abstraction layer

The project checklist is hostile to indirection added for future flexibility, so the justification has to be concrete and present-tense. `docs/specs/09-billing.md:95` already names three `document_type` values — `PDF`, `PRINT_EXPORT`, `EMAIL_HTML` — against requirements that exist now (#130, #131, #128/#129). Three renderings of one resolved bill is the direct design for three consumers, not speculative scaffolding.

The simpler alternative — one function that reads Prisma rows and draws a PDF — fails as soon as the vendor export arrives, because the export needs identical content resolution (charge grouping, message selection, proration labels) and would either duplicate it or re-read it differently. A resolved model read once is also what makes a bill reproducible: the same `BillPresentation` renders the same document.

`BillPresentation` holds no Prisma types. It is a plain structure: issuer, recipient, account reference, service period, charge groups (each with lines carrying label, quantity, amount and their source ids), totals, messages, remittance block, branding tokens.

### 4.2 Template separate from machinery

Per the standing rule that what an author writes never mixes with what happens at runtime, the declarative layout lives in `bill-template/` and the rendering machinery in `bill-render/`. A template reads a `BillPresentation` and declares structure; machinery turns declarations into bytes, registers fonts, paginates and writes files. **This is the seam a future layout designer targets** — it edits templates, never machinery. Rendering code must contain no tenant conditionals; anything that varies per tenant arrives through `BillPresentation` or through the template chosen.

### 4.3 Reprint versioning

`Bill` gains `version Int @default(1)` and `replacesId String?` (nullable self-reference), matching `docs/specs/09-billing.md:58-59`.

A reprint creates a **new `Bill` row**: same `billNumber`, `version = previous.version + 1`, `replacesId = previous.id`, recomputed from its segments. The original is retained unchanged for audit. The existing unique constraint `@@unique([utilityId, billNumber])` becomes `@@unique([utilityId, billNumber, version])`.

Supersession is derived, not stored: a bill is superseded when another bill points at it through `replacesId`. One fact, one place — a stored flag would be a second copy free to disagree with the chain.

Reprints do not touch the ledger. A corrected bill that changes what is owed is a rebill, which is out of scope here; a reprint re-renders what the bill already says.

### 4.4 Rendering technology

`@react-pdf/renderer`. A utility bill is a fixed-geometry document produced in bulk — thousands per cycle — and this renders deterministically in pure Node with no browser binary, which keeps batch cost and image size down. Declarative templates also suit §4.2.

Rejected, with the trade-off that decided it:

- **HTML/CSS through headless Chrome** — the best eventual story for a designer that edits HTML with live preview, and print CSS handles envelope geometry well, but it puts ~300MB of Chromium in the API image and a browser process in the render path. Recorded as the upgrade: because the renderer sits behind `BillPresentation`, switching is a renderer swap, not a rewrite. **Trigger:** the City requires a pixel-exact match to an existing bill design, or the layout designer is specified as HTML editing.
- **pdfkit** — lightest, but layout becomes x/y coordinates in imperative code, which makes the confirmed layout-design requirement a rewrite. Rejected on that ground alone.

Fonts are registered explicitly and vendored, so rendering does not depend on host fonts and output stays identical across machines.

### 4.5 Storage

A `bill-document-store` module with `writeBillDocument` / `readBillDocument`, writing to local disk under the existing uploads root, reusing the traversal-guard approach already proven in `attachment.service.ts`.

Explicitly **not** a storage interface with swappable drivers: that is the speculative layer the checklist warns about. One module, two functions, so that when durability is addressed there is a single place to change.

Filenames are derived, never supplied: `{billId}-v{version}.pdf` under a per-tenant subdirectory, so documents cannot collide across tenants and no path component comes from user input. Integrity is carried by `BillDocument.sha256` rather than by the name.

A render writes to a unique temporary file and renames it into place **only after** the `BillDocument` row commits. Rename-after-commit is what makes §7's concurrency and failure rules safe: a render that loses the race deletes its own temporary file and never touches the winner's.

## 5. Data model

**`BillDocument`** — the rendered artifact.

| Field | Type | Notes |
|---|---|---|
| id | UUID | |
| utilityId | UUID | RLS tenant key |
| billId | UUID | FK → Bill, `onDelete: Restrict` |
| documentType | enum | `PDF` now; `PRINT_EXPORT`, `EMAIL_HTML` reserved for later slices |
| storagePath | VarChar(500) | Filename only, resolved through the store |
| byteSize | Int | |
| sha256 | Char(64) | Integrity, and makes a re-render detectable as identical |
| templateKey | VarChar(100) | Which template produced it — a reprint under a changed template is explainable |
| generatedAt | Timestamptz | |
| isPaperless | Boolean | Copy of `Account.paperlessBilling` at generation, per `docs/specs/09-billing.md:102` |

`@@unique([billId, documentType])` — one current document per type per bill version. Because a reprint is a new `Bill` row, version history falls out of the bill chain rather than needing document versions.

**`BillMessage`** — configurable text on bills (#137).

| Field | Type | Notes |
|---|---|---|
| id, utilityId | UUID | |
| label | VarChar(255) | Operator-facing name |
| body | Text | The printed text |
| accountTypeDefId | UUID? | Null = all account types |
| commodityId | UUID? | Null = all services |
| priority | Int | Ascending print order |
| activeFrom / activeTo | Date / Date? | Null `activeTo` = open-ended |

Selection at render: messages whose targeting matches the bill's account type and any commodity on the bill (or is null), and whose active window contains `bill.billDate` — **not** `now()`, so a reprint of an old bill reproduces the messages it carried.

**`TenantConfig`** gains issuer identity: `utilityName`, `utilityLegalName`, `remittanceAddressLine1/2`, `remittanceCity`, `remittanceState`, `remittancePostalCode`, `billingPhone`, `billingEmail`, `websiteUrl`.

Explicit columns rather than the existing `settings` JSON, because these are required for a bill to be valid and belong where the settings UI can validate them. A separate `TenantIdentity` table was considered and rejected: it would need its own CRUD and page to hold nine fields that are already per-tenant configuration.

## 6. API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/bills/:id/document` | Render and store. Idempotent: returns the existing document unless `?force=true`. |
| GET | `/api/v1/bills/:id/document` | Stream the PDF. 404 if never rendered. |
| GET | `/api/v1/bills/:id/versions` | The reprint chain, newest first. |
| POST | `/api/v1/bills/:id/reprint` | New version + render. Requires `bills.REPRINT`. |
| CRUD | `/api/v1/bill-messages` | Standard tenant CRUD via `crud-routes`. |
| GET | `/portal/api/bills/:id/document` | Portal download, scoped to the authenticated customer's accounts. |

Reprint sits behind its own permission rather than `bills.EDIT`, per `docs/specs/09-billing.md:224` ("supervisor-only").

## 7. Errors

- **Missing issuer identity** → `422` naming the missing fields and pointing at the settings page. A bill must never render with a blank issuer.
- **Unposted bill** → `409`. Only posted bills produce documents; `postedAt` is the gate.
- **Render failure** → no `BillDocument` row and no orphan file. Bytes go to a temporary file, the row commits, then the file is renamed into place; any failure before the rename deletes only that temporary file.
- **Concurrent render** → the unique constraint on `(billId, documentType)` decides the winner. The loser discards its temporary file and returns the existing document rather than erroring. Because the rename happens after the row commits, the loser can never overwrite or delete the winner's file — the two never share a path until one has won.
- **Missing file for an existing row** → `500` with the bill id and storage path, because that is a storage fault worth alerting on, not a 404.

## 8. Testing

Unit, where the logic is:

- `BillPresentationLoader` — charge grouping and ordering; totals reconcile to `Bill.subtotal`/`taxes`/`credits`/`total`; message selection by account type, commodity, and the active window evaluated at `billDate`; issuer identity resolution; theme fallback when `TenantTheme` is absent.
- `BillMessage` targeting — a matrix over (account type, commodity, window) including the null-means-all cases.

Renderer, as a smoke test rather than a pixel golden:

- Produces a valid PDF (`%PDF` header, non-zero length, expected page count).
- Asserts extracted text contains the issuer name, bill number, every charge label, and the total.
- No image-diff goldens: they fail on font and platform drift and teach nothing.

Integration (testcontainers, `*.integration.test.ts`):

- Render → download round-trip returns the stored bytes.
- Idempotency: a second POST returns the same document and writes no second file.
- Reprint: creates `version = 2` with `replacesId` set, leaves version 1 retrievable, and does not write to the ledger.
- Tenant isolation: a document is invisible across tenants under RLS.
- Portal scoping: a customer cannot fetch a bill belonging to another customer's account.
- Issuer-identity 422 path.

## 9. UI

- **Bills list** — a document column with a download action, and a reprint action behind the permission.
- **Account AR tab** — download alongside each bill, where staff already look.
- **Portal bills** — download on the existing bills page, replacing the summary-only view's dead end.
- **`/settings/bill-messages`** — CRUD with the targeting fields and a preview of where the message lands.
- **`/settings/general`** — the issuer identity fields, validated.

## 10. Risks

- **Durability.** Local disk is not a records-retention answer, and `docs/bozeman/08-data-retention-archival-purge.md` sets a 7-year statutory floor for financial records. This slice does not solve it; §4.5 keeps it to one module so that it can be solved once, deliberately, rather than being pre-solved here with infrastructure nobody asked for.
- **Reprint without rebill.** A reprint re-renders; it does not correct money. Until rebill ships, a bill that is *wrong* has no clean path, and operators may reach for reprint expecting one. The reprint UI should say so plainly.
- **Template churn before the designer exists.** Layout changes are code changes until L3. `templateKey` on `BillDocument` at least makes it answerable which layout produced a given document.
