# 10 — Draft Status & Posting

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (per-entity draft tables + draft-collaborator junction), `packages/api/src/services/draft/*` (channel-agnostic draft engine), `packages/api/src/lib/draft-aware.ts` (query helpers that exclude drafts from production reads), and `packages/web/components/draft/*` (autosave UI, draft-list views, post-confirmation dialogs). Cross-cuts with [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (post events emit audit rows; **drafts themselves are not full audit-trailed** — see §3.6), [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) (the staged-but-uncommitted phase of an import IS a kind of draft and uses the same primitives), and [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 / [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 (the `pending_administrative_change` table — distinct from drafts; see §2.4).
**Status:** Drafted — minimal implementation. **No entity in the schema has an explicit `DRAFT` status.** Two pre-active states exist (`ServiceAgreement.PENDING`, `ServiceSuspension.PENDING`) but they are operational lifecycle states, not user work-in-progress. There is no client-side autosave anywhere in `packages/web/`. `createdBy` columns exist on several entities but are never filtered for visibility scoping. No optimistic locking, version tracking, or co-edit conflict detection. The Adjustment entity (which the RFP names explicitly) **does not exist in the schema** — Module 10 (Payments & Collections) is a Phase 3 stub.
**Effort estimate:** L (~10-12 weeks engineering). Implementing drafts well is harder than it looks. The largest cost is **getting the visibility model right** — drafts must be scoped to the originator + named collaborators, must integrate with RLS without weakening tenant isolation, and must NOT leak into production listings, reports, schedulers, or dependent calculations. Second-largest cost is **autosave with conflict resolution** for collaborative editing. Third is **per-entity post pipelines** that promote a draft into a real entity row with all the side effects (audit, notifications, dependent inserts) the post would normally trigger.

---

## 1. RFP commitment (verbatim)

> Adjustments, service requests, billing-cycle parameters, rate changes, and most other entities support draft status. Drafts persist across sessions, are visible only to the originator (or by role configuration), can be co-edited by authorized users, and are excluded from production-impacting operations until explicitly posted.

The commitment decomposes into **six guarantees**:

1. **Multi-entity coverage** — explicitly named: adjustments, service requests, billing-cycle parameters, rate changes; plus "most other entities" as a soft commitment.
2. **Persistence across sessions** — close the browser, come back tomorrow, the draft is still there exactly as left.
3. **Originator-only visibility by default** — drafts don't show up in cross-tenant or even cross-user queries unless explicitly shared.
4. **Role-configurable visibility** — admins / team leads can be given visibility into their reports' drafts.
5. **Co-editing by authorized users** — multiple authorized users can edit the same draft (with conflict handling).
6. **Excluded from production operations** — drafts must not be picked up by schedulers, reports, list endpoints, downstream calculations, or notifications until explicitly posted.

This doc defines the **draft engine** as a generalized substrate, not as eight separate per-entity implementations. The engine is the pattern; per-entity adoption is described in §3.10.

---

## 2. Current state — what exists today

### 2.1 No entity has an explicit `DRAFT` status

**Status: Not implemented.** A grep across `schema.prisma` for `DRAFT` returns zero matches. The closest pre-active states:

| Entity | Pre-active state | What it actually is | Is it a draft? |
|---|---|---|---|
| `ServiceAgreement` | `PENDING` (`schema.prisma:81-86`) | New SA awaiting first-bill activation | No — it's already a real SA, dependent on a real account/premise/meter; just hasn't kicked off billing yet |
| `ServiceSuspension` | `PENDING` (`schema.prisma:845-850`) | Hold awaiting `requireHoldApproval` review | No — operational approval state, not editable WIP |
| `ServiceRequest` | `NEW` (`schema.prisma:1188-1196`) | Freshly created, unassigned | No — it's a real SR; visible to the dispatcher; SLA clock starts |
| `Meter` | `PENDING_INSTALL` (`schema.prisma:42-49`) | Inventoried but not deployed | No — physical state, not editable WIP |
| `ImportBatch` | `PENDING` (`schema.prisma:1024-1029`) | Batch uploaded, not yet processed | No — operational queue state |
| `Notification` | `PENDING` | Queued, not yet sent | No — operational queue state |
| `DelinquencyAction` | `PENDING` | Triggered, awaiting completion | No — operational state |

None of these support: hide-from-other-users until posted, edit-and-save-without-committing, multiple authors editing the same record, or the explicit "post to make it real" verb. They are all already-real entities in operational pre-active states.

### 2.2 No autosave or persistence-of-WIP in the web app

**Status: Not implemented.**

A grep for `autosave`, `auto-save`, `useDraft`, `useAutosave`, `localStorage.setItem.*draft`, `onBlur.*save` across `packages/web/` returns nothing relevant. The settings/retention page uses local state called `draft` (`packages/web/app/settings/retention/page.tsx`) but it's React in-memory state — refresh the page, it's gone. The web app's only `localStorage` usage is for the auth token, the user object, the portal session, and the sidebar collapse state.

When an operator starts filling in a service-request form and refreshes the browser by accident, **everything is lost.**

### 2.3 No visibility scoping by originator

**Status: Not implemented.**

Several entities carry `createdBy` columns:

- `ServiceRequest.createdBy` (`schema.prisma:1309`)
- `ImportBatch.createdBy` (`schema.prisma:1042`)
- `Attachment.uploadedBy` (`schema.prisma:677`)
- `RetentionPolicy.createdBy` (proposed in [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md))

None of them are filtered against the current user in any list endpoint. Search for `createdBy` in `service-request.service.ts:listServiceRequests` (lines 58-101) — the function filters by status, type, priority, account, premise, assigned-to, but NOT by createdBy. Any user with `service_requests:read` permission sees every SR in the tenant.

Postgres RLS in this codebase is **tenant-scoped only**: it filters by `utility_id = current_setting('app.current_utility_id')`. There is no per-user RLS policy anywhere.

### 2.4 No optimistic locking, no version columns, no co-edit conflict detection

**Status: Not implemented.**

A grep for `version`, `lockVersion`, `updatedBy`, `etag` across the schema:

- `RateSchedule.version` (`schema.prisma:431`) — domain version for rate changes (v1, v2 of a rate code), not optimistic locking
- `ServiceRequestCounter.nextValue` — counter only

No business entity has an `updatedBy`, `updateVersion`, `lockVersion`, or `etag`. Two operators editing the same `ServiceRequest` at the same time produces last-write-wins silently — no warning, no merge, no rejection.

### 2.5 The Adjustment entity, which the RFP names explicitly, does not exist

**Status: Not implemented.**

There is no `Adjustment` model in `schema.prisma`. There is no `packages/api/src/services/adjustment.service.ts`. There is no `packages/api/src/routes/adjustments.ts`. [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) is a stub stating "Module 10 — Status: Stub (Phase 3)."

The closest related entity is `DelinquencyAction`, which represents triggered collections actions, not user-initiated charge corrections.

### 2.6 BillingCycle has no draft / versioning concept

**Status: Not implemented.** `BillingCycle` (`schema.prisma:446-462`) has:

- `name`, `cycleCode`, `readDayOfMonth`, `billDayOfMonth`, `frequency`
- `active: Boolean @default(true)` — on/off only

No version chain, no pending-config table, no draft. CRUD endpoints save changes immediately. An operator changing `billDayOfMonth` mid-month directly affects the next billing run.

### 2.7 RateSchedule supports future-dated changes, but not drafts

**Status: Partial.** `RateSchedule.effectiveDate` and `expirationDate` (`schema.prisma:425-426`) allow a rate to be created today with `effectiveDate = 2027-07-01` — it lives in the table but doesn't apply to consumption calculations until July. The `revise` endpoint chains versions via `supersedes_id`.

But:
- The future-dated rate is **immediately visible** to all rate-management operators. Not a draft.
- The future-dated rate **cannot be edited in place** — to change it, you create another version that supersedes it. Three drafts of the same rate produce three permanent rows in the rate history, polluting the version chain.
- There is no "preview the customer impact of this rate change before committing" flow.

### 2.8 Service Request: NEW is live, not draft

**Status: Not implemented.** Per [docs/specs/14-service-requests.md](../specs/14-service-requests.md), the SR state machine is `NEW → ASSIGNED → IN_PROGRESS → PENDING_FIELD → COMPLETED|FAILED|CANCELLED`. `NEW` is the entry state for a real SR — it's visible to the dispatcher, the SLA clock has started, the customer has notification expectations. There is no pre-NEW draft phase.

### 2.9 The `pending_administrative_change` table is a different concept

**Status: Proposed in docs 01 and 08, not yet built.** The pattern from [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 (renamed and generalized in [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3) is for **two-person approval gates** on destructive or sensitive operations: purges, role edits, MFA changes. It is **not a draft workflow**.

| Aspect | `pending_administrative_change` | Draft workflow (this doc) |
|---|---|---|
| Author count | One requester, one+ approvers | One originator + collaborators, all peers |
| Editability | Snapshot at request time; approver sees-and-approves the snapshot | Continuously editable until posted |
| Visibility | Visible to all admins with the relevant permission (so they can approve) | Visible only to originator + named collaborators |
| Lifecycle | PENDING → APPROVED → EXECUTED (or REJECTED/EXPIRED) | DRAFT → POSTED (or DISCARDED) |
| Persistence | Short-lived (30-day TTL) | Long-lived (operator decides) |
| Purpose | Compliance gate on destructive ops | Save-WIP convenience for normal operational entries |

The two patterns coexist: a draft adjustment, when posted, MAY trigger a `pending_administrative_change` if the policy requires dual approval (e.g., adjustment > $X). They are layered, not the same.

### 2.10 Bulk import staging is the closest existing primitive

**Status: Designed in [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) but not yet built.** The "stage → commit" phase of doc 09 is a kind of draft: rows are validated, held in a staging area, and committed only on operator approval. This doc reuses some of doc 09's primitives — see §3.4 — but extends them to per-entity user-WIP semantics.

### Summary

| Guarantee | Today |
|---|---|
| Adjustments support draft | ✗ (entity doesn't exist) |
| SRs support draft | ✗ (NEW is live) |
| Billing-cycle parameters support draft | ✗ |
| Rate changes support draft | ⚠ (future-dated effectiveDate works; no editable draft) |
| Most other entities support draft | ✗ |
| Drafts persist across sessions | ✗ |
| Visible to originator only | ✗ |
| Role-configurable visibility | ✗ |
| Co-editing by authorized users | ✗ |
| Excluded from production operations until posted | ✗ |

---

## 3. Functional requirements

### 3.1 Draft engine — channel-agnostic substrate

The system MUST converge per-entity draft support onto a single engine. Each entity that adopts draft support registers an `EntityDraftSpec` once; the engine handles persistence, visibility, autosave, locking, and the post pipeline.

#### 3.1.1 Storage model

- **FR-DRAFT-001** — Every entity that adopts draft support gets a paired `<entity>_draft` table that mirrors the production entity's columns plus draft-specific metadata. The draft table is **separate** from the production table — drafts and posted entities never share rows. Reasoning:
  - Drafts often have nullable fields that are NOT NULL in production (a half-filled draft is normal; a half-filled production row is a bug).
  - Drafts skip foreign-key constraints to entities that may not exist yet (e.g., an adjustment draft can reference a customer who's also a draft).
  - Drafts must not appear in production list/search/report queries even by accident — physical separation is the strongest guarantee.
  - Draft columns can evolve (add new helper fields like `lastSavedAt`, `lastSavedField`, `inProgressBy`) without polluting the production schema.
  - **Acceptance:** `ServiceRequestDraft`, `AdjustmentDraft`, `BillingCycleDraft`, `RateScheduleDraft` etc. exist as separate tables. `ServiceRequest` (production) has no `isDraft` boolean.

- **FR-DRAFT-002** — Draft tables share a common base set of columns enforced via a Prisma mixin (or per-table convention with linter check):

  ```prisma
  model XxxDraft {
    id              String          @id @default(uuid()) @db.Uuid
    utilityId       String          @map("utility_id") @db.Uuid
    originatorId    String          @map("originator_id") @db.Uuid       // who created the draft
    title           String?         // user-given label, e.g., "Q3 rate revision"
    payload         Json            // the entity's editable fields
    payloadVersion  Int             @default(1) @map("payload_version")  // optimistic-lock counter
    lastSavedAt     DateTime        @default(now()) @map("last_saved_at") @db.Timestamptz
    lastSavedBy     String          @map("last_saved_by") @db.Uuid
    autosaveSeq     BigInt          @default(0) @map("autosave_seq")     // monotonic per-draft counter for autosave events
    status          DraftStatus     @default(DRAFT)
    visibility      DraftVisibility @default(ORIGINATOR_ONLY)
    postedAt        DateTime?       @map("posted_at") @db.Timestamptz
    postedBy        String?         @map("posted_by") @db.Uuid
    postedAsId      String?         @map("posted_as_id") @db.Uuid       // FK to the posted production entity
    discardedAt     DateTime?       @map("discarded_at") @db.Timestamptz
    discardedBy     String?         @map("discarded_by") @db.Uuid
    expiresAt       DateTime?       @map("expires_at") @db.Timestamptz   // auto-discard at this date if not posted
    @@index([utilityId, originatorId, status])
    @@index([utilityId, status, lastSavedAt])
  }

  enum DraftStatus {
    DRAFT
    POSTING
    POSTED
    DISCARDED
    EXPIRED
  }

  enum DraftVisibility {
    ORIGINATOR_ONLY
    SHARED_WITH_NAMED_USERS
    SHARED_WITH_ROLE
    TENANT_WIDE
  }
  ```

  The `payload` JSON column is the structured editable state. Per-entity, a Zod schema validates `payload`. The validation runs at autosave time (warnings only — drafts can be invalid) and at post time (errors block — invalid drafts can't post).

- **FR-DRAFT-003** — A common `draft_collaborator` junction table covers cross-entity collaboration:

  ```prisma
  model DraftCollaborator {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    draftType   String   @map("draft_type") @db.VarChar(64)  // "service_request_draft" | "adjustment_draft" | ...
    draftId     String   @map("draft_id") @db.Uuid
    userId      String   @map("user_id") @db.Uuid
    role        String   @db.VarChar(32)  // "viewer" | "editor"
    addedBy     String   @map("added_by") @db.Uuid
    addedAt     DateTime @default(now()) @map("added_at") @db.Timestamptz
    @@unique([utilityId, draftType, draftId, userId])
    @@index([utilityId, userId, draftType])
    @@map("draft_collaborator")
  }
  ```

#### 3.1.2 Visibility model

- **FR-DRAFT-010** — Default visibility for every new draft is `ORIGINATOR_ONLY`. The originator MAY change it to one of:
  - `ORIGINATOR_ONLY` (default) — only the originator sees and edits.
  - `SHARED_WITH_NAMED_USERS` — visible to originator + each user in `draft_collaborator`. Editors edit; viewers see read-only.
  - `SHARED_WITH_ROLE` — visible to all users in the tenant who hold a configured role (e.g., "rate-management-team-lead"). The role itself is set per draft.
  - `TENANT_WIDE` — visible to all users with the relevant module read permission. (Rare; used for organization-wide proposals.)

- **FR-DRAFT-011** — Visibility enforcement happens at the query layer in two complementary ways:
  1. **Postgres RLS policy** (defense in depth): a per-table policy that filters draft tables by `(utility_id = current_setting('app.current_utility_id') AND ...)` where the rest of the predicate covers the visibility cases above. The application sets a session local `app.current_user_id` per request. RLS uses both. **Reasoning:** RLS is the strongest guarantee — even a buggy service-layer query cannot leak drafts.
  2. **Service-layer helpers** (`packages/api/src/lib/draft-visibility.ts`): a `withDraftVisibility(query, ctx)` helper that injects the visibility predicate into application queries. Used everywhere drafts are queried. Service-layer enforcement gives clearer errors and skips the RLS roundtrip in some cases (e.g., when the originator is querying their own drafts, which is the dominant case).
  - **Acceptance:** Direct psql query as `app_user` role with `app.current_utility_id` and `app.current_user_id` set returns zero draft rows when the user is neither originator nor collaborator nor role-member nor tenant-admin (when visibility is TENANT_WIDE). Test passes against every draft table.

- **FR-DRAFT-012** — Visibility changes (e.g., originator opens up a draft from ORIGINATOR_ONLY to SHARED_WITH_NAMED_USERS) emit a single audit row of class `AUDIT_OPERATIONAL` with `before_state` + `after_state` + the new collaborator list. Per-edit autosaves do NOT emit audit rows (would explode volume — see §3.6).

- **FR-DRAFT-013** — A user MAY have two roles relevant to drafts:
  - `drafts.read_subordinate` — sees drafts created by users they manage (per the org-hierarchy table — out of scope for this doc; the role infrastructure exists, see [docs/specs/18-theme-and-configuration.md](../specs/18-theme-and-configuration.md))
  - `drafts.read_team` — sees all drafts in their team
  These are tenant-configurable extensions of the visibility model.

#### 3.1.3 Autosave + persistence

- **FR-DRAFT-020** — All draft-supporting forms in the web app implement **debounced autosave** with the following contract:
  - Trigger: any field change OR every 30 seconds (whichever first), with a 2-second debounce window after the last keystroke.
  - Endpoint: `PATCH /api/v1/drafts/<draftType>/<draftId>` with `{ payload, payloadVersion }`. The endpoint is idempotent — same `payloadVersion` is a no-op.
  - Conflict response: HTTP 409 Conflict with the current server-side `payload` if the client's `payloadVersion` is older than the server's. The UI presents a merge dialog (FR-DRAFT-022).
  - Local fallback: if the network is unavailable, autosave writes to `IndexedDB` keyed by `(draftType, draftId, autosaveSeq)`. On reconnect, queued autosaves are flushed in order. (Same primitive as PWA offline queueing per [03-progressive-web-app.md](./03-progressive-web-app.md).)

- **FR-DRAFT-021** — Drafts persist server-side **indefinitely by default**, with a per-tenant `draft_max_age_days` (default 90). On `expiresAt` reached, the draft transitions to `EXPIRED` (not hard-deleted) and is hidden from default views. A weekly sweep prompts the originator: "Your draft 'Q3 rate revision' is 90 days old. Discard, extend, or post?"
  - Reasoning: an unbounded draft table is a quiet memory leak; users abandon drafts and forget about them. A reminder + soft-expire balances persistence with hygiene.
  - **Acceptance:** A draft `created_at` 90 days ago receives no further autosaves and shows up as EXPIRED. Originator sees "Restore" / "Discard" actions in the drafts list.

- **FR-DRAFT-022** — Co-edit conflict resolution: when two editors save concurrently, the second save returns `409 Conflict` with the current server payload. The UI shows a three-way merge:
  - Left pane: my version (the editor's local state)
  - Middle: the common ancestor (the version both editors started from — `payloadVersion` at the time the editor opened the draft)
  - Right: their version (server-side current state)
  - The editor accepts changes field-by-field and re-saves with the new merged payload + the latest `payloadVersion`.
  - For simple drafts (single-section forms), the merge can be auto-resolved if the conflicts are in disjoint fields. For complex drafts (rate schedules, customer mass-imports), automatic merge is disabled — operators see the three-way and resolve manually.

- **FR-DRAFT-023** — Drafts MAY be locked by a single editor in "exclusive editing mode" (optional opt-in). When locked:
  - Other editors see read-only with a banner "Editing locked by <user> until <expires>".
  - Lock expires automatically after 5 minutes of inactivity (autosave heartbeat).
  - Lock can be force-released by tenant admins or by the lock holder.
  - This is a UX convenience, not a requirement — drafts work fine without locking via the conflict-resolution path (FR-DRAFT-022).

- **FR-DRAFT-024** — The web app provides a unified `/drafts` page listing every draft visible to the current user across all entity types. Filterable by entity type, status, originator, last-saved date. Each draft links to its entity-specific edit form. This is the operator's "open work" inbox.

#### 3.1.4 Draft validation

- **FR-DRAFT-030** — Draft validation runs at three points:
  1. **Autosave time** — runs the entity's Zod schema with `.partial()` applied (per doc 07's Tier 1) plus any cross-field rules that apply to partial drafts. Errors surface as warnings on the form ("This will need to be filled in before you can post"). Drafts can be saved even with errors — a draft is allowed to be incomplete.
  2. **Post-attempt time** — runs the full schema (no `.partial()`) plus all four tiers from [07-data-validation.md](./07-data-validation.md). Errors block posting. UI shows the error list with inline navigation to each problem field.
  3. **Server-side post** — re-runs full validation server-side as a defense-in-depth check. Posting an invalid draft via the API directly is also rejected.

- **FR-DRAFT-031** — Drafts MAY reference draft dependencies. E.g., a draft `ServiceRequest` may reference a draft `Customer` that hasn't been posted yet. The post pipeline (FR-DRAFT-040) topologically sorts the dependency graph — posting the SR draft cascades into posting the Customer draft first if the operator opts in. If they don't opt in, posting the SR fails with a clear error: "This draft references draft Customer 'New Customer (Smith family)'. Post the Customer first or include it in this post."

### 3.2 Posting pipeline

- **FR-DRAFT-040** — The "post" verb is a single endpoint per draft type: `POST /api/v1/drafts/<draftType>/<draftId>/post`. The endpoint runs:
  1. Optimistic-lock check — `payloadVersion` from the request matches server-side current.
  2. Full validation (FR-DRAFT-030 step 2 + 3).
  3. Authorization: only originator OR a collaborator with `editor` role + `<entity>.post` permission may post. (Posting is a stronger right than editing.)
  4. Optional `pending_administrative_change` gate: if the entity's policy requires dual approval (e.g., adjustment > $1,000, rate schedule revision, billing-cycle parameter change), creates a row in `pending_administrative_change` with `operationType = "post_<draftType>"`. The post does NOT execute until two approvers approve. Draft transitions to `PENDING_APPROVAL` (a sub-state of `DRAFT` for this scenario).
  5. Transactional execution:
     - Insert the production row with the same `id` as the draft (so external references that grabbed the draft ID still resolve after post — see FR-DRAFT-042 caveat).
     - Update the draft to `POSTED` with `postedAt`, `postedBy`, `postedAsId = <production_id>`.
     - Emit per-entity audit row(s) for the production row (CREATE class).
     - Emit a `DRAFT_POSTED` audit row of class `AUDIT_OPERATIONAL` referencing both the draft and the production row.
     - Trigger entity-specific side effects (e.g., notification on SR post, recalc on rate-schedule post).

- **FR-DRAFT-041** — The post pipeline is **all-or-nothing transactionally**. A worker crash mid-post leaves the draft in `POSTING` state with `postingStartedAt` set; a separate sweeper resumes by checking whether the production row exists (idempotent forward-progress). If no production row, the draft is rolled back to `DRAFT`. If production row exists, the draft is moved to `POSTED`.

- **FR-DRAFT-042** — Posted drafts are NOT immediately deleted. They stay in their `<entity>_draft` table with `status = POSTED` for a configurable period (default 30 days) so operators can audit "what did I post yesterday?" After the retention period, they're moved to the archive (per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) `OPERATIONAL_LOG` retention class). The draft's `id` is preserved through the archive — looking up an old `id` returns either the production row (if `posted_as_id` matches) or the archive entry.

- **FR-DRAFT-043** — Post-cascade for dependent drafts (FR-DRAFT-031): when the operator opts to "Post all", the engine performs a topological sort of the dependency graph among visible drafts and posts in dependency order, all in a single outer transaction. If any post fails, the whole cascade rolls back.

- **FR-DRAFT-044** — A discard verb: `POST /api/v1/drafts/<draftType>/<draftId>/discard`. Marks the draft as `DISCARDED` with a reason. Discarded drafts are visible in the originator's "Discarded" tab for 30 days then archived. Discard does NOT trigger notifications or production-side effects.

### 3.3 Exclusion from production-impacting operations

- **FR-DRAFT-050** — Drafts MUST NEVER be returned by:
  - Production list/search endpoints. e.g., `GET /api/v1/service-requests` returns only `ServiceRequest` rows, never `ServiceRequestDraft` rows. Operators see drafts via dedicated `/drafts` endpoints.
  - Reports — any report query MUST hit production tables only.
  - Schedulers — the audit retention sweep, suspension scheduler, delinquency dispatcher, etc., never touch draft tables.
  - Notification triggers — drafting a service request does NOT notify the customer. Posting it does.
  - Billing calculations — a draft rate schedule does not affect any consumption calculation.
  - Custom-fields engine ([06-custom-fields.md](./06-custom-fields.md)) — draft entities do not appear in CSV exports, query-builder results, or the per-tenant OpenAPI variant.
  - Relationship integrity — production foreign keys point only to production rows. A `ServiceAgreement.customerId` cannot reference a `CustomerDraft.id`.

- **FR-DRAFT-051** — The `draft-aware.ts` helper has the inverse operation: `withProductionScope(query)` that explicitly opts into production-only data. Most service code uses this implicitly via the production table, but reports and schedulers MUST call it explicitly to make the intent visible. The linter rule `no-implicit-cross-table-query` flags any cross-entity join that doesn't go through `withProductionScope` or `withDraftVisibility`.

- **FR-DRAFT-052** — Counting and analytics: a tenant dashboard widget showing "Open service requests" MUST count production SRs only. A separate "Open work" widget shows draft counts visible to the current user. These are two different metrics.

### 3.4 Relationship to existing primitives

- **FR-DRAFT-060** — The bulk-import staging area from [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) FR-ING-003 is conceptually a kind of draft (validated rows held until commit) but is **not unified** with this engine. Reasoning: bulk-import drafts are row-level (thousands per batch), short-lived (minutes-to-hours), and never edited; user-WIP drafts are entity-level, long-lived, and continuously edited. Different volume, different lifecycle, different UI. Sharing the engine would force one set of trade-offs onto both — better to have two purpose-built designs that share concepts (audit, RLS, retention class) but not tables.

- **FR-DRAFT-061** — The `pending_administrative_change` table from [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 / [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 is **distinct from drafts** (per §2.9 of this doc). The post pipeline (FR-DRAFT-040 step 4) creates `pending_administrative_change` rows when the entity's policy demands dual approval. The two tables coexist:
  - Draft: editable WIP, originator + collaborators
  - PendingAdministrativeChange: snapshot post-attempt, awaiting independent approval
  - A single post can flow through both: edit draft → submit → frozen as PendingAdministrativeChange → approve → executes the post → draft becomes POSTED.

- **FR-DRAFT-062** — The `legal_hold` table from [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.5 applies to drafts as well. A draft under hold cannot be discarded or archived until the hold is released. Drafts CAN be edited under hold (legal hold doesn't prevent edits, just deletion).

### 3.5 Audit handling — drafts are NOT full audit-trailed

- **FR-DRAFT-070** — Per-keystroke autosaves do **NOT** emit audit rows. Reasoning: a 30-minute drafting session would emit 100s of audit rows per draft per user. The audit log is for production-affecting events; drafts have not affected production yet.

- **FR-DRAFT-071** — The following draft lifecycle events DO emit audit rows (class `AUDIT_OPERATIONAL` unless noted):
  - `DRAFT_CREATED` — originator + entity type
  - `DRAFT_VISIBILITY_CHANGED` — before/after visibility + collaborator delta
  - `DRAFT_COLLABORATOR_ADDED` / `DRAFT_COLLABORATOR_REMOVED`
  - `DRAFT_POSTED` — references the production row
  - `DRAFT_DISCARDED` — with reason
  - `DRAFT_EXPIRED` — system action; auto-discard at expiry

- **FR-DRAFT-072** — When a draft posts, the production row's CREATE audit row carries `metadata: { sourceDraftId: "..." }` so the audit trail can be traversed: production row → its draft → all draft lifecycle events → originator + collaborators.

- **FR-DRAFT-073** — High-stakes drafts (rate schedules, billing-cycle parameters, financial adjustments above a threshold) emit a richer trail: every save snapshots the full payload to a `<entity>_draft_history` table for forensic review. Configurable per entity in `EntityDraftSpec.snapshotEverySave: boolean` — default false; true for rate schedules, billing cycle, adjustment over threshold.

### 3.6 Permissions

- **FR-DRAFT-080** — A new permission family per draft-supporting entity:
  - `<entity>.draft.read` — view drafts (filtered by visibility)
  - `<entity>.draft.write` — create + edit own drafts; edit drafts where the user is an editor
  - `<entity>.draft.post` — post a draft (and trigger the production-side effects)
  - `<entity>.draft.discard` — discard own or collaborator drafts
  - `<entity>.draft.share` — change visibility / add collaborators

  Existing permission roles on production entities are EXTENDED with the new draft permissions — they are NOT auto-granted. Reasoning: a junior CSR with `service_requests.read` should not automatically have `service_requests.draft.post`. Posting a draft is a stronger action than editing a real-but-already-existing entity.

- **FR-DRAFT-081** — The `drafts.admin` super-permission grants visibility into all drafts in the tenant (subject to RLS tenant boundary). Reserved for tenant admins, audit roles, and break-glass scenarios.

### 3.7 Per-entity adoption

- **FR-DRAFT-090** — Entities supporting drafts (Phase 1 + 2):

  | Entity | Phase | Drafts? | Snapshot every save | `pending_admin_change` on post (default policy) |
  |---|---|---|---|---|
  | `Adjustment` (when built) | 2 | ✓ | If amount > $1,000 | If amount > $1,000 |
  | `ServiceRequest` | 1 | ✓ | No | No |
  | `BillingCycle` parameters | 2 | ✓ | ✓ | ✓ (always) |
  | `RateSchedule` | 1 | ✓ | ✓ | ✓ (always) |
  | `Customer` | 2 | ✓ | No | No |
  | `Premise` | 2 | ✓ | No | No |
  | `Meter` | 2 | ✓ | No | No |
  | `ServiceAgreement` | 2 | ✓ | No | No |
  | `NotificationTemplate` | 2 | ✓ | ✓ (template content drives customer comms) | ✓ |
  | `RetentionPolicy` (from doc 08) | 2 | ✓ | ✓ | ✓ (always — already required by doc 08) |
  | `CustomFieldDefinition` (from doc 06) | 2 | ✓ | ✓ | No |

- **FR-DRAFT-091** — Entities **NOT** supporting drafts (Phase 1 + 2):

  | Entity | Reason |
  |---|---|
  | `MeterRead` | Single-fact ingest, not authored — drafting a reading makes no sense |
  | `Payment` | Same — comes from external systems with finality |
  | `Notification` (instance) | Generated, not authored |
  | `AuditLog` | Append-only, never edited |
  | `Attachment` | File upload is atomic; per [04-attachments.md](./04-attachments.md) attachments support staged-upload (different concept) |
  | `ImportBatch` | The batch IS the draft (per doc 09) |
  | `ServiceSuspension` | Already has its own approval workflow; folding in drafts adds complexity for no user benefit |
  | `LegalHold` (from doc 08) | Hold placement is a single-decision act; no drafting need |

  These can be revisited in Phase 3+ if user research reveals demand.

### 3.8 Non-functional requirements

- **NFR-DRAFT-001** — Autosave round-trip: ≤500ms p99 from keystroke to server-confirmed save. Critical for UX — slow autosave silently corrupts user trust ("did my changes save?").

- **NFR-DRAFT-002** — A user with 100 drafts loads the `/drafts` page in ≤1s p99. This requires composite indexes on `(utility_id, originator_id, status, last_saved_at DESC)`.

- **NFR-DRAFT-003** — Drafts table should not exceed 5% of the production-table row count for any entity, as a sanity check. If a tenant's `service_request_draft` table grows to 100K rows while `service_request` has 200K, something is wrong (probably abandoned drafts not expiring). Operations dashboard tracks the ratio.

- **NFR-DRAFT-004** — RLS on draft tables MUST be tested with adversarial input: a user deliberately constructing a query to find another user's draft must return zero rows. Integration tests cover the visibility matrix exhaustively.

- **NFR-DRAFT-005** — Conflict-resolution merge UI must complete a save in ≤2s after operator hits "Save merged version" — this is the moment of frustration after an unexpected conflict; speed matters disproportionately.

- **NFR-DRAFT-006** — Draft post latency: ≤3s p99 for entities without `pending_admin_change` policy; instantaneous transition to `PENDING_APPROVAL` for entities that require it.

- **NFR-DRAFT-007** — Draft retention is governed by [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md). Default class is `OPERATIONAL_LOG` (2-year archive). High-stakes drafts (rate schedules, billing cycle, retention policy) inherit `AUDIT_FINANCIAL` class (7-year minimum) because the snapshot history is part of the financial trail.

---

## 4. Data model changes

### 4.1 New tables (per draft-supporting entity)

| Entity | Draft table | History table (optional) |
|---|---|---|
| Adjustment | `adjustment_draft` | `adjustment_draft_history` |
| ServiceRequest | `service_request_draft` | (none — not high-stakes) |
| BillingCycle | `billing_cycle_draft` | `billing_cycle_draft_history` |
| RateSchedule | `rate_schedule_draft` | `rate_schedule_draft_history` |
| Customer | `customer_draft` | (none) |
| Premise | `premise_draft` | (none) |
| Meter | `meter_draft` | (none) |
| ServiceAgreement | `service_agreement_draft` | (none) |
| NotificationTemplate | `notification_template_draft` | `notification_template_draft_history` |
| RetentionPolicy | `retention_policy_draft` | `retention_policy_draft_history` |
| CustomFieldDefinition | `custom_field_definition_draft` | `custom_field_definition_draft_history` |

Plus shared:

| Table | Purpose |
|---|---|
| `draft_collaborator` | Who can see / edit each draft |
| `draft_lock` | Optional exclusive-edit lock (FR-DRAFT-023) |

### 4.2 New enums

```prisma
enum DraftStatus {
  DRAFT
  PENDING_APPROVAL
  POSTING
  POSTED
  DISCARDED
  EXPIRED
}

enum DraftVisibility {
  ORIGINATOR_ONLY
  SHARED_WITH_NAMED_USERS
  SHARED_WITH_ROLE
  TENANT_WIDE
}
```

### 4.3 New columns on existing tables (only as `metadata` references)

The post pipeline records `sourceDraftId` in the production audit row's metadata JSON; no schema change required there.

### 4.4 Tenant config additions

```prisma
// On TenantConfig
draftMaxAgeDays    Int     @default(90)  @map("draft_max_age_days")
draftMaxPerUser    Int     @default(50)  @map("draft_max_per_user")  // soft cap; UI nudges to clean up
```

### 4.5 RLS updates

Each draft table gets a per-table RLS policy:

```sql
ALTER TABLE service_request_draft ENABLE ROW LEVEL SECURITY;

CREATE POLICY draft_visibility ON service_request_draft
  USING (
    utility_id = current_setting('app.current_utility_id')::uuid
    AND (
      originator_id = current_setting('app.current_user_id')::uuid
      OR EXISTS (
        SELECT 1 FROM draft_collaborator c
        WHERE c.draft_type = 'service_request_draft'
          AND c.draft_id = service_request_draft.id
          AND c.user_id = current_setting('app.current_user_id')::uuid
      )
      OR (
        visibility = 'SHARED_WITH_ROLE'
        AND EXISTS (
          SELECT 1 FROM cis_user_role ur
          INNER JOIN draft_role_grant drg
            ON drg.role_id = ur.role_id
          WHERE ur.user_id = current_setting('app.current_user_id')::uuid
            AND drg.draft_type = 'service_request_draft'
            AND drg.draft_id = service_request_draft.id
        )
      )
      OR visibility = 'TENANT_WIDE'
      OR current_setting('app.has_drafts_admin', TRUE)::boolean = TRUE
    )
  );
```

(Pseudocode; concrete policy uses helper functions to keep the policy short. Identical pattern repeated per draft table — this could in principle be a generic policy on a single `drafts` table, but per FR-DRAFT-001 separate tables is the chosen design.)

### 4.6 Indexes

Each draft table gets:

```prisma
@@index([utilityId, originatorId, status])              // fast "my drafts" query
@@index([utilityId, status, lastSavedAt(sort: Desc)])    // fast "recent drafts" admin view
@@index([utilityId, expiresAt])                          // fast expiry sweeper
```

---

## 5. Implementation sequence

### Phase 1 — Engine + first two entities (~5 weeks)

1. **Engine schema, RLS, helpers, audit** (~1.5 weeks). `EntityDraftSpec` interface, generic `<entity>_draft` migration template, RLS policy template, `draft-visibility.ts` helper, `draft-aware.ts` linter rule, audit-row emit at lifecycle events.
2. **Autosave endpoint + conflict resolution** (~1 week). Debounced PATCH with optimistic-lock check, 409 handling, three-way merge UI primitive.
3. **`/drafts` unified inbox UI** (~3 days). Table view, filters, drill-into-entity edit form.
4. **`ServiceRequestDraft` adoption** (~1 week). First production rollout. Includes refactoring `service-request.service.ts` to recognize the dual-table model and the post pipeline.
5. **`RateScheduleDraft` adoption** (~1 week). Higher-stakes — includes `pending_administrative_change` integration on post + snapshot history + customer-impact preview.

### Phase 2 — Other named entities (~4 weeks)

6. **`AdjustmentDraft` (depends on Adjustment entity from Module 10)** — likely will not be deliverable until Module 10 is built; doc design captures the contract for when that happens.
7. **`BillingCycleDraft`** (~1 week). Critical entity for ops; high-stakes; requires `pending_administrative_change` always.
8. **`NotificationTemplateDraft`** (~3 days). Customer-impacting on post; requires `pending_administrative_change`.
9. **`RetentionPolicyDraft` adoption (per doc 08)** (~3 days). Already specced as dual-approval in doc 08; just adds the draft engine on top.
10. **`CustomFieldDefinitionDraft` (per doc 06)** (~3 days). Allows tenant admins to draft a new field, share with stakeholders for review, post.
11. **`CustomerDraft`, `PremiseDraft`, `MeterDraft`, `ServiceAgreementDraft`** (~1 week). Routine adoptions; no high-stakes policy gates.

### Phase 3 — Polish (~2 weeks)

12. **Three-way merge UI primitive — full version** (~3 days). The Phase 1 version is minimal; this is the polished operator-facing tool.
13. **Draft expiry sweeper + nudge notifications** (~2 days). Weekly job that emails originators about aging drafts.
14. **Permissions audit + role refactor** (~3 days). Confirm every draft-supporting entity has the four new permissions and that they are NOT auto-granted from production permissions.
15. **Operational dashboard widget** (~2 days). Tenant-admin view of draft volume per entity per user.

**Total: ~11 weeks** with one engineer; ~7 weeks with two parallel tracks (Phase 2 entity rollouts can parallelize).

---

## 6. Out of scope

1. **Real-time collaborative editing (Google-Docs-style)** — we commit autosave + conflict-resolution merge. We do NOT commit operational-transform or CRDT-based real-time co-editing. Phase 5+.
2. **Draft templates / cloning between tenants** — drafts are tenant-scoped; cloning a draft from one tenant to another is out of scope.
3. **Cross-entity draft "transactions"** — operating on multiple drafts as one batch (e.g., "post these 5 drafts together as a unit"). FR-DRAFT-043 covers dependency-driven cascade, not unrelated batch posts. True multi-draft transactions are Phase 5.
4. **Drafts in the customer portal** — residents do NOT get draft support. Their submissions are immediate. Reasoning: portal interaction model is "fill in form, submit"; drafts add complexity for an audience that has no need for them.
5. **Anonymous / unauthenticated drafts** — every draft has an `originatorId`. Public form-fill drafts (e.g., "save my application form before I create an account") are Phase 5.
6. **Draft import / export** — operators cannot CSV-export their drafts. Drafts are lived-with in the UI, not bulk-managed.
7. **Per-field permission enforcement on drafts** — if a user lacks permission to set field X, the production-side service rejects on post, not at autosave time. Field-level draft RBAC is Phase 5.
8. **AI-assisted drafting** — auto-fill suggestions, draft summaries, etc., are not committed.
9. **Draft commenting / threaded discussion** — collaborators can edit but not annotate. A comments thread on each draft is Phase 5.
10. **Mobile-native autosave** — the field-tech surface (per [02-mobile-and-responsive-ui.md](./02-mobile-and-responsive-ui.md) Tier 3) commits its own offline-queue-of-actions model. It does NOT use the draft engine. Reasoning: field-tech actions are short-lived per-task; office-worker drafts are long-lived per-WIP. Different patterns.
11. **The Adjustment entity itself** — this doc commits the draft contract for adjustments but does NOT commit to building the Adjustment entity. That's Module 10's scope (Phase 3).

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Drafts leak into production reports / lists | **Critical** | Two-layer enforcement: RLS policy + service-layer helper. Linter rule flags any cross-table query that doesn't go through `withProductionScope` or `withDraftVisibility`. Integration tests cover adversarial visibility input. |
| Originator's private draft visible to other tenant users | **Critical** | RLS uses `app.current_user_id` (set per request from JWT). Tested with adversarial role escalation in test suite. Default visibility is ORIGINATOR_ONLY — leaking visibility is opt-in, never opt-out. |
| Optimistic locking turns into pessimistic frustration | Medium | Three-way merge UI, not raw 409 errors. Most fields are independent (rate config + name + effective date — three editors editing three fields don't conflict). Locking (FR-DRAFT-023) is opt-in, not default. |
| Per-keystroke autosave overwhelms server | Medium | Debounce 2s + 30s timer (FR-DRAFT-020). Idempotency on payloadVersion (no-op repeats are free). NFR-DRAFT-001 budget gives ample headroom for 100 concurrent users. |
| Drafts table grows unbounded as users abandon WIP | Medium | 90-day soft expiry (FR-DRAFT-021); 50-draft per-user soft cap with UI nudge; weekly originator nudge email. Operations dashboard tracks ratio per NFR-DRAFT-003. |
| Posted draft + production divergence (transactional bug leaves both rows in inconsistent state) | High | Transactional all-or-nothing post (FR-DRAFT-041); resumable saga with `posting_started_at`; idempotent forward progress check. Worker crash mid-post recovers without manual intervention. |
| Two editors merge through three-way UI but produce a logically invalid record | Medium | Server-side full validation runs after merge save (per FR-DRAFT-022 final step). Invalid merge is rejected; UI surfaces the validation errors. |
| Posting a draft auto-cascades unintended dependent posts | Medium | Cascade requires explicit "Post all dependent drafts too" checkbox in UI. Default is reject-with-error if dependent drafts are referenced (FR-DRAFT-031). |
| RLS policies leak through SECURITY DEFINER functions | High | Audit all SECURITY DEFINER functions for draft-table access. Default to SECURITY INVOKER. Tests cover policy enforcement under each function context. |
| Visibility changes (originator opens draft up) creates audit-trail confusion | Low | Each visibility change emits a single audit row with full before/after collaborator list (FR-DRAFT-012). Auditor can reconstruct history. |
| Draft expiry deletes data the user wanted to keep | Medium | Expiry is SOFT (status=EXPIRED, not hard delete). 30-day window for "Restore" before archive. Per-user `draftMaxAgeDays` configurable per tenant. |
| Drafts conflict with `pending_administrative_change` semantics for same entity | Low | Documented relationship in FR-DRAFT-061: post pipeline creates `pending_administrative_change` row when policy demands; draft transitions to `PENDING_APPROVAL`. Approver sees the snapshot, not the live draft. |
| Snapshot history (`<entity>_draft_history`) explodes for high-volume entities | Low | Snapshots only on save (debounced) and only on entities flagged `snapshotEverySave: true`. Service Request drafts (high volume, low stakes) do not snapshot. Rate schedule drafts (low volume, high stakes) do. |

---

## 8. Acceptance criteria (consolidated)

### Engine
- [ ] Each draft-supporting entity has its own `<entity>_draft` table with RLS enabled.
- [ ] `draft_collaborator` and `draft_lock` tables exist with RLS.
- [ ] `DraftStatus` and `DraftVisibility` enums exist; default visibility is `ORIGINATOR_ONLY`.
- [ ] `draft-visibility.ts` and `draft-aware.ts` helpers exist; linter rule `no-implicit-cross-table-query` enforces their use.

### Visibility
- [ ] User A's `ORIGINATOR_ONLY` draft is invisible to User B in the same tenant.
- [ ] Adding User B as `editor` collaborator makes the draft visible and editable for B.
- [ ] `SHARED_WITH_ROLE` draft is visible to all role members and no one else.
- [ ] `TENANT_WIDE` draft is visible to all users with the entity's read permission.
- [ ] Tenant admin with `drafts.admin` permission can see all drafts.
- [ ] Production list/search endpoints return zero draft rows under any visibility scenario.

### Autosave
- [ ] Field change → server save in ≤500ms p99 (NFR-DRAFT-001).
- [ ] Two editors saving concurrently with stale `payloadVersion` → 409 → three-way merge.
- [ ] Network unavailable → IndexedDB queue → flush on reconnect.
- [ ] 30-second timer triggers save even without keystroke.

### Posting
- [ ] `POST /drafts/<type>/<id>/post` creates the production row, marks the draft `POSTED`, audits both events.
- [ ] Draft with validation errors cannot post; UI lists errors with field navigation.
- [ ] High-stakes entity (rate schedule) posting creates `pending_administrative_change`; draft transitions to `PENDING_APPROVAL`.
- [ ] Cascade post handles dependent drafts in topological order; failure rolls back all.
- [ ] Worker crash mid-post resumes via saga-safe forward progress.

### Exclusion
- [ ] No scheduler reads from any `<entity>_draft` table (verified by code grep + integration test).
- [ ] Reports and dashboards show only production rows.
- [ ] Custom-fields engine (doc 06) excludes drafts from CSV exports and OpenAPI variant.
- [ ] Foreign-key violations: production `account_id` cannot reference `customer_draft.id`.

### Audit
- [ ] Per-keystroke saves emit no audit rows.
- [ ] Lifecycle events (CREATE, VISIBILITY_CHANGE, POST, DISCARD, EXPIRE) emit audit rows of class `AUDIT_OPERATIONAL`.
- [ ] High-stakes draft snapshots persist in `<entity>_draft_history` per save.

### Permissions
- [ ] Four new permissions per draft-supporting entity exist.
- [ ] Production permissions do NOT auto-grant draft permissions.
- [ ] `drafts.admin` super-permission exists for tenant admin / audit roles.

### Co-editing
- [ ] Two editors editing different fields → automatic merge succeeds.
- [ ] Two editors editing same field → three-way merge UI presented.
- [ ] Lock (FR-DRAFT-023) blocks other editors with banner; expires after 5 min idle.

### Lifecycle
- [ ] Drafts survive browser refresh, browser close, multi-day gap.
- [ ] Drafts >`draftMaxAgeDays` transition to EXPIRED; originator gets weekly nudge.
- [ ] Posted drafts retained 30 days then archived per `OPERATIONAL_LOG` retention.

### UI
- [ ] `/drafts` page shows every draft visible to current user, filterable, drillable.
- [ ] Each entity edit form has autosave indicator (Saved / Saving / Conflict).
- [ ] "Post" button shows blocking validation errors with inline navigation.

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 — `pending_administrative_change` table (used by post pipeline for high-stakes entities)
  - [06-custom-fields.md](./06-custom-fields.md) — custom field engine integrates with draft entities; CustomFieldDefinitionDraft is itself a draft type
  - [07-data-validation.md](./07-data-validation.md) — Tier 1-4 validation runs at autosave and post time
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `OPERATIONAL_LOG` retention class governs draft archival; legal-hold integration; pending_administrative_change generalization
  - [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) §3.1.1 — bulk-import staging (related but distinct primitive)
  - [docs/specs/14-service-requests.md](../specs/14-service-requests.md) — current SR state machine (NEW → ASSIGNED → ...) extended at the front with DRAFT
  - [docs/specs/07-rate-management.md](../specs/07-rate-management.md) — current rate-schedule versioning (preserved; draft adds an editable WIP layer in front of it)
  - [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) — Module 10 stub (Adjustment entity to be built; this doc commits the draft contract for it)
  - `packages/shared/prisma/schema.prisma` — current schema (no draft tables; this doc adds them)

- **External**:
  - Optimistic concurrency control patterns (the version-counter-and-409 model)
  - Postgres Row Level Security with per-user predicates
  - IndexedDB autosave queue patterns
  - Three-way merge in collaborative editing

---

**End of doc 10.**
