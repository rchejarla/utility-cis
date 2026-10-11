# Bill Production — Design

**Date:** 2026-10-11
**Status:** Design, awaiting review
**Closes:** Bozeman #130 (PDF generation + retained bill images), #137 (bill message management). Partially #133: a bill can be printed again, but *version tracking* is deferred with corrected issuance — see §4.3. Makes #132 (paperless enrollment) meaningful.
**Module specs touched:** `docs/specs/09-billing.md`, `docs/specs/18-theme-and-configuration.md`

## 1. Intent

Bills compute today and stop there. `Bill`, `BillSegment` and `BillSegmentLine` are live and rated against Bozeman's real tariffs, AR posting moves `Account.balance`, and the portal shows a bill *summary* — but nothing in the system ever produces a bill document. A utility billing system that cannot render a bill is the most conspicuous gap in `docs/bozeman/17-implementation-gap-analysis.md`.

This slice makes a bill into a durable, itemised PDF that staff and customers can download, and that can be reprinted as a new version without destroying the original.

**Success criteria.** An operator can open a posted bill, download a PDF carrying the tenant's branding and issuer identity, with every charge line traceable to what produced it; a supervisor can reprint a corrected version and still retrieve the superseded one; a tenant can manage the messages that appear on bills.

## 2. Scope

**In:** the resolved bill presentation; a PDF renderer; `BillDocument` as the stored artifact; `BillMessage` with targeting; issuer identity; download endpoints for admin and portal; a bill-messages settings page.

**Out, with reasons:**

