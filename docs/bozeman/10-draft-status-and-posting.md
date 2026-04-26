# 10 — Draft Status & Posting

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (`DRAFT` status added to each adopted entity's existing status enum + shared draft-metadata columns + `draft_collaborator` junction), `packages/api/src/services/draft/*` (channel-agnostic draft engine), `packages/api/src/lib/draft-aware.ts` (query helpers that exclude drafts from production reads), and `packages/web/components/draft/*` (autosave UI, draft-list views, post-confirmation dialogs). Cross-cuts with [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (post events emit audit rows; **drafts themselves are not full audit-trailed** — see §3.6), [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) (the staged-but-uncommitted phase of an import is a row-level kind of draft, but uses different primitives — see §3.4), and [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 / [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 (the `pending_administrative_change` table — distinct from drafts; see §2.4).
**Status:** Drafted — minimal implementation. **No entity in the schema has an explicit `DRAFT` status.** Two pre-active states exist (`ServiceAgreement.PENDING`, `ServiceSuspension.PENDING`) but they are operational lifecycle states, not user work-in-progress. There is no client-side autosave anywhere in `packages/web/`. `createdBy` columns exist on several entities but are never filtered for visibility scoping. No optimistic locking, version tracking, or co-edit conflict detection. The Adjustment entity (which the RFP names explicitly) **does not exist in the schema** — Module 10 (Payments & Collections) is a Phase 3 stub.
**Effort estimate:** M-L (~7-9 weeks engineering). Drafts are modeled as a status (`DRAFT`) on each adopted entity's existing table — not a parallel set of tables — which keeps the post pipeline trivial (one `UPDATE status`). The largest cost is **getting the visibility model right** — drafts must be scoped to the originator + named collaborators, must integrate with RLS without weakening tenant isolation, and must NOT leak into production listings, reports, schedulers, or dependent calculations. Second-largest cost is **autosave with conflict resolution** for collaborative editing. Third is per-entity adoption: extending each entity's status enum, relaxing NOT-NULL columns to allow incomplete drafts, and gating list/search endpoints to exclude `DRAFT` rows.

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

### 3.1 Draft engine — single-table model

The system MUST treat **draft as a status on the production entity**, not as a separate table. Each entity that adopts draft support extends its existing status enum with `DRAFT` (and `PENDING_APPROVAL` for the dual-approval post path), adds a small set of shared draft-metadata columns, and relaxes its NOT-NULL constraints to allow incomplete WIP rows. The post pipeline becomes a single `UPDATE status` instead of a saga that copies a draft row into production.

**Why single-table** (vs. parallel `<entity>_draft` tables): The same row carries through its full lifecycle. Same id, same FKs, same audit trail. Posting is `UPDATE`, not `INSERT-then-DELETE`, so there is no transactional saga, no `posted_as_id` redirection, no risk of draft and production diverging mid-post. Half the schema, half the RLS policies, no risk of the two shapes drifting over time. The trade-off — that a production row's NOT-NULL columns must be relaxed and re-enforced via CHECK on `status != 'DRAFT'` — is mechanical.

#### 3.1.1 Storage model — extending each entity

- **FR-DRAFT-001** — Each adopted entity's existing status enum MUST be extended with two new states:

  ```prisma
  enum ServiceRequestStatus {
    DRAFT              // NEW in this doc — user WIP, not yet visible to dispatcher
    PENDING_APPROVAL   // NEW — post-attempted, waiting on pending_administrative_change for high-stakes entities
    NEW                // existing
    ASSIGNED
    IN_PROGRESS
    PENDING_FIELD
    COMPLETED
    FAILED
    CANCELLED
  }
  ```

  `DRAFT` is the entry state when a user opts into draft mode (otherwise the existing first-active state — `NEW` for SR, `ACTIVE`/`PENDING` for SA, etc. — is still the entry). `PENDING_APPROVAL` is the post-time state for entities whose post triggers a dual-approval gate (FR-DRAFT-040 step 4); see §3.2.

  Per-entity, the existing first-active state (`NEW`, `ACTIVE`, etc.) is preserved as the post target. The state machine pre-pends `DRAFT → (PENDING_APPROVAL?) → <existing first state>` to whatever transitions the entity already has.

- **FR-DRAFT-002** — Each adopted entity's production table MUST add the following shared draft-metadata columns. They are **nullable on posted rows** (the production lifecycle doesn't need them) and **populated on `DRAFT`/`PENDING_APPROVAL` rows**:

  ```prisma
  // Added to each adopted entity's production table:
  originatorId    String?         @map("originator_id") @db.Uuid       // who created the draft
  draftTitle      String?         @map("draft_title")                  // optional user-given label, e.g., "Q3 rate revision"
  payloadVersion  Int             @default(1) @map("payload_version")  // optimistic-lock counter (also used for posted rows on subsequent edits)
  lastSavedAt     DateTime?       @map("last_saved_at") @db.Timestamptz
  lastSavedBy     String?         @map("last_saved_by") @db.Uuid
  autosaveSeq     BigInt          @default(0) @map("autosave_seq")     // monotonic per-row counter for autosave events
  visibility      DraftVisibility @default(ORIGINATOR_ONLY)             // only consulted when status IN ('DRAFT', 'PENDING_APPROVAL')
  postedAt        DateTime?       @map("posted_at") @db.Timestamptz
  postedBy        String?         @map("posted_by") @db.Uuid
  discardedAt     DateTime?       @map("discarded_at") @db.Timestamptz
  discardedBy     String?         @map("discarded_by") @db.Uuid
  draftExpiresAt  DateTime?       @map("draft_expires_at") @db.Timestamptz  // auto-discard at this date if not posted
  ```

  Plus the shared enum:

  ```prisma
  enum DraftVisibility {
    ORIGINATOR_ONLY
    SHARED_WITH_NAMED_USERS
    SHARED_WITH_ROLE
    TENANT_WIDE
  }
  ```

  Note: there is no `DraftStatus` enum. The "draftness" of a row is encoded in the entity's own `status` column — `DRAFT` and `PENDING_APPROVAL`. The `POSTING` / `POSTED` / `DISCARDED` / `EXPIRED` states from the prior design collapse: posting transitions the row's `status` to its existing first-active state and sets `postedAt`; discarding transitions to a new universal `DISCARDED` state (added to each entity's enum); expiring is an automated discard with `discardReason: "EXPIRED"`.

  Indexes added to each adopted entity:
  ```prisma
  @@index([utilityId, status, originatorId])           // fast "my drafts" query (predicate covers status IN ('DRAFT', 'PENDING_APPROVAL'))
  @@index([utilityId, status, lastSavedAt(sort: Desc)]) // fast "recent drafts" admin view
  @@index([utilityId, status, draftExpiresAt])         // fast expiry sweeper
  ```

  The first index is highly selective: most rows in any tenant are not in `DRAFT`/`PENDING_APPROVAL` status, so the index footprint is small.

- **FR-DRAFT-003** — Existing NOT-NULL columns that are required for a posted entity but not necessarily known when drafting MUST be relaxed to nullable, with a CHECK constraint that re-enforces NOT-NULL once the row leaves draft state. Example (`service_request`):

  ```sql
  -- Existing column is now nullable:
  ALTER TABLE service_request ALTER COLUMN account_id DROP NOT NULL;

  -- CHECK constraint reinstates the requirement post-draft:
  ALTER TABLE service_request ADD CONSTRAINT chk_sr_required_when_posted
    CHECK (
      status IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')
      OR (account_id IS NOT NULL AND priority IS NOT NULL AND request_type IS NOT NULL)
    );
  ```

  Per-entity, the `EntityDraftSpec` enumerates which columns to relax. The CHECK constraint is generated from the same spec to keep the relaxation list and the re-enforcement list in sync.

- **FR-DRAFT-004** — Foreign keys from production rows MUST NOT reference draft rows. Two-layer enforcement:
  1. **Application layer** (primary): the entity's `validateRow` rejects FKs that resolve to a `DRAFT`/`PENDING_APPROVAL`-status row. The validation runs at autosave for relaxed warning ("you're referencing a draft customer; this will need to be posted before you can post this SR") and at post time as a hard error.
  2. **Database trigger** (defense in depth): on entities where this matters most (e.g., `ServiceAgreement.customerId`, `ServiceAgreement.premiseId`), a trigger raises an exception if a row tries to reference a `DRAFT`-status parent. CHECK constraints in standard Postgres can't reference other tables, so a `BEFORE INSERT/UPDATE` trigger does the job.

  The trigger is per-relationship and only added where needed. Most entity relationships don't need it because the application-layer check is sufficient.

- **FR-DRAFT-005** — A common `draft_collaborator` junction table covers cross-entity collaboration. It is polymorphic (one table for all entity types) because collaborators are a cross-cutting concern and the polymorphism keeps the schema small:

  ```prisma
  model DraftCollaborator {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    entityType  String   @map("entity_type") @db.VarChar(64)  // "service_request" | "rate_schedule" | "billing_cycle" | ...
    entityId    String   @map("entity_id") @db.Uuid
    userId      String   @map("user_id") @db.Uuid
    role        String   @db.VarChar(32)  // "viewer" | "editor"
    addedBy     String   @map("added_by") @db.Uuid
    addedAt     DateTime @default(now()) @map("added_at") @db.Timestamptz
    @@unique([utilityId, entityType, entityId, userId])
    @@index([utilityId, userId, entityType])
    @@map("draft_collaborator")
  }
  ```

  Polymorphism in Postgres without proper FK enforcement is a known weak spot. Mitigations: a daily reconciliation job verifies every `(entityType, entityId)` resolves to a real row; orphaned collaborator rows (parent entity hard-deleted, which should be rare) are logged and removed. The collaborator entries auto-clear when the row's status leaves `DRAFT`/`PENDING_APPROVAL` (post or discard) — collaborators on a posted entity have no meaning. Cleanup happens in the same transaction as the status transition.

#### 3.1.2 Visibility model

- **FR-DRAFT-010** — Default visibility for every new draft is `ORIGINATOR_ONLY`. The originator MAY change it to one of:
  - `ORIGINATOR_ONLY` (default) — only the originator sees and edits.
  - `SHARED_WITH_NAMED_USERS` — visible to originator + each user in `draft_collaborator`. Editors edit; viewers see read-only.
  - `SHARED_WITH_ROLE` — visible to all users in the tenant who hold a configured role (e.g., "rate-management-team-lead"). The role itself is set per draft.
  - `TENANT_WIDE` — visible to all users with the relevant module read permission. (Rare; used for organization-wide proposals.)

- **FR-DRAFT-011** — Visibility enforcement happens at three layers:
  1. **Postgres RLS policy** (strongest guarantee): the existing per-tenant RLS policy on each adopted entity is extended with a draft-visibility predicate. The full policy reads: *"this row is visible if `utility_id` matches the session's current tenant AND (the row is not in DRAFT/PENDING_APPROVAL state OR the row's draft visibility allows the current user)."* The application sets `app.current_user_id` (in addition to the existing `app.current_utility_id`) per request from the JWT. **Reasoning:** RLS is the strongest guarantee — even a buggy service-layer query cannot leak drafts.
  2. **Service-layer scoping helper** (`packages/api/src/lib/draft-aware.ts`): two helpers — `withProductionScope(query)` injects `WHERE status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')` for production-only reads, and `withDraftVisibility(query, ctx)` injects the visibility predicate for draft-aware reads. Service code uses one or the other explicitly.
  3. **Per-entity production view** (defense in depth): every adopted entity gets a `<entity>_v` view defined as `SELECT * FROM <entity> WHERE status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')`. Reports, dashboards, and any read-replica analytics queries use the view, not the table.
  - **Acceptance:** Direct psql query as `app_user` role with `app.current_utility_id` and `app.current_user_id` set returns zero `DRAFT`-status rows when the user is neither originator nor collaborator nor role-member nor tenant-admin. Test passes against every adopted entity. A separate test confirms posted rows ARE visible to all users with the entity's read permission (the visibility predicate gates DRAFT only, not posted state).

- **FR-DRAFT-012** — Visibility changes (e.g., originator opens up a draft from ORIGINATOR_ONLY to SHARED_WITH_NAMED_USERS) emit a single audit row of class `AUDIT_OPERATIONAL` with `before_state` + `after_state` + the new collaborator list. Per-edit autosaves do NOT emit audit rows (would explode volume — see §3.6).

- **FR-DRAFT-013** — A user MAY have two roles relevant to drafts:
  - `drafts.read_subordinate` — sees drafts created by users they manage (per the org-hierarchy table — out of scope for this doc; the role infrastructure exists, see [docs/specs/18-theme-and-configuration.md](../specs/18-theme-and-configuration.md))
  - `drafts.read_team` — sees all drafts in their team
  These are tenant-configurable extensions of the visibility model.

#### 3.1.3 Autosave + persistence

- **FR-DRAFT-020** — All draft-supporting forms in the web app implement **debounced autosave** with the following contract:
  - Trigger: any field change OR every 30 seconds (whichever first), with a 2-second debounce window after the last keystroke.
  - Endpoint: the existing entity's PATCH endpoint (e.g., `PATCH /api/v1/service-requests/<id>`) is reused for autosave. Body includes `{ ...partialPayload, payloadVersion }`. The endpoint is idempotent — same `payloadVersion` is a no-op.
  - Authorization: PATCH on a `DRAFT`-status row checks the draft visibility (originator + editor collaborators); PATCH on a posted row checks the existing entity edit permission. Same endpoint, status-aware authorization.
  - Conflict response: HTTP 409 Conflict with the current server-side row if the client's `payloadVersion` is older than the server's. The UI presents a merge dialog (FR-DRAFT-022).
  - Local fallback: if the network is unavailable, autosave writes to `IndexedDB` keyed by `(entityType, entityId, autosaveSeq)`. On reconnect, queued autosaves are flushed in order. (Same primitive as PWA offline queueing per [03-progressive-web-app.md](./03-progressive-web-app.md).)

- **FR-DRAFT-021** — Drafts persist server-side **indefinitely by default**, with a per-tenant `draft_max_age_days` (default 90). On `draftExpiresAt` reached, a sweeper transitions the row to `DISCARDED` with `discardedAt = now()` and a reason of `"EXPIRED"` (rather than hard-deleting). One week before expiry, the originator receives a notification: *"Your draft service request 'Smith family — meter relocation' is 7 days from auto-discard. Open to extend or post."*
  - Reasoning: an unbounded set of `DRAFT`-status rows is a quiet memory leak; users abandon drafts and forget about them. A reminder + soft-discard balances persistence with hygiene. Discarded rows are themselves cleaned up per the entity's retention policy ([08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md)) — typically `OPERATIONAL_LOG` (2-year archive).
  - **Acceptance:** A row with `lastSavedAt` 90 days ago shows as `DISCARDED` with `discardedAt = now()` and `discardReason = "EXPIRED"`. The originator's drafts page shows it under a "Recently expired" tab with a "Restore" action that flips status back to `DRAFT` and clears `discardedAt`.

- **FR-DRAFT-022** — Co-edit conflict resolution: when two editors save concurrently, the second save returns `409 Conflict` with the current server row. The UI shows a three-way merge:
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
  - Implementation: a `draft_lock` table keyed by `(entityType, entityId)` with `lockedBy`, `lockedAt`, `expiresAt`. Polled by the editor's UI every 30s.

- **FR-DRAFT-024** — The web app provides a unified `/drafts` page listing every draft (rows with `status IN ('DRAFT', 'PENDING_APPROVAL')`) visible to the current user across all entity types. Filterable by entity type, originator, last-saved date. Each draft links to its entity-specific edit form. This is the operator's "open work" inbox. Implementation queries each adopted entity table via the `withDraftVisibility` helper and unions the results.

#### 3.1.4 Draft validation

- **FR-DRAFT-030** — Draft validation runs at three points:
  1. **Autosave time** — runs the entity's Zod schema with `.partial()` applied (per doc 07's Tier 1) plus any cross-field rules that apply to partial drafts. Errors surface as warnings on the form ("This will need to be filled in before you can post"). Drafts can be saved even with errors — a draft is allowed to be incomplete.
  2. **Post-attempt time** — runs the full schema (no `.partial()`) plus all four tiers from [07-data-validation.md](./07-data-validation.md). Errors block posting. UI shows the error list with inline navigation to each problem field.
  3. **Server-side post** — re-runs full validation server-side as a defense-in-depth check. Posting an invalid draft via the API directly is also rejected.

- **FR-DRAFT-031** — Drafts MAY reference draft dependencies. E.g., a draft `ServiceRequest` may reference a draft `Customer` that hasn't been posted yet. The post pipeline (FR-DRAFT-040) topologically sorts the dependency graph — posting the SR draft cascades into posting the Customer draft first if the operator opts in. If they don't opt in, posting the SR fails with a clear error: "This draft references draft Customer 'New Customer (Smith family)'. Post the Customer first or include it in this post."

### 3.2 Posting pipeline

- **FR-DRAFT-040** — The "post" verb is a single endpoint per entity: `POST /api/v1/<entity>/<id>/post` (e.g., `POST /api/v1/service-requests/<id>/post`). The endpoint runs in a single database transaction:
  1. Optimistic-lock check — `payloadVersion` from the request matches the server-side current value.
  2. Full validation — runs the entity's complete schema (no `.partial()`) plus all four tiers from [07-data-validation.md](./07-data-validation.md). The CHECK constraint added in FR-DRAFT-003 is a final safety net that rejects the `UPDATE` if any required field is null.
  3. Authorization — only the originator OR a collaborator with `editor` role + `<entity>.post` permission may post (posting is a stronger right than editing).
  4. Optional `pending_administrative_change` gate — if the entity's policy requires dual approval (e.g., adjustment > $1,000, rate schedule revision, billing-cycle parameter change), the `UPDATE` sets `status = 'PENDING_APPROVAL'` instead of the entity's first-active state, and creates a `pending_administrative_change` row with `operationType = "post_<entity>"`. The actual transition to the first-active state happens when the second approver approves — see FR-DRAFT-042.
  5. The UPDATE: `UPDATE <entity> SET status = '<first_active_state>', postedAt = now(), postedBy = <user_id>, payloadVersion = payloadVersion + 1 WHERE id = <id> AND payloadVersion = <claimed_version>`. The same row carries through; `id`, FKs, and any external references are preserved by definition.
  6. Side effects — per-entity audit row of `CREATE` class for the entity's natural retention class (`FINANCIAL` for adjustments, `OPERATIONAL` for SRs, etc.) with `metadata: { postedFromDraft: true }`. Notification triggers, downstream recalculations, etc., fire as they would for any new entity.
  7. Cleanup — collaborator rows for this entity are removed (per FR-DRAFT-005). The draft-metadata columns (`originatorId`, `lastSavedAt`, `visibility`, etc.) stay populated on the row indefinitely — they cost nothing once the row is posted and they support traceability ("who originated this?").