| Deferred | Why |
|---|---|
| Print-and-mail vendor export (#131) | Its file format should be designed against a real vendor specification, not guessed. Additive once that spec exists: a second renderer over the same presentation model, delivered to the vendor over apptor-connect's SFTP or object-store integration. |
| Email / paperless delivery (#132) | Needs a delivery-status model, and the tenant's mail integration configured in apptor-connect (`mail` or `sendgrid`, called through the proxy plane). This slice makes `Account.paperlessBilling` meaningful by producing the artifact there is currently nothing to deliver. |
| **Layout design per utility (L3)** | **A confirmed product requirement, deliberately not now.** §5 states the seam it will target. Nothing in this slice may put layout decisions inside rendering machinery. |
| Bill holds (#136), rebill (#142, #103) | Separate requirements with their own semantics. Rebill in particular needs the correction chain from `docs/specs/09-billing.md` slice 5d. |
| **Bill versioning** (the version-tracking half of #133) | See §4.3. Nothing here produces a second version whose content differs, and nothing delivers a bill, so there is no sent copy to preserve. It arrives with whichever comes first: rebill, or delivery. |
| `Bill` status enum (`DRAFT`/`VOID`) | `docs/specs/09-billing.md:28` defers it until "rendering and delivery need them". Rendering does not: supersession is derivable from the reprint chain (§4.3). Delivery will need it; it can arrive then. |

## 3. What exists today

Grounded, because the module spec is partly stale:

- `Bill` — `billNumber`, `periodStart/End`, `billDate`, `dueDate`, `subtotal`, `taxes`, `credits`, `total`, `postedAt`. No version, no status, no document.
- `BillSegmentLine` — `label`, `kindCode`, `amount`, `quantity`, `sortOrder`, plus `sourceScheduleId` and `sourceComponentId`. Every line is already traceable to the rate schedule version and component that produced it, which is what #139 (itemisation) needs.
- `TenantTheme` — `logoUrl`, `colors`, `typography`, `preset`. Per-tenant branding, already used by the web UI.
- Attachment storage — local disk at `../../uploads`, flat filenames, with a traversal guard (`safeResolveStoragePath` in `packages/api/src/services/attachment.service.ts`). Bills deliberately do **not** follow this precedent; see §4.5. Migrating attachments onto the same rail is sensible later and is not this slice's job.
- **apptor-connect** (`c:\development\apptor-connect`) — the integration layer for this stack, with `apptor-connect-service` as its HTTP surface. Four planes: `resolve` (connection details plus a short-lived token), `proxy` (`POST /proxy/v1/{integration}` — it calls the vendor and the credential never reaches us), `files` (`/files/v1/*`, object stores and SFTP), and `events` (verified inbound webhooks, read by cursor). Its ownership hierarchy is `PLATFORM ⊃ TENANT ⊃ CUSTOMER ⊃ SUBJECT`, which maps onto `utility_id` cleanly. This is where email, SMS, object storage and other-application traffic belong — nothing in this codebase holds vendor credentials.
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
          apptor-connect files plane ──► tenant's object store (S3 / Azure Blob / GCS)
                      │
                      ▼
          BillDocument row — a pointer, never the bytes
```

### 4.1 Why a presentation model, and why that is not an abstraction layer

The project checklist is hostile to indirection added for future flexibility, so the justification has to be concrete and present-tense. `docs/specs/09-billing.md:95` already names three `document_type` values — `PDF`, `PRINT_EXPORT`, `EMAIL_HTML` — against requirements that exist now (#130, #131, #128/#129). Three renderings of one resolved bill is the direct design for three consumers, not speculative scaffolding.

The simpler alternative — one function that reads Prisma rows and draws a PDF — fails as soon as the vendor export arrives, because the export needs identical content resolution (charge grouping, message selection, proration labels) and would either duplicate it or re-read it differently. A resolved model read once is also what makes a bill reproducible: the same `BillPresentation` renders the same document.

`BillPresentation` holds no Prisma types. It is a plain structure: issuer, recipient, account reference, service period, charge groups (each with lines carrying label, quantity, amount and their source ids), totals, messages, remittance block, branding tokens.

### 4.2 Template separate from machinery

Per the standing rule that what an author writes never mixes with what happens at runtime, the declarative layout lives in `bill-template/` and the rendering machinery in `bill-generation/`. A template reads a `BillPresentation` and declares structure; machinery turns declarations into bytes, registers fonts, paginates and writes files. **This is the seam a future layout designer targets** — it edits templates, never machinery. Rendering code must contain no tenant conditionals; anything that varies per tenant arrives through `BillPresentation` or through the template chosen.

### 4.3 Reprinting, and why it creates no version

A reprint is "the customer lost their bill, print it again". Nothing about the document changed: bill messages resolve at `billDate` (§5) and the renderer is byte-stable (§4.4), so generating the same bill twice produces identical bytes. A second row recording that would be bookkeeping with no fact behind it.

An earlier draft gave `Bill` a `version` and a `replacesId`, chaining a new row per reprint. That attached version tracking to the wrong half of #133, which reads "bill reprints **and corrected bill issuance** with version tracking" — the tracking belongs to corrected issuance, whose content genuinely differs. Corrected issuance is a rebill, and rebill is out of scope.

The stronger reason it is premature: **nothing in this slice delivers a bill to anyone.** Email and print-vendor delivery are both deferred. Versioning exists to protect the record of what was *sent*, and until something sends there is no such record to protect — so overwriting a stored PDF today destroys nothing.

So `Bill` is untouched: no new columns, and `@@unique([utilityId, billNumber])` stays as it is. One `BillDocument` per bill per type, Regenerateable in place, idempotent through the deterministic key in §4.5. What stays answerable without a version chain is which layout produced the stored copy and whether it has changed, from `templateKey`, `sha256` and `generatedAt`.

Version tracking returns with whichever arrives first — rebill, or delivery. That is this project's own rule: add the indirection when the second consumer appears.

### 4.4 Rendering technology

`@react-pdf/renderer`. A utility bill is a fixed-geometry document produced in bulk — thousands per cycle — and this renders deterministically in pure Node with no browser binary, which keeps batch cost and image size down. Declarative templates also suit §4.2.

Rejected, with the trade-off that decided it:

- **HTML/CSS through headless Chrome** — the best eventual story for a designer that edits HTML with live preview, and print CSS handles envelope geometry well, but it puts ~300MB of Chromium in the API image and a browser process in the render path. Recorded as the upgrade: because the renderer sits behind `BillPresentation`, switching is a renderer swap, not a rewrite. **Trigger:** the City requires a pixel-exact match to an existing bill design, or the layout designer is specified as HTML editing.
- **pdfkit** — lightest, but layout becomes x/y coordinates in imperative code, which makes the confirmed layout-design requirement a rewrite. Rejected on that ground alone.

Fonts are registered explicitly and vendored, so rendering does not depend on host fonts and output stays identical across machines.

### 4.5 Storage — through apptor-connect

Bill PDFs are written to the tenant's object store (S3, Azure Blob or GCS) through **apptor-connect's files plane**, not to local disk. `c:\development\apptor-connect` is the integration layer for this stack, and `apptor-connect-service` is its HTTP surface.

The flow, per `POST /files/v1/links`:

1. Mint a link: `{ i: <integration>, cn: <connection?>, key: "bills/{utilityId}/{billId}.pdf", op: "PUT", maxBytes }`.
2. Stream the rendered bytes to the returned `url`.
3. Commit the `BillDocument` row holding the **pointer** — integration, connection, object key, sha256, byte size.

Reads mint the same link with `op: "GET"` and a short TTL.

Three consequences worth stating:

- **No storage abstraction in this codebase at all.** The earlier draft proposed a local-disk module and explicitly refused a driver interface as speculative. apptor-connect makes even that module unnecessary: one integration name selects S3, Azure or GCS per tenant, resolved from the tenant's own catalog entry. We write a pointer and a key; we own no storage code.
- **A capability link is a bearer credential.** The response says so plainly: the URL "needs no login… anyone holding it can use it until it expires." So bill bytes are **streamed through the API**, keeping authorization with our RBAC and the portal's customer scoping; links are minted with the shortest workable TTL and never put in a page, an email or a log. A redirect-to-link design would move authorization outside our control and make a forwarded link someone else's bill.
- **Bytes transit apptor-connect** (`via: "service"`, not a vendor presign), so its upload limit and timeouts apply. A bill PDF is small; `maxBytes` is set explicitly per upload so an unbounded render cannot stream indefinitely.

Writing to a deterministic key makes a Regenerate idempotent: it overwrites the same object with identical bytes. That depends on the renderer being byte-stable for a given `BillPresentation` — no wall-clock creation timestamp embedded in the PDF — which §4.4's vendored-font requirement already half-buys and which `sha256` verifies. This replaces the temp-file-and-rename dance a local filesystem would have needed.

Defensively, the key is prefixed with `utilityId` even though the integration's connection root is already per-tenant. If a deployment ever points two tenants at one bucket, the prefix is what keeps their bills apart.

## 5. Data model

**`BillDocument`** — the generated artifact.

| Field | Type | Notes |
|---|---|---|
| id | UUID | |
| utilityId | UUID | RLS tenant key |
| billId | UUID | FK → Bill, `onDelete: Restrict` |
| documentType | enum | `PDF` now; `PRINT_EXPORT`, `EMAIL_HTML` reserved for later slices |
| storageIntegration | VarChar(100) | apptor-connect integration name (`i`) that holds the object |
| storageConnection | VarChar(100)? | Named connection under it (`cn`); null for the usual one |
| objectKey | VarChar(500) | Key within the connection's root, as minted in §4.5 |
| byteSize | Int | |
| sha256 | Char(64) | Integrity, and makes a Regenerate detectable as identical |
| templateKey | VarChar(100) | Which template produced it — a reprint under a changed template is explainable |
| generatedAt | Timestamptz | |
| isPaperless | Boolean | Copy of `Account.paperlessBilling` at generation, per `docs/specs/09-billing.md:102` |

`@@unique([billId, documentType])` — one document per type per bill. Generating again replaces it in place; §4.3 says why no version sits alongside it.

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
| CRUD | `/api/v1/bill-messages` | Standard tenant CRUD via `crud-routes`. |
| GET | `/portal/api/bills/:id/document` | Portal download, scoped to the authenticated customer's accounts. |

A forced Regenerate sits behind a higher permission than a download, in the spirit of `docs/specs/09-billing.md:224` ("supervisor-only" for reprints): replacing a stored document is an elevated act even while nothing has been delivered.

## 7. Errors

- **Missing issuer identity** → `422` naming the missing fields and pointing at the settings page. A bill must never render with a blank issuer.
- **Unposted bill** → `409`. Only posted bills produce documents; `postedAt` is the gate.
- **Render failure** → no `BillDocument` row. Bytes are uploaded first and the row commits second, so a failure leaves at most an orphan object at a deterministic key, which the next render overwrites. An orphan object with no row is inert; a row pointing at nothing is not, which is why the order is that way round.
- **Concurrent render** → the unique constraint on `(billId, documentType)` decides the winner; the loser returns the existing document rather than erroring. Both wrote identical bytes to the same key, so neither can corrupt the other — this is what the byte-stability requirement in §4.5 buys.
- **Storage integration not configured for the tenant** → `422` naming the integration, in the same family as the missing-issuer error: a setup problem stated plainly, not a 500.
- **apptor-connect unreachable or the upload rejected** (`maxBytes` exceeded, link expired mid-stream) → `502` with the integration name, and no row. Rendering a bill is an operator action that can be retried; it must not half-succeed.
- **Missing object for an existing row** → `500` with the bill id, integration and key. That is a storage fault worth alerting on, not a 404.

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
- Idempotency: a second POST returns the same document and writes no second object.
- Reprint: creates `version = 2` with `replacesId` set, leaves version 1 retrievable, and does not write to the ledger.
- Tenant isolation: a document is invisible across tenants under RLS.
- Portal scoping: a customer cannot fetch a bill belonging to another customer's account.
- Issuer-identity 422 path, and the unconfigured-storage-integration 422 path.
- Upload failure (apptor-connect returning 5xx, or `maxBytes` exceeded) leaves no `BillDocument` row.

**apptor-connect is faked in tests, not run.** Integration tests already boot Postgres via testcontainers; standing up a JVM service and a cloud bucket per test file would multiply an already 20-minute suite for no additional coverage of our logic. The files plane is reached through one narrow client module, which tests substitute. What that costs is real — a fake cannot catch a drift in apptor-connect's contract — so the client module carries a contract test asserting the exact request shape documented in §4.5 (`i`, `cn`, `key`, `op`, `ttlSeconds`, `maxBytes`) and the response fields it reads (`url`, `method`, `expiresAt`, `maxBytes`). When that contract moves, one test fails and names it.

## 9. UI

- **Bills list** — a document column with a download action, and a reprint action behind the permission.
- **Account AR tab** — download alongside each bill, where staff already look.
- **Portal bills** — download on the existing bills page, replacing the summary-only view's dead end.
- **`/settings/bill-messages`** — CRUD with the targeting fields and a preview of where the message lands.
- **`/settings/general`** — the issuer identity fields, validated.

## 10. Risks

- **Durability — resolved, and worth noting why.** The earlier draft flagged local disk as unfit for the 7-year statutory floor in `docs/bozeman/08-data-retention-archival-purge.md`. Writing through apptor-connect to the tenant's object store answers it: the lifecycle tiering that doc designs (Standard → IA → Glacier) is a bucket policy, not something this codebase implements. What remains is a deployment prerequisite rather than a design risk — a tenant with no storage integration configured cannot produce bills, which §7 surfaces as a `422`.
- **A new dependency in the render path.** Bill production now cannot complete while apptor-connect is down, where a local write would have succeeded. That is the right trade for durability and single-sourced credentials, but it is a real coupling: rendering is an interactive operator action, so the failure is visible and retryable rather than silent. Batch rendering, when it arrives, needs that failure to be per-bill resumable.
- **Capability links are bearer credentials.** §4.5 streams bytes through the API precisely so a link never reaches a browser, an email or a log. The risk is that a later slice — portal download, or emailing a bill — takes the shortcut of handing the link out. A forwarded or logged link is someone else's bill until it expires.
- **Printing again is not correcting.** It does not touch money. Until rebill ships, a bill that is *wrong* has no clean path, and operators may reach for reprint expecting one. The UI should say so plainly.
- **A forced Regenerate replaces the stored document.** With no versioning (§4.3), `?force=true` overwrites. Harmless while nothing is delivered, and a real hazard the moment delivery ships — which is exactly when versioning should return. `sha256` and `generatedAt` make the replacement detectable after the fact.
- **Template churn before the designer exists.** Layout changes are code changes until L3. `templateKey` on `BillDocument` at least makes it answerable which layout produced a given document.