- **FR-DRAFT-041** — Because the post is a single `UPDATE` in a single transaction, there is no saga, no `POSTING` intermediate state, and no recovery code for mid-post crashes. Postgres's MVCC makes the transition atomic. Either the row is `DRAFT` (transaction rolled back) or it's the entity's first-active state (transaction committed) — never both, never neither.

- **FR-DRAFT-042** — Approval-gated post: when step 4 above sets the row to `PENDING_APPROVAL`, the row is no longer editable as a draft (the visibility model still hides it from non-collaborators, but autosave is blocked). On second approval, a worker that consumes the `pending_administrative_change` queue runs a final `UPDATE` to transition `PENDING_APPROVAL → <first_active_state>` plus `postedAt`/`postedBy`. On rejection, the row reverts to `DRAFT`. On expiration of the `pending_administrative_change` row (30-day TTL per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) FR-RET-051), the row reverts to `DRAFT` and the originator is notified.

- **FR-DRAFT-043** — Post-cascade for dependent drafts (FR-DRAFT-031): when the operator opts to "Post all", the engine performs a topological sort of the dependency graph and posts in dependency order, all in a single outer transaction. Each constituent post is itself a single `UPDATE` (FR-DRAFT-040 step 5). If any post fails, the whole cascade rolls back via Postgres transaction abort — no compensating actions needed.

- **FR-DRAFT-044** — A discard verb: `POST /api/v1/<entity>/<id>/discard` with `{ reason }` body. The endpoint runs `UPDATE <entity> SET status = 'DISCARDED', discardedAt = now(), discardedBy = <user_id>, discardReason = <reason>`. Discard does NOT trigger production-side effects — discarded rows have never been posted, so notifications, recalculations, and downstream side effects don't apply. Collaborator rows are cleared in the same transaction. Discarded rows stay queryable in the originator's "Discarded" tab for 30 days, after which they're archived per the entity's retention class ([08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) `OPERATIONAL_LOG` default).

### 3.3 Exclusion from production-impacting operations

- **FR-DRAFT-050** — `DRAFT`/`PENDING_APPROVAL`/`DISCARDED`-status rows MUST NEVER be returned by:
  - Production list/search endpoints. `GET /api/v1/service-requests` returns only rows whose status is in the entity's set of active+terminal post-draft states. Operators see drafts via the unified `/drafts` page (FR-DRAFT-024) or by drilling into a specific entity's draft tab.
  - Reports — every report query MUST go through the per-entity `<entity>_v` view (FR-DRAFT-011 layer 3) which excludes draft/pending-approval/discarded states by definition.
  - Schedulers — the audit retention sweep, suspension scheduler, delinquency dispatcher, etc., MUST add `WHERE status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')` to their per-entity reads. This is enforced by `withProductionScope()` in service code and by the linter rule (FR-DRAFT-051).
  - Notification triggers — drafting a service request does NOT notify the customer. Posting it does. Triggers fire on the `status` transition out of `DRAFT`/`PENDING_APPROVAL`, not on row creation.
  - Billing calculations — a draft rate schedule does not affect any consumption calculation. The rate-resolution query already filters by `effectiveDate`/`expirationDate`; it now also filters by `status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')`.
  - Custom-fields engine ([06-custom-fields.md](./06-custom-fields.md)) — draft rows do not appear in CSV exports, query-builder results, or the per-tenant OpenAPI variant. The CSV export query reads from `<entity>_v` (the production view).
  - Relationship integrity — production rows that reference other entities MUST validate that the referenced row is not in `DRAFT`/`PENDING_APPROVAL` status (per FR-DRAFT-004). A trigger on FK-sensitive relationships (`ServiceAgreement.customerId`, `ServiceAgreement.premiseId`, `ServiceAgreement.meterId`) catches violations at the database layer.

- **FR-DRAFT-051** — The `draft-aware.ts` helper has two scoping verbs: `withProductionScope(query)` for production-only reads (excludes draft/pending/discarded) and `withDraftVisibility(query, ctx)` for draft-aware reads (originator/collaborator/role visibility). Service code calls one or the other explicitly. A linter rule `no-raw-entity-query` flags any `prisma.<entity>.findMany()` or `findFirst()` that doesn't go through one of the helpers, forcing every query author to make a deliberate choice.

- **FR-DRAFT-052** — Counting and analytics: a tenant dashboard widget showing "Open service requests" MUST count rows in active states only (excluding draft/pending/discarded). A separate "Open work" widget shows draft counts visible to the current user. These are two different metrics queried via the two different helpers.

- **FR-DRAFT-053** — Foreign-key targeting: by default, FKs in this schema reference rows by id without checking status. Most relationships don't need a status check (an audit row referencing a posted entity carries on referencing it through any future status changes; a service request referencing an account doesn't care if the account later transitions to CLOSED). For relationships where status matters (e.g., a service agreement referencing a customer should not be created against a draft customer), per-entity application validation in `validateRow` rejects with a clear error message at autosave time and at post time. The trigger from FR-DRAFT-004 layer 2 is the database-level safety net for the most safety-critical relationships only.

### 3.4 Relationship to existing primitives

- **FR-DRAFT-060** — The bulk-import staging area from [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) FR-ING-003 is conceptually a kind of draft (validated rows held until commit) but is **not unified** with this engine. Reasoning: bulk-import drafts are row-level (thousands per batch), short-lived (minutes-to-hours), and never edited; user-WIP drafts are entity-level, long-lived, and continuously edited. Different volume, different lifecycle, different UI. Sharing the engine would force one set of trade-offs onto both — better to have two purpose-built designs that share concepts (audit, RLS, retention class) but not tables.

- **FR-DRAFT-061** — The `pending_administrative_change` table from [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 / [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 is **distinct from drafts** (per §2.9 of this doc). The post pipeline (FR-DRAFT-040 step 4) creates `pending_administrative_change` rows when the entity's policy demands dual approval, and the row's status moves to `PENDING_APPROVAL`. The two coexist:
  - Draft (`status = DRAFT`): editable WIP, originator + collaborators
  - PendingAdministrativeChange row: a snapshot of the proposed post-attempt, awaiting independent approval; the entity row has `status = PENDING_APPROVAL` during this window and is read-only as a draft
  - A single post flows: edit draft → submit → row moves to `PENDING_APPROVAL` + `pending_administrative_change` row created → approve → row transitions to first-active state → `pending_administrative_change` marked EXECUTED.

- **FR-DRAFT-062** — The `legal_hold` table from [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.5 applies to drafts as well. A draft under hold cannot be discarded or archived until the hold is released. Drafts CAN be edited under hold (legal hold doesn't prevent edits, just deletion).

### 3.5 Audit handling — drafts are NOT full audit-trailed

- **FR-DRAFT-070** — Per-keystroke autosaves do **NOT** emit audit rows. Reasoning: a 30-minute drafting session would emit hundreds of audit rows per draft per user. The audit log is for production-affecting events; drafts have not affected production yet.

- **FR-DRAFT-071** — The following draft lifecycle events DO emit audit rows (class `AUDIT_OPERATIONAL` unless noted):
  - `DRAFT_CREATED` — originator + entity type + entity id
  - `DRAFT_VISIBILITY_CHANGED` — before/after visibility + collaborator delta
  - `DRAFT_COLLABORATOR_ADDED` / `DRAFT_COLLABORATOR_REMOVED`
  - `DRAFT_POSTED` — same row id, status transition `DRAFT → <first_active>`
  - `DRAFT_DISCARDED` — with reason; status transition `DRAFT → DISCARDED`
  - `DRAFT_EXPIRED` — system action; auto-discard at expiry

- **FR-DRAFT-072** — Because draft and posted rows share the same row id, the audit trail naturally carries through: every audit row for the entity references the same id from `DRAFT_CREATED` through whatever future operations happen on the posted entity. No `sourceDraftId` redirection is needed. An auditor querying `audit_log WHERE entity_id = X` sees the full lifecycle in chronological order.

- **FR-DRAFT-073** — For high-stakes entities (rate schedules, billing-cycle parameters, large adjustments, retention policies) where forensic reconstruction of the editing history matters, the autosave endpoint MAY snapshot the row's full payload into the audit log on each save. Configured per entity via `EntityDraftSpec.snapshotEverySave: boolean` — default `false`. When `true`, each autosave emits one additional audit row of class `AUDIT_OPERATIONAL` (`AUDIT_FINANCIAL` for adjustments) with `action: "DRAFT_SAVED"` and `before_state`/`after_state` as the diff. Volume note: a 30-minute drafting session of a rate schedule with `snapshotEverySave: true` emits ~30-90 audit rows; bounded by the autosave debounce (FR-DRAFT-020). The retention engine (doc 08) tiers these per the entity's retention class.

  No separate `<entity>_draft_history` table — the audit log IS the history. Reusing the existing audit infrastructure means snapshots are automatically tamper-evident (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md)), retention-class-managed (per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md)), and queryable through the same forensic tools.

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

- **NFR-DRAFT-002** — A user with 100 drafts loads the `/drafts` page in ≤1s p99. The composite index `(utility_id, status, originator_id)` per FR-DRAFT-002 makes this trivial — `DRAFT`/`PENDING_APPROVAL` rows are a small slice of any entity table, and the index is highly selective.

- **NFR-DRAFT-003** — Per-entity, the count of `DRAFT`/`PENDING_APPROVAL` rows should not exceed 5% of the entity's active rows, as a sanity check. If a tenant has 10K draft service requests against 200K active SRs, something is wrong (probably abandoned drafts not expiring). Operations dashboard tracks the ratio per entity per tenant.

- **NFR-DRAFT-004** — RLS on every adopted entity MUST be tested with adversarial input: a user deliberately constructing a query to find another user's draft must return zero rows. Integration tests cover the visibility matrix exhaustively against every adopted entity.

- **NFR-DRAFT-005** — Conflict-resolution merge UI must complete a save in ≤2s after operator hits "Save merged version" — this is the moment of frustration after an unexpected conflict; speed matters disproportionately.

- **NFR-DRAFT-006** — Draft post latency: ≤3s p99 for entities without `pending_admin_change` policy; instantaneous transition to `PENDING_APPROVAL` for entities that require it.

- **NFR-DRAFT-007** — Draft retention is governed by [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md). Default class is `OPERATIONAL_LOG` (2-year archive). High-stakes drafts (rate schedules, billing cycle, retention policy) inherit `AUDIT_FINANCIAL` class (7-year minimum) because the snapshot history is part of the financial trail.

---

## 4. Data model changes

### 4.1 Modified tables (per adopted entity)

For each entity in FR-DRAFT-090, the existing production table is modified — there are **no parallel `<entity>_draft` tables**. Modifications:

1. **Status enum extended** with three new states:
   - `DRAFT` — user WIP
   - `PENDING_APPROVAL` — post-attempted, awaiting `pending_administrative_change` for high-stakes entities
   - `DISCARDED` — explicitly or auto-discarded (replaces the prior `EXPIRED` state — discarded-with-reason-EXPIRED is a soft expiry per FR-DRAFT-021)
2. **Shared draft-metadata columns added** (per FR-DRAFT-002): `originatorId`, `draftTitle`, `payloadVersion`, `lastSavedAt`, `lastSavedBy`, `autosaveSeq`, `visibility`, `postedAt`, `postedBy`, `discardedAt`, `discardedBy`, `discardReason`, `draftExpiresAt`. All nullable on posted rows; populated on draft/pending/discarded rows.
3. **Existing NOT-NULL columns relaxed** to nullable (per FR-DRAFT-003), with a per-entity CHECK constraint reinstating NOT-NULL for posted rows.
4. **New indexes** (per FR-DRAFT-002): `(utilityId, status, originatorId)`, `(utilityId, status, lastSavedAt DESC)`, `(utilityId, status, draftExpiresAt)`.
5. **Per-entity production view** (per FR-DRAFT-011 layer 3): `CREATE VIEW <entity>_v AS SELECT * FROM <entity> WHERE status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')`. Reports and analytics read from the view.

### 4.2 New tables (shared, not per-entity)

| Table | Purpose | Section |
|---|---|---|
| `draft_collaborator` | Polymorphic — who can see / edit drafts of any entity type | 3.1.1 (FR-DRAFT-005) |
| `draft_role_grant` | Polymorphic — which roles see drafts at `SHARED_WITH_ROLE` visibility for which entity row | 3.1.2 |
| `draft_lock` | Polymorphic — optional exclusive-edit lock | 3.1.3 (FR-DRAFT-023) |

That's it. No per-entity draft tables. The total schema additions are: 3 small polymorphic tables + a handful of columns and one CHECK + one view per adopted entity.

### 4.3 New enums

```prisma
enum DraftVisibility {
  ORIGINATOR_ONLY
  SHARED_WITH_NAMED_USERS
  SHARED_WITH_ROLE
  TENANT_WIDE
}
```

The previously-proposed `DraftStatus` enum is **dropped** — draftness is encoded in each entity's existing status enum (extended with `DRAFT`, `PENDING_APPROVAL`, `DISCARDED`). This avoids the awkward situation of two status fields on the same row.

### 4.4 Tenant config additions

```prisma
// On TenantConfig
draftMaxAgeDays    Int     @default(90)  @map("draft_max_age_days")
draftMaxPerUser    Int     @default(50)  @map("draft_max_per_user")  // soft cap; UI nudges to clean up
```

### 4.5 RLS updates

Each adopted entity's existing RLS policy is **extended** (not replaced). The new policy reads: *"this row is visible if the existing tenant predicate passes, AND (the row is in a non-draft state OR the row's draft visibility allows the current user)."* Sketch for `service_request`:

```sql
DROP POLICY tenant_isolation ON service_request;

CREATE POLICY tenant_isolation_with_draft_visibility ON service_request
  USING (
    utility_id = current_setting('app.current_utility_id')::uuid
    AND (
      -- Posted, terminal, or admin-bypass rows: visible to anyone with tenant access
      status NOT IN ('DRAFT', 'PENDING_APPROVAL')
      OR current_setting('app.has_drafts_admin', TRUE)::boolean = TRUE
      -- Draft rows: visible only per the visibility model
      OR originator_id = current_setting('app.current_user_id')::uuid
      OR EXISTS (
        SELECT 1 FROM draft_collaborator c
        WHERE c.entity_type = 'service_request'
          AND c.entity_id = service_request.id
          AND c.user_id = current_setting('app.current_user_id')::uuid
      )
      OR (
        visibility = 'SHARED_WITH_ROLE'
        AND EXISTS (
          SELECT 1 FROM cis_user_role ur
          INNER JOIN draft_role_grant drg ON drg.role_id = ur.role_id
          WHERE ur.user_id = current_setting('app.current_user_id')::uuid
            AND drg.entity_type = 'service_request'
            AND drg.entity_id = service_request.id
        )
      )
      OR visibility = 'TENANT_WIDE'
    )
  );
```

(Pseudocode; the concrete policy is generated from a SQL helper function `is_draft_visible(entity_type, entity_id, originator_id, visibility)` to keep each per-entity policy short. The same predicate shape applies to every adopted entity — the only difference is the entity-type literal.)

The `WITH CHECK` clause uses the same predicate so a buggy service can't INSERT a draft visible to the wrong users.

### 4.6 Triggers

For relationships where production rows must not reference a draft parent (per FR-DRAFT-004 layer 2 — limited set), a `BEFORE INSERT OR UPDATE` trigger on the child table raises if the parent is in `DRAFT`/`PENDING_APPROVAL` status. Initial set:

| Child entity / column | Parent | Reason |
|---|---|---|
| `service_agreement.customer_id` | `customer` | An SA against a draft customer would reference an incomplete row |
| `service_agreement.premise_id` | `premise` | Same |
| `service_agreement.meter_id` | `meter` | Same |
| `meter_assignment.meter_id` | `meter` | Same |
| `meter_assignment.service_agreement_id` | `service_agreement` | Cascade |

For other relationships (e.g., `service_request.account_id` → `account`), application-layer validation in `validateRow` is sufficient.

---

## 5. Implementation sequence

### Phase 1 — Engine + first two entities (~3.5 weeks)

1. **Shared schema, RLS helper, scoping helpers, audit emit, linter rule** (~1 week). Polymorphic tables (`draft_collaborator`, `draft_role_grant`, `draft_lock`), the `is_draft_visible(...)` SQL helper function, `withProductionScope` / `withDraftVisibility` TypeScript helpers in `packages/api/src/lib/draft-aware.ts`, the `no-raw-entity-query` linter rule, audit emission glue. No per-entity work yet.
2. **Autosave endpoint behavior + conflict resolution** (~1 week). Debounced PATCH with optimistic-lock check (the existing per-entity PATCH endpoints are extended; no new endpoints). 409 handling, three-way merge UI primitive.
3. **`/drafts` unified inbox UI** (~3 days). Table view that queries each adopted entity via `withDraftVisibility` and unions; filters, drill-into-entity edit form.
4. **`ServiceRequest` adoption** (~3 days). Add status states + columns + CHECK + view + RLS update + post endpoint. First production rollout.
5. **`RateSchedule` adoption** (~3 days). Add status states + columns + CHECK + view + RLS update + post endpoint with `pending_administrative_change` integration. Includes `snapshotEverySave: true`.

### Phase 2 — Remaining named entities (~3 weeks)

6. **`Adjustment` adoption (depends on Adjustment entity from Module 10)** — captures the draft contract for when Module 10 ships. Not deliverable in this engagement unless Module 10 lands first.
7. **`BillingCycle` adoption** (~3 days). Critical entity for ops; `pending_administrative_change` always.
8. **`NotificationTemplate` adoption** (~2 days). `pending_administrative_change` always.
9. **`RetentionPolicy` adoption (per doc 08)** (~2 days). Already specced as dual-approval in doc 08; just adds the draft engine on top.
10. **`CustomFieldDefinition` adoption (per doc 06)** (~2 days). Allows tenant admins to draft a new field, share with stakeholders for review, post.
11. **`Customer`, `Premise`, `Meter`, `ServiceAgreement` adoptions** (~3 days). Routine; no high-stakes policy gates. Includes the FK-status triggers (FR-DRAFT-004 layer 2) for the SA→Customer/Premise/Meter relationships.

### Phase 3 — Polish (~1.5 weeks)

12. **Three-way merge UI — full version** (~3 days). The Phase 1 version is minimal; this is the polished operator-facing tool.
13. **Draft expiry sweeper + nudge notifications** (~2 days). Daily job that scans rows with `status IN ('DRAFT', 'PENDING_APPROVAL')` past `draftExpiresAt` and transitions to `DISCARDED`. Weekly nudge emails 7 days before expiry.
14. **Permissions audit** (~2 days). Confirm every adopted entity has the five new permissions and that they are NOT auto-granted from production permissions.
15. **Operational dashboard widget** (~1 day). Tenant-admin view of draft volume per entity per user.

**Total: ~8 weeks** with one engineer; ~5 weeks with two parallel tracks (Phase 2 adoptions can parallelize once the engine lands). The single-table model cuts roughly 3 weeks vs. the prior parallel-tables design — most of the saving is in not building per-entity draft tables, per-entity post sagas, or `<entity>_draft_history` tables.

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
| Drafts leak into production reports / lists | **Critical** | Three-layer enforcement: extended RLS policy on each entity, `withProductionScope` / `withDraftVisibility` helpers, per-entity `<entity>_v` view. Linter rule `no-raw-entity-query` flags any direct table query that doesn't go through one of the helpers. Integration tests cover adversarial visibility input across every adopted entity. |
| Originator's private draft visible to other tenant users | **Critical** | RLS uses `app.current_user_id` (set per request from JWT). Tested with adversarial role escalation in test suite. Default visibility is `ORIGINATOR_ONLY` — leaking visibility is opt-in, never opt-out. |
| Production row referencing a draft parent | **High** | Application-layer validation in every entity's `validateRow` rejects FKs that resolve to a `DRAFT`/`PENDING_APPROVAL` parent (FR-DRAFT-004 layer 1). Triggers on the most safety-critical relationships (SA→Customer/Premise/Meter) catch at the database layer (FR-DRAFT-004 layer 2). |
| Existing service code paths bypass the new status filter | **High** | Linter rule `no-raw-entity-query` rejects any `prisma.<entity>.findMany()` / `findFirst()` that doesn't go through `withProductionScope` or `withDraftVisibility`. CI fails on violations. The `<entity>_v` view provides a final safety net for any code path that slips past the linter. |
| Optimistic locking turns into pessimistic frustration | Medium | Three-way merge UI, not raw 409 errors. Most fields are independent (rate config + name + effective date — three editors editing three fields don't conflict). Locking (FR-DRAFT-023) is opt-in, not default. |
| Per-keystroke autosave overwhelms server | Medium | Debounce 2s + 30s timer (FR-DRAFT-020). Idempotency on payloadVersion (no-op repeats are free). NFR-DRAFT-001 budget gives ample headroom for 100 concurrent users. |
| Draft rows accumulate unbounded as users abandon WIP | Medium | 90-day soft expiry (FR-DRAFT-021); 50-draft per-user soft cap with UI nudge; nudge email 7 days before expiry. Operations dashboard tracks the ratio of `DRAFT`-status to active-status rows per NFR-DRAFT-003. |
| CHECK constraint reinstating NOT-NULL is bypassed by direct SQL | Low | The CHECK lives in the schema; even raw SQL inserts must satisfy it. The application-layer post pipeline validates first; the CHECK is the database safety net. Ad-hoc SQL inserts fail loudly. |
| Two editors merge through three-way UI but produce a logically invalid record | Medium | Server-side full validation runs after merge save (per FR-DRAFT-022 final step). Invalid merge is rejected; UI surfaces the validation errors. |
| Posting a draft auto-cascades unintended dependent posts | Medium | Cascade requires explicit "Post all dependent drafts too" checkbox in UI. Default is reject-with-error if dependent drafts are referenced (FR-DRAFT-031). |
| RLS policies leak through SECURITY DEFINER functions | High | Audit all SECURITY DEFINER functions for entity-table access. Default to SECURITY INVOKER. Tests cover policy enforcement under each function context. |
| Visibility changes (originator opens draft up) create audit-trail confusion | Low | Each visibility change emits a single audit row with full before/after collaborator list (FR-DRAFT-012). Auditor can reconstruct history. |
| Draft expiry discards data the user wanted to keep | Medium | Expiry transitions to `DISCARDED` with `discardReason = "EXPIRED"`, not hard delete. 30-day window in the Recently-expired tab for "Restore" (status flips back to `DRAFT`, `discardedAt` cleared). Per-tenant `draftMaxAgeDays` configurable. |
| Drafts conflict with `pending_administrative_change` semantics for same entity | Low | Documented relationship in FR-DRAFT-061 + FR-DRAFT-042: post pipeline transitions to `PENDING_APPROVAL` and creates `pending_administrative_change`; row stays read-only as draft until second approval transitions it to active. |
| `snapshotEverySave: true` audit volume explodes for high-volume entities | Low | Only enabled on low-volume high-stakes entities (rate schedules, billing-cycle parameters, retention policies, large adjustments). Service Request drafts and Customer drafts (high volume, low stakes) do not snapshot. Audit retention engine (doc 08) tiers per class. |
| Polymorphic `draft_collaborator` lacks FK enforcement | Low | Daily reconciliation job verifies every `(entity_type, entity_id)` resolves; orphans logged + removed. Collaborator rows auto-clear when row leaves draft state (FR-DRAFT-005). |

---

## 8. Acceptance criteria (consolidated)

### Engine
- [ ] Each adopted entity's status enum is extended with `DRAFT`, `PENDING_APPROVAL`, `DISCARDED`.
- [ ] Each adopted entity's table carries the shared draft-metadata columns (FR-DRAFT-002).
- [ ] Each adopted entity's existing NOT-NULL columns are relaxed with a CHECK constraint reinstating NOT-NULL when `status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'DISCARDED')`.
- [ ] Each adopted entity has a `<entity>_v` view that excludes draft/pending/discarded states.
- [ ] `draft_collaborator`, `draft_role_grant`, `draft_lock` polymorphic tables exist with RLS.
- [ ] `DraftVisibility` enum exists; default visibility is `ORIGINATOR_ONLY`.
- [ ] `withProductionScope` and `withDraftVisibility` helpers exist in `packages/api/src/lib/draft-aware.ts`; linter rule `no-raw-entity-query` enforces their use.

### Visibility
- [ ] User A's `ORIGINATOR_ONLY` draft (status `DRAFT`) is invisible to User B in the same tenant.
- [ ] Adding User B as `editor` collaborator makes the draft visible and editable for B.
- [ ] `SHARED_WITH_ROLE` draft is visible to all role members and no one else.
- [ ] `TENANT_WIDE` draft is visible to all users with the entity's read permission.
- [ ] Tenant admin with `drafts.admin` permission can see all drafts.
- [ ] Production list/search endpoints return zero `DRAFT`/`PENDING_APPROVAL` rows under any visibility scenario.
- [ ] Posted rows ARE visible to all users with the entity's read permission (the visibility predicate gates DRAFT only, not active states).

### Autosave
- [ ] Field change → server save in ≤500ms p99 (NFR-DRAFT-001).
- [ ] Two editors saving concurrently with stale `payloadVersion` → 409 → three-way merge.
- [ ] Network unavailable → IndexedDB queue → flush on reconnect.
- [ ] 30-second timer triggers save even without keystroke.

### Posting
- [ ] `POST /api/v1/<entity>/<id>/post` runs a single transactional `UPDATE` setting status to the entity's first-active state plus `postedAt`/`postedBy`.
- [ ] Draft with validation errors cannot post; UI lists errors with field navigation.
- [ ] CHECK constraint catches any attempt to post a row with required fields still null.
- [ ] High-stakes entity (rate schedule) posting transitions to `PENDING_APPROVAL` and creates `pending_administrative_change`. Second approval transitions to active.
- [ ] Cascade post handles dependent drafts in topological order; failure rolls back all (Postgres transaction abort).
- [ ] Worker crash mid-post leaves the row either fully draft or fully posted — never both, never neither.

### Exclusion
- [ ] No scheduler reads `DRAFT`/`PENDING_APPROVAL`/`DISCARDED` rows (verified by code grep + integration test against the linter rule).
- [ ] Reports and dashboards read from `<entity>_v` views; verify with EXPLAIN.
- [ ] Custom-fields engine (doc 06) excludes drafts from CSV exports and OpenAPI variant.
- [ ] FK validation: creating a `ServiceAgreement` with a `customerId` referencing a `DRAFT`-status customer is rejected at application layer; trigger catches at DB layer.

### Audit
- [ ] Per-keystroke saves emit no audit rows.
- [ ] Lifecycle events (CREATE, VISIBILITY_CHANGE, POST, DISCARD, EXPIRE) emit audit rows of class `AUDIT_OPERATIONAL`.
- [ ] High-stakes entities with `snapshotEverySave: true` emit one `DRAFT_SAVED` audit row per save with before/after diff.

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
