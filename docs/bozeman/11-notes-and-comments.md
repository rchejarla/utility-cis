# 11 — Notes & Comments

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (single polymorphic `comment` table + `comment_mention` junction + FTS column), `packages/api/src/services/comment.service.ts` (CRUD + mention extraction + notification fan-out), `packages/api/src/routes/comments.ts` (REST endpoints), `packages/web/components/comments/*` (Markdown editor, comment thread, mention picker), and the existing notification infrastructure ([13-notifications.md](../specs/13-notifications.md)) extended with an `IN_APP` channel. Cross-cuts deeply with [04-attachments.md](./04-attachments.md) (the polymorphic Attachment model is reused — adding `Comment` as another `entityType`), [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) (every comment CRUD emits an audit row via the standard wrapper), [05-customer-portal.md](./05-customer-portal.md) (customer-visible comments surface in the portal as "Messages from Utility"), [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) (comments themselves can be drafts on high-stakes entities — but in practice this isn't needed; comments are short and post-immediately), and the existing FTS infrastructure used on Customer/Premise/Account/Meter (the same tsvector + GIN pattern extends to comment search).
**Status:** Drafted — no implementation. **No `Comment` or `Note` entity exists.** Eight entities have scattered free-text columns (`Meter.notes`, `MeterEvent.resolutionNotes`, `MeterRead.exceptionNotes`, `ServiceEvent.notes`, `Container.locationNotes`, `ServiceRequest.resolutionNotes`, `DelinquencyAction.notes`, `ServiceSuspension.reason`) — these are plain `TEXT` columns with no structure, no history, no search, no attachments, no visibility flag, no mentions. There is no rich-text editor library anywhere in `packages/web/` (no `tiptap`, `quill`, `lexical`, `slate`, `prosemirror`, or markdown renderer). There is no `@`-mention parsing infrastructure. There is no in-app inbox or notification bell.
**Effort estimate:** M (~3-4 weeks engineering). The substrate is small — one polymorphic comment table + one mention junction + one new attachment entity-type allowlist entry. The bulk of the work is the Markdown editor integration (~1 week including the mention picker + Tiptap setup), the in-app notification channel (~3 days), and per-entity adoption (~2 days per entity for thread UI).

---

## 1. RFP commitment (verbatim)

> Notes/comments are first-class on all major entities. Comments support rich text, @-mentions of other users (which generate notifications), file attachments, internal-only vs. customer-visible flags, and full audit history. Comments are indexed for search.

The commitment decomposes into **seven guarantees**:

1. **First-class entity** — comments are a real model with their own CRUD, lifecycle, and audit trail. Not a free-text column.
2. **All major entities** — Customer, Account, Premise, Meter, ServiceAgreement, ServiceRequest, Adjustment (when built), plus reasonable expansion to BillingCycle, RateSchedule, Payment.
3. **Rich text** — bold/italic/lists/links/code at minimum. Not raw HTML (XSS risk); not a hand-rolled WYSIWYG.
4. **@-mentions** — typing `@<name>` resolves to a user reference; on save, mentioned users get a notification.
5. **File attachments** — comments can attach files (reuse the existing Attachment infrastructure from [04-attachments.md](./04-attachments.md)).
6. **Internal-only vs. customer-visible flag** — internal CSR notes never reach the portal; customer-visible comments do.
7. **Full audit history** — every create/edit/delete is audit-logged with before/after state.
8. **Indexed for search** — global "find comments mentioning 'pump failure'" returns results across all parent entity types.

This doc defines the **comment substrate** as a single polymorphic table — not per-entity comment tables. (Following the same architectural lesson learned in [10-draft-status-and-posting.md](./10-draft-status-and-posting.md): single-table-with-status beats parallel-tables when the lifecycle is the same and the cross-cutting concern is real.)

---

## 2. Current state — what exists today

### 2.1 No comment/note infrastructure

**Status: Not implemented.** A grep across `packages/shared/prisma/schema.prisma` for `model Comment`, `model Note`, `model Annotation`, `model Memo`, `model Remark` returns zero matches. There is no parent-child relationship anywhere in the schema for free-text annotations on entities.

### 2.2 Scattered free-text columns serve as a poor substitute

**Status: Partial — eight entities have ad-hoc `notes`-like columns.**

| Entity | Column | Type | Limitations |
|---|---|---|---|
| `Meter` | `notes` (line 292) | `TEXT` | One row per meter; overwriting deletes prior history |
| `MeterEvent` | `resolutionNotes` (line 787) | `TEXT` | Single field; overwrites |
| `MeterRead` | `exceptionNotes` (line 480) | `TEXT` | Single field |
| `ServiceEvent` | `notes` (line 1002) | `TEXT` | Single field |
| `Container` | `locationNotes` (line 830) | `TEXT` | Single field |
| `ServiceRequest` | `resolutionNotes` (line 1296) | `TEXT` | Single field — every CSR who edits the SR replaces prior text |
| `DelinquencyAction` | `notes` (line 1172) | `TEXT` | Single field |
| `ServiceSuspension` | `reason` (line 942) | `TEXT` | Single field |

Every one of these is a single field that the next editor overwrites. There is no per-comment author, no timestamp per comment, no structured history (the audit log captures the last edit but not the chain of who-said-what). They cannot be searched globally, do not support attachments, do not distinguish internal from customer-visible, do not trigger notifications.

The scattered model also doesn't scale to the RFP's claim of "first-class on all major entities" — `Customer`, `Account`, `Premise`, `ServiceAgreement` have no notes field at all today.

### 2.3 No rich-text editor

**Status: Not implemented.**

A grep across `packages/web/package.json` and the rendered package tree returns zero rich-text editor dependencies. None of: `tiptap`, `quill`, `slate`, `lexical`, `draft-js`, `react-rte`, `prosemirror-*`, `@tiptap/*`, `@blocknote/*`. No Markdown rendering libraries either: no `react-markdown`, `remark`, `rehype`, `marked`, `micromark`, `markdown-it`.

The custom-fields engine ([06-custom-fields.md](./06-custom-fields.md)) defines its data types as `["string", "number", "date", "boolean", "enum"]` — no rich-text or long-form-text type. Plain `<textarea>` is the only existing free-text input.

### 2.4 No @-mention infrastructure

**Status: Not implemented.**

Zero mention-parsing code anywhere. No `@username` tokens, no mention resolution, no integration with `CisUser` for typeahead suggestions. The notification system (`packages/api/src/services/notification.service.ts`) supports template variable substitution (`{{customer.firstName}}`) but not mention-driven notifications.

### 2.5 No in-app notification channel

**Status: Not implemented.**

The current `Notification` model (`schema.prisma:1088-1119`) supports `EMAIL` and `SMS` channels via templates. There is no `IN_APP` channel. No bell-icon UI, no inbox page, no unread-count badge anywhere in the admin or portal surfaces. Mention-driven notifications need this infrastructure as a precondition.

### 2.6 Attachment model is polymorphic and ready to extend

**Status: Reusable.** The existing `Attachment` model uses `entityType: String @db.VarChar(100)` + `entityId: String @db.Uuid` to support multiple parent types polymorphically. Today the allowlist (`packages/shared/src/modules/constants.ts`, per [04-attachments.md](./04-attachments.md) §2) is `["Customer", "Account", "Premise", "Meter", "ServiceAgreement", "RateSchedule", "BillingCycle"]`. Adding `"Comment"` to the allowlist is a one-line change. The same upload endpoint, same audit pipeline, same MIME-type validation, same retention class apply.

[04-attachments.md](./04-attachments.md) commits to extending the allowlist to include `ServiceRequest` and `Adjustment` in Phase 1 of that doc; this doc adds `Comment`.

### 2.7 No internal-vs-customer-visible flag pattern

**Status: Not implemented.** No entity in the schema has `isInternal`, `customerVisible`, or `visibility` (in the privacy sense — [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) introduces `visibility` for draft scoping, but that's a different concern). Today, "internal vs customer" is enforced module-by-module via RBAC: the customer portal sees its own modules; admin sees its own modules. There is no per-row visibility flag.

The closest analog is `Notification.recipientType` (CUSTOMER vs USER) but this is for delivery channel, not for hiding/showing content.

### 2.8 Audit infrastructure is ready to wrap comments

**Status: Reusable.** The existing `auditCreate` / `auditUpdate` / `auditDelete` wrappers in `packages/api/src/lib/audit-wrap.ts` work for any Prisma model. Wrapping `Comment` CRUD with the wrapper auto-emits `audit_log` rows of class `AUDIT_OPERATIONAL` with `before_state` + `after_state`. No new infrastructure required.

### 2.9 FTS infrastructure is ready to extend

**Status: Reusable.** The migration at `packages/shared/prisma/migrations/20260423021900_fts/migration.sql` adds `tsvector` generated columns + GIN indexes on `customer`, `premise`, `account`, `meter`. The same pattern applies to comments — one generated column, one GIN index, one search endpoint that joins to the parent entity.

### 2.10 Customer portal — current surface

**Status: Comment-receiving capability does not exist.** Per [docs/specs/15-customer-portal.md](../specs/15-customer-portal.md), Phase 4.1 (current) has dashboard, bills, usage, profile, account detail. Phase 4.3 will add service request submission. There is no inbox page, no message thread, no portal-visible-comment surface today.

[05-customer-portal.md](./05-customer-portal.md) (the Bozeman portal RFP doc) commits to "in-portal messaging" as part of the broader portal communication scope, with email + SMS + in-portal + web push + voice channels. **Customer-visible comments from this doc surface there.** "In-portal messaging" in the portal RFP doc is the subset of comments where `isInternal = false`.

### Summary

| Guarantee | Today |
|---|---|
| First-class comment entity | ✗ |
| Coverage on major entities | ✗ (scattered ad-hoc `notes` columns on 8 entities) |
| Rich text | ✗ (no editor library; plain textareas only) |
| @-mentions with notifications | ✗ |
| File attachments on comments | ⚠ (Attachment model is polymorphic; allowlist doesn't include Comment yet) |
| Internal-only vs customer-visible | ✗ |
| Audit history | ✓ (framework ready; needs Comment model to wrap) |
| Search-indexed | ✓ (FTS pattern proven; needs Comment model to extend) |
| In-app notification channel | ✗ |
| Customer portal visibility surface | ✗ |

---

## 3. Functional requirements

### 3.1 Comment substrate — single polymorphic table

- **FR-COMMENT-001** — A single `comment` table covers comments on every entity type. Polymorphic via `(entityType, entityId)` — same pattern as the existing `attachment` table:

  ```prisma
  model Comment {
    id              String          @id @default(uuid()) @db.Uuid
    utilityId       String          @map("utility_id") @db.Uuid
    entityType      String          @map("entity_type") @db.VarChar(64)  // "customer" | "account" | "premise" | "meter" | "service_agreement" | "service_request" | "adjustment" | ...
    entityId        String          @map("entity_id") @db.Uuid
    body            String          @db.Text                              // Markdown source
    bodyRendered    String?         @map("body_rendered") @db.Text        // sanitized HTML, computed at write time
    isInternal      Boolean         @default(true)                        // true = admin-only; false = portal-visible
    parentCommentId String?         @map("parent_comment_id") @db.Uuid    // optional thread reply (deferred — see §6 out-of-scope)
    authorId        String          @map("author_id") @db.Uuid
    createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz
    updatedAt       DateTime        @updatedAt @map("updated_at") @db.Timestamptz
    editedAt        DateTime?       @map("edited_at") @db.Timestamptz     // null on first save; set on subsequent edits
    deletedAt       DateTime?       @map("deleted_at") @db.Timestamptz    // soft-delete
    deletedBy       String?         @map("deleted_by") @db.Uuid
    deletedReason   String?         @map("deleted_reason")
    searchVector    Unsupported("tsvector")?                              // GENERATED column for FTS

    @@index([utilityId, entityType, entityId, createdAt])  // primary read pattern
    @@index([utilityId, authorId])
    @@index([utilityId, isInternal, createdAt])             // portal "my recent customer-visible messages" feed
    @@map("comment")
  }
  ```

  **Why one table, not per-entity tables:** Comments are a true cross-cutting concern. The set of operations is identical across entity types (CRUD + mention + attachment + audit + search). Per-entity tables would mean one schema migration per entity, one RLS policy per entity, and N service functions doing identical work. The existing `attachment` table proves this pattern works here. (Cross-reference: this is the same architectural decision validated in [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) §3.1.1 — single-table-with-status beat parallel tables for drafts.)

  Polymorphism without FK enforcement is the trade-off. Mitigation: a daily reconciliation job verifies every `(entity_type, entity_id)` resolves to a real row; orphans are logged and soft-deleted. The reconciliation is identical to the one already specified for `draft_collaborator` in [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) FR-DRAFT-005.

- **FR-COMMENT-002** — `entityType` allowlist enforced at the application layer. A new file `packages/shared/src/modules/comment-entity-types.ts` exports the canonical set:

  ```typescript
  export const COMMENT_ENTITY_TYPES = [
    "customer",
    "account",
    "premise",
    "meter",
    "service_agreement",
    "service_request",
    "adjustment",        // Module 10 — when built
    "billing_cycle",
    "rate_schedule",
    "payment",           // Module 10
  ] as const;
  ```

  Submitting a comment with an `entityType` outside the allowlist returns 422.

- **FR-COMMENT-003** — `comment_mention` junction table tracks @-mentions structurally. Markdown source carries a `@[Display Name](user-id)` reference (Markdown extended-link syntax — renders as a profile link, parses as a mention). The mention parser extracts user IDs and writes one `comment_mention` row per mention:

  ```prisma
  model CommentMention {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    commentId   String   @map("comment_id") @db.Uuid
    mentionedUserId String @map("mentioned_user_id") @db.Uuid
    notifiedAt  DateTime? @map("notified_at") @db.Timestamptz  // null until the notification job picks it up
    createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

    comment Comment @relation(fields: [commentId], references: [id], onDelete: Cascade)
    @@unique([commentId, mentionedUserId])
    @@index([utilityId, mentionedUserId, notifiedAt])
    @@map("comment_mention")
  }
  ```

  Storing mentions structurally (not just parsing at render time) handles user renames cleanly — display names resolve to the current `CisUser.firstName + lastName` at render; the underlying `mentioned_user_id` never changes.

- **FR-COMMENT-004** — RLS on `comment` enforces tenant isolation via the existing `app.current_utility_id` predicate. Additionally, when a comment is read in a portal-user context (the request's actor is a `CisUser` with `customerId IS NOT NULL`), the predicate also enforces:
  - `isInternal = false` (portal users see only customer-visible comments)
  - The comment's parent entity (`entityType`, `entityId`) belongs to the customer's account graph (a customer can't see comments on another customer's premise even if the tenant is shared)

  Helper SQL function `is_comment_visible_to_portal_user(comment_id, customer_id)` is invoked from the RLS policy.

### 3.2 Rich text — Markdown source, sanitized HTML render

- **FR-COMMENT-010** — Comments are stored as **Markdown source** (`body` column) plus a server-rendered **sanitized HTML cache** (`bodyRendered` column). Why this split:
  - Markdown is the safe default — no raw HTML, no XSS surface, predictable rendering, easy to migrate between editors.
  - Server-side sanitization gives one definitive render that the API can return; clients render the cached HTML rather than re-parsing Markdown N times.
  - The Markdown source is the source of truth for editing; the rendered HTML is derived state.

- **FR-COMMENT-011** — Supported Markdown subset:
  - Bold, italic, strikethrough
  - Inline code, fenced code blocks
  - Bulleted lists, numbered lists
  - Links (auto-linkify URLs; explicit `[text](url)` syntax)
  - Blockquotes
  - Line breaks (paragraph + soft-break)
  - Headings — disabled (a comment is not a document)
  - Tables — disabled (rare in operational notes; use a list instead)
  - Images — disabled (use the attachment mechanism per FR-COMMENT-030)
  - Raw HTML — disabled (XSS surface)
  - Mention syntax: `@[Display Name](user:user-id)` — parsed by the comment service into `comment_mention` rows.

- **FR-COMMENT-012** — Server-side rendering uses `unified` + `remark-parse` + `remark-gfm` (limited) + `rehype-sanitize` with a strict allowlist matching FR-COMMENT-011. Output is HTML stored in `bodyRendered` and served alongside `body`. Re-render is triggered on every save (cheap; comments are small).

- **FR-COMMENT-013** — Web app integrates a **Tiptap-based** editor (`@tiptap/react` + selected extensions matching FR-COMMENT-011). Tiptap was chosen because:
  - It's actively maintained (last release within 30 days)
  - Markdown-first via the `tiptap-markdown` extension
  - First-class `@`-mention extension with typeahead
  - Explicit allowlist of nodes/marks (matches our content policy)
  - Bundle size is acceptable (~80KB minified gzipped for the subset we need)

  The component lives at `packages/web/components/comments/comment-editor.tsx` and is reused across every entity's comment thread. Theme tokens come from the existing `tenant_theme` (per [docs/specs/18-theme-and-configuration.md](../specs/18-theme-and-configuration.md)) so editor colors match the tenant brand.

- **FR-COMMENT-014** — Mobile read view (per [02-mobile-and-responsive-ui.md](./02-mobile-and-responsive-ui.md)): comment threads render as scrollable lists; rich-text formatting renders correctly at 320px. Mobile editing is supported (Tiptap is touch-aware) but the toolbar collapses to a compact dropdown.

### 3.3 @-mentions and notifications

- **FR-COMMENT-020** — When a comment is saved, the comment service:
  1. Parses the Markdown body for mention syntax `@[Display Name](user:user-id)`.
  2. Resolves each `user-id` against the `CisUser` table — rejects if any ID doesn't exist or doesn't belong to the same tenant.
  3. Writes one `comment_mention` row per unique mentioned user.
  4. Enqueues a `mention-notification` BullMQ job (added to the existing notification queue per [13-notifications.md](../specs/13-notifications.md)).

- **FR-COMMENT-021** — The `mention-notification` worker:
  1. For each `comment_mention` with `notifiedAt IS NULL`, generates a notification using a new template `COMMENT_MENTION` (added to `notification_template`).
  2. Sends via the channels the mentioned user has enabled in their preferences — at minimum `IN_APP` (FR-COMMENT-040); optionally `EMAIL` if the user has email notifications on for mentions.
  3. Sets `comment_mention.notifiedAt` on success.
  4. Failed sends stay with `notifiedAt = NULL` and are retried by the worker per the existing notification retry policy ([13-notifications.md](../specs/13-notifications.md)).

- **FR-COMMENT-022** — Mention-typeahead: as the user types `@` followed by characters, the editor queries `GET /api/v1/users/search?q=<partial>` and renders a dropdown of matches. The search hits the existing `cis_user` table filtered by tenant + active status + matching first/last/email. Bounded to 10 results.

- **FR-COMMENT-023** — Mentioning a portal user (a `CisUser` with `customerId IS NOT NULL`) is permitted but issues a **warning** in the editor: *"You are mentioning a customer portal user. They will see this comment only if it is marked customer-visible. Continue?"* The author confirms or backs out. This prevents the common mistake of `@`-ing a customer in an internal-only comment that the customer will never see (and that the customer's notification, when delivered, will then dead-link).

- **FR-COMMENT-024** — Self-mentions are silently filtered — mentioning yourself does not create a `comment_mention` row or notification.

### 3.4 File attachments on comments

- **FR-COMMENT-030** — The existing `attachment` table is reused. `Comment` is added to the `attachment.entity_type` allowlist (per [04-attachments.md](./04-attachments.md) §3) — a one-line addition to `packages/shared/src/modules/attachment-entity-types.ts`. No schema change to the attachment table itself.

- **FR-COMMENT-031** — The comment editor exposes a "Attach file" toolbar action that uploads via the existing `POST /api/v1/attachments` endpoint with `entityType = "comment"` and `entityId = <new-comment-id>`. Comment creation is a two-step flow:
  1. Client submits comment body → server creates `comment` row → returns `commentId`.
  2. Client uploads attachments with `entityId = commentId`.

  Alternatively (preferred for UX), the client uploads the attachment first to a tenant-scoped staging bucket, then submits the comment with attachment references; the server promotes staged attachments to `entityId = commentId` atomically. Implementation detail — both flows are valid; the second is the default.

- **FR-COMMENT-032** — Attachments inherit the parent comment's `isInternal` flag. A customer-visible comment's attachments are downloadable from the portal; an internal comment's attachments are admin-only.

- **FR-COMMENT-033** — The MIME allowlist for comment attachments is the same as for general attachments per [04-attachments.md](./04-attachments.md) §3.3. Same per-tenant size limits, same retention class, same lifecycle archival.

### 3.5 Internal-only vs. customer-visible flag

- **FR-COMMENT-040** — `Comment.isInternal` defaults to `true`. Setting `false` (customer-visible) requires the author to hold a permission `comments.write_customer_visible` distinct from `comments.write`. Reasoning: a junior CSR can leave internal notes freely; making something appear in the customer portal is a stronger right that should be controlled.

- **FR-COMMENT-041** — Once a comment is `isInternal = false`, **it cannot be flipped back to internal**. The customer may have already seen it; pretending it was always internal is a privacy lie. To remove it from the portal, edit or delete the comment (both audit-logged).

- **FR-COMMENT-042** — Comments with `isInternal = false` on a parent entity that the customer has portal access to (i.e., the entity is in the customer's account graph) appear in:
  - The portal's "Messages" page as a unified inbox sorted by `createdAt DESC`.
  - Inline on the relevant portal page (e.g., a customer-visible comment on `service_request` X appears on the portal's SR-detail view).
  - The portal sees the comment author's display name and timestamp, never the author's email or internal role title.

- **FR-COMMENT-043** — When a customer-visible comment is created, the customer receives a notification per their preferences (email, SMS, in-portal, web push) using a new template `COMMENT_FROM_UTILITY` — added to `notification_template`. Frequency-cap rules (rate limit) apply: a tenant can't spam a customer with 50 comments in a minute by automation. Per-tenant configurable; default 10 per customer per day.

### 3.6 Audit history

- **FR-COMMENT-050** — Every comment CRUD goes through the existing `auditCreate` / `auditUpdate` / `auditDelete` wrappers in `packages/api/src/lib/audit-wrap.ts`. This auto-emits `audit_log` rows of class `AUDIT_OPERATIONAL` with `entityType = "comment"`, `entityId = <comment_id>`, `actorId`, `before_state`, `after_state`.

- **FR-COMMENT-051** — Comment edits are visible to readers via a "edited" indicator + tooltip showing `editedAt` and the editor's name. Diff view (showing what changed) is available to admins via `GET /api/v1/comments/<id>/audit` — the endpoint reads `audit_log WHERE entity_type = 'comment' AND entity_id = <id>` and returns ordered before/after states.

- **FR-COMMENT-052** — Soft-delete: deleting a comment sets `deletedAt`, `deletedBy`, `deletedReason` and emits an audit row. The soft-deleted comment shows in the thread as `*This comment was deleted by <user> on <date>.*` to preserve the conversation flow without exposing the deleted content. Hard-delete is restricted to the retention engine ([08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md)) per the entity's retention class.

- **FR-COMMENT-053** — Customer-visible comments have a stricter audit: any edit to a `isInternal = false` comment that has been delivered to the customer (i.e., `comment_notification.deliveredAt` is set) emits an `AUDIT_SECURITY` row in addition to `AUDIT_OPERATIONAL`. Editing public-facing communications is a sensitive action because customers may have already read the original.

### 3.7 Search

- **FR-COMMENT-060** — `Comment.searchVector` is a generated `tsvector` column over `body`:

  ```sql
  ALTER TABLE comment ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(body, ''))
  ) STORED;

  CREATE INDEX comment_search_idx ON comment USING GIN(search_vector);
  ```

  Same pattern as the existing FTS indexes on `customer`, `premise`, `account`, `meter`. `simple` configuration matches the existing pattern (no language-specific stemming — utility CSR notes contain a lot of proper nouns and codes that stemming would mangle).

- **FR-COMMENT-061** — `GET /api/v1/comments/search?q=<query>&entity_type=<optional>&internal_only=<optional>&author=<optional>` returns matching comments (paginated, max 100). Filters:
  - `q` — full-text query (required)
  - `entity_type` — filter to comments on a specific parent type
  - `internal_only` — `true` (admins viewing internal traffic) | `false` (customer-visible only) | unset (both)
  - `author` — filter to a specific user's comments
  - `since`, `until` — date bounds

  Result includes parent-entity context (entity type + id + a brief denormalized label like account number or SR number) so the UI can render results with breadcrumbs.

- **FR-COMMENT-062** — Search is permission-checked. Internal comments are filtered out for portal users by RLS (FR-COMMENT-004); admins see everything subject to module-level read permissions. A CSR with no `service_request.read` permission does not see comments on service requests in their search results.

- **FR-COMMENT-063** — A unified "Notes search" page lives at `/search/notes` in the admin app, with a single text box and the filter sidebar. Drilling into a result navigates to the parent entity's page with the comment scrolled into view and highlighted.

### 3.8 In-app notifications (`IN_APP` channel)

- **FR-COMMENT-070** — Extend the `notification_channel` enum with `IN_APP` (currently `EMAIL`, `SMS`):

  ```prisma
  enum NotificationChannel {
    EMAIL
    SMS
    IN_APP   // NEW
  }
  ```

  An in-app notification is a `Notification` row with `channel = IN_APP`, no external delivery (no email/SMS gateway call), `sentAt = createdAt` (delivery is reading from the table). The recipient is identified by `recipientId` (a `CisUser.id`).

- **FR-COMMENT-071** — A bell-icon UI component in both the admin top bar and the portal top bar polls `GET /api/v1/notifications/inbox?unread=true&limit=20` every 30 seconds (or via Server-Sent Events for tenants that opt in). The badge shows the unread count.

- **FR-COMMENT-072** — Clicking the bell opens a panel with the unread + recently-read notifications. Each row shows the notification content, source comment link, timestamp, and a "Mark as read" action. Marking sets `notification.readAt`.

- **FR-COMMENT-073** — A standalone `/inbox` page in both surfaces shows the full notification history (paginated). Filters by channel, source (mention | comment-from-utility | other), date range, read/unread.

- **FR-COMMENT-074** — Per-user notification preferences (per [13-notifications.md](../specs/13-notifications.md)) are extended with a per-event-type matrix:

  | Event | Default channel(s) |
  |---|---|
  | `COMMENT_MENTION` | `IN_APP` (always); `EMAIL` (off by default; user opts in) |
  | `COMMENT_FROM_UTILITY` (portal users) | `EMAIL` + `IN_APP` (default); `SMS` (off by default; user opts in) |

  Users edit their preferences in `/settings/notifications` (admin) or `/portal/settings/notifications` (portal).

### 3.9 Per-entity adoption

- **FR-COMMENT-080** — Every adopted entity's detail page renders a "Comments" section/tab via the shared `<CommentThread entityType={...} entityId={...} />` component. The component:
  - Lists comments on the entity sorted by `createdAt DESC`.
  - Renders the editor at the top for new comments.
  - Toggles "Internal only / Customer visible" for users with the appropriate permission.
  - Shows attachment thumbnails inline; drag-drop attaches to the in-progress comment.
  - Auto-refreshes every 30 seconds OR on the parent entity's WebSocket/SSE update event.

- **FR-COMMENT-081** — Adoption order:
  - **Phase 1**: ServiceRequest, Account, Customer (highest-traffic; immediate operational value).
  - **Phase 2**: Premise, Meter, ServiceAgreement, BillingCycle, RateSchedule.
  - **Phase 3** (when those modules ship): Adjustment, Payment.

  Each phase is a few days of UI work — the substrate is already in place after Phase 1's foundation.

- **FR-COMMENT-082** — The legacy free-text columns identified in §2.2 (`Meter.notes`, `MeterEvent.resolutionNotes`, etc.) are **not migrated**. They remain as legacy columns that operators can edit; the comment thread is a parallel new mechanism. After 12 months of dual operation, a separate cleanup project may migrate legacy column content into a single `Comment` row per entity (operator-triggered, audit-logged) and deprecate the columns. This is intentionally out of scope for this RFP commitment to keep the initial deliverable bounded.

### 3.10 Permissions

- **FR-COMMENT-090** — New permissions:
  - `comments.read` — view internal comments on entities the user has read access to.
  - `comments.write` — create internal comments on entities the user has read access to.
  - `comments.write_customer_visible` — create comments with `isInternal = false`.
  - `comments.edit_own` — edit own comments within a configurable edit window (default 15 minutes; per-tenant `comment_edit_window_minutes`).
  - `comments.edit_any` — edit any comment regardless of author or window (admin / supervisor).
  - `comments.delete_own` — soft-delete own comments.
  - `comments.delete_any` — soft-delete any comment.

  The default CSR role gets `comments.read` + `comments.write` + `comments.edit_own` + `comments.delete_own`. Customer-visible writes and admin-overrides are granted explicitly.

### 3.11 Non-functional requirements

- **NFR-COMMENT-001** — Comment thread load: ≤300ms p99 for an entity with up to 100 comments (the dominant case).
- **NFR-COMMENT-002** — Comment write latency (including parse + render + audit + mention extraction + notification enqueue): ≤500ms p99.
- **NFR-COMMENT-003** — Mention notification delivery latency: ≤30s p99 from comment save to in-app inbox visibility.
- **NFR-COMMENT-004** — Search query latency: ≤500ms p99 for typical free-text queries against a tenant with up to 1M comments.
- **NFR-COMMENT-005** — Sanitized HTML render is bounded — no comment may exceed 10KB of source Markdown (NotEnforced softly; rejection at 50KB hard limit).
- **NFR-COMMENT-006** — Polymorphic FK reconciliation runs daily and must complete within 10 minutes for tenants with up to 10M comments.
- **NFR-COMMENT-007** — Retention is governed by [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `OPERATIONAL_LOG` class default (2-year archive); customer-visible comments inherit the parent entity's class (`FINANCIAL` for adjustment/payment comments → 7-year minimum).

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `comment` | Polymorphic comment table for all entity types | 3.1.1 (FR-COMMENT-001) |
| `comment_mention` | One row per @-mention; drives notifications | 3.1.1 (FR-COMMENT-003) |

### 4.2 Modified tables

| Table | Change | Reason |
|---|---|---|
| `notification` | Extend `channel` enum with `IN_APP` | FR-COMMENT-070 |
| `notification` | Add `readAt` column (nullable) | Track in-app notification read state |
| `notification_template` | Add templates `COMMENT_MENTION`, `COMMENT_FROM_UTILITY` | FR-COMMENT-021, FR-COMMENT-043 |
| `attachment` | (No schema change.) Allowlist constant in code adds `"comment"` to entity types | FR-COMMENT-030 |
| `tenant_config` | Add `comment_edit_window_minutes` (default 15), `comment_max_size_kb` (default 10), `comment_customer_facing_rate_limit_per_day` (default 10) | FR-COMMENT-090, NFR-COMMENT-005, FR-COMMENT-043 |

### 4.3 New SQL helpers

```sql
-- For RLS policy on comment table
CREATE OR REPLACE FUNCTION is_comment_visible_to_portal_user(
  p_entity_type text, p_entity_id uuid, p_customer_id uuid
) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY INVOKER
AS $$
BEGIN
  RETURN CASE p_entity_type
    WHEN 'customer'          THEN p_entity_id = p_customer_id
    WHEN 'account'           THEN EXISTS (SELECT 1 FROM account WHERE id = p_entity_id AND customer_id = p_customer_id)
    WHEN 'premise'           THEN EXISTS (SELECT 1 FROM account a JOIN premise p ON p.id = p_entity_id WHERE a.customer_id = p_customer_id /* via SA */)
    WHEN 'service_agreement' THEN EXISTS (SELECT 1 FROM service_agreement sa JOIN account a ON a.id = sa.account_id WHERE sa.id = p_entity_id AND a.customer_id = p_customer_id)
    WHEN 'service_request'   THEN EXISTS (SELECT 1 FROM service_request sr JOIN account a ON a.id = sr.account_id WHERE sr.id = p_entity_id AND a.customer_id = p_customer_id)
    -- ... (one branch per allowlist entry)
    ELSE FALSE
  END;
END;
$$;
```

### 4.4 RLS policy

```sql
ALTER TABLE comment ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_with_portal_visibility ON comment
  USING (
    utility_id = current_setting('app.current_utility_id')::uuid
    AND deleted_at IS NULL  -- soft-deleted comments hidden by default
    AND (
      -- Admin/CSR users (no customerId attached): see everything in tenant
      current_setting('app.current_customer_id', TRUE) IS NULL
      OR (
        -- Portal users: only customer-visible + own account graph
        is_internal = false
        AND is_comment_visible_to_portal_user(entity_type, entity_id, current_setting('app.current_customer_id')::uuid)
      )
    )
  );
```

`app.current_customer_id` is a new session local set by the API when the request comes from a portal user (existing JWT `customer_id` claim).

### 4.5 FTS migration

```sql
ALTER TABLE comment ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(body, ''))
) STORED;

CREATE INDEX comment_search_idx ON comment USING GIN(search_vector);
```

---

## 5. Implementation sequence

### Phase 1 — Substrate (~1.5 weeks)

1. **`comment` + `comment_mention` schema + RLS + FTS index** (~2 days). Migrations, RLS policy, FTS column, helper SQL function.
2. **Comment service + REST endpoints** (`packages/api/src/services/comment.service.ts`, `routes/comments.ts`) (~3 days). CRUD, mention extraction, audit wrapping, attachment-allowlist update.
3. **Tiptap editor integration** (`packages/web/components/comments/comment-editor.tsx`) (~3 days). Markdown source, sanitized render, mention typeahead, toolbar with Markdown subset only.
4. **`<CommentThread />` component** (~2 days). List view, write view, attachment drag-drop, internal/customer-visible toggle.

### Phase 2 — Notifications (~1 week)

5. **`IN_APP` channel + bell-icon UI** (~3 days). Schema extension, polling endpoint, top-bar component for both admin and portal.
6. **Mention-notification worker + `COMMENT_MENTION` template** (~2 days). Reuse the existing notification infrastructure.
7. **Customer-visible comment notification + `COMMENT_FROM_UTILITY` template** (~2 days). Email + in-portal delivery; SMS opt-in.

### Phase 3 — Adoption (~1 week)

8. **Adopt on ServiceRequest, Account, Customer** (~3 days; ~1 day each for the entity detail page + tab).
9. **Adopt on Premise, Meter, ServiceAgreement, BillingCycle, RateSchedule** (~3 days).
10. **`/search/notes` admin page + portal "Messages" page** (~2 days).

### Phase 4 — Polish (~3 days)

11. **Permissions audit, edit-window enforcement, rate limit enforcement** (~1 day).
12. **Operational dashboard widgets** (~1 day) — comment volume per entity per tenant, customer-visible comment delivery rate, mention notification latency.
13. **Documentation + acceptance test** (~1 day).

**Total: ~3.5 weeks** with one engineer; ~2.5 weeks with two parallel tracks (Phase 2 notification work and Phase 3 adoption can overlap once Phase 1 ships).

When [10-draft-status-and-posting.md](./10-draft-status-and-posting.md)'s draft engine ships, comments could optionally support draft-before-post. We deliberately do **not** commit this in the initial scope — comments are short, single-author, and don't benefit from autosave-and-collaborative-edit. Posting a comment is the natural unit; if the author drafts something significant they can use a scratch document elsewhere and paste it in.

---

## 6. Out of scope

1. **Threaded replies** — `parentCommentId` is on the schema for forward-compatibility but the UI shows a flat list. Threading is Phase 5 if user research demands it.
2. **Real-time co-presence** — multiple operators viewing the same comment thread don't see each other's cursors or typing indicators. The 30-second poll is sufficient.
3. **Reactions / emoji responses** — operators cannot react to comments with thumbs-up etc. Phase 5.
4. **Comment templates / canned responses** — no library of pre-written CSR responses. Operators can build their own external snippet store.
5. **Comment translations** — no automatic translation between languages. Out of scope.
6. **Voice notes / audio comments** — not supported. Use a file attachment if necessary.
7. **External-system comment ingestion** — comments cannot be created via SFTP imports or third-party API integrations. Comments are author-driven; the author's identity matters.
8. **Comment migration from legacy free-text columns** — per FR-COMMENT-082, the legacy `Meter.notes`, `ServiceRequest.resolutionNotes` etc. columns are not migrated to comment rows. Cleanup is a separate post-RFP project.
9. **Mention groups / aliases** — `@team-billing` does not expand to a list of users. Phase 5 if requested.
10. **Pinned comments** — operators cannot mark a comment as "pinned to the top of the thread." Comments sort by `createdAt DESC`, full stop.
11. **Comment redaction (preserved deletion with content stripped)** — the soft-delete mechanism replaces the visible body with a tombstone (FR-COMMENT-052); finer-grained per-word redaction (e.g., redact a phone number from an otherwise valid comment) is Phase 5.
12. **Bidirectional customer reply** — the customer cannot reply to a customer-visible comment from the portal. Customer-initiated communication uses the service request submission flow (per [05-customer-portal.md](./05-customer-portal.md) §4 SR intake) or contact preferences (per the portal's communication settings). Two different intent paths.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| XSS via crafted Markdown | **Critical** | `rehype-sanitize` with strict allowlist (FR-COMMENT-012); no raw HTML; whole render pipeline tested with adversarial Markdown payloads (XSS test corpus, e.g., OWASP cheat sheet). |
| Customer sees an internal comment by mistake | **Critical** | Default `isInternal = true`; permission `comments.write_customer_visible` is separate from `comments.write`; flipping back to internal is forbidden (FR-COMMENT-041); RLS double-checks via `is_comment_visible_to_portal_user` in addition to `isInternal`. |
| `@`-mention typo creates ghost notification | Medium | Mention syntax stores `user-id`, not display name (FR-COMMENT-003); on save the parser rejects unknown IDs with 422. The editor's typeahead always inserts a valid ID — typing `@` + a name without selecting from the dropdown produces literal text, not a mention. |
| Mention-notification spam (operator over-mentions) | Medium | Self-mentions filtered (FR-COMMENT-024); per-tenant rate limit on mentions per author per hour (default 50); audit-log volume of `COMMENT_MENTION` events feeds an operations dashboard for outlier detection. |
| Customer-visible comment is sent to wrong customer (FK polymorphism gone wrong) | High | `is_comment_visible_to_portal_user` SQL function verifies the parent entity belongs to the requesting customer's account graph (FR-COMMENT-004); polymorphic-FK reconciliation job runs daily (FR-COMMENT-001 mitigation); integration tests cover the full graph traversal per entity type. |
| Tiptap or remark dependency CVE | Medium | Both libraries have active security teams; pinned versions in `package.json`; weekly Renovate sweep + monthly snyk audit; custom HTML sanitizer is the final defense. |
| FTS index bloat on a high-volume tenant | Medium | `comment.search_vector` is `STORED` (not indexed lazily); index uses GIN with `fastupdate=on` for write performance. Operations dashboard tracks index size per tenant. Per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md), 2-year retention archives old comments to Parquet — FTS shrinks back as old data leaves the hot table. |
| In-app notification badge polling overwhelms server | Low | 30-second poll cadence per active user; bounded by typical concurrent operator count (~hundreds per tenant). SSE option for tenants with thousands of concurrent operators. |
| Comment edit window is too short / too long | Low | Per-tenant `comment_edit_window_minutes` (default 15). Power users (`comments.edit_any`) can edit beyond the window with audit. |
| Polymorphic comment table has no FK enforcement | Medium | Daily reconciliation job (FR-COMMENT-001 mitigation); orphaned comments soft-deleted with audit. Trade-off accepted for the cross-cutting benefit. |
| Customer notification rate limit is bypassed via automation | Medium | Per-tenant `comment_customer_facing_rate_limit_per_day` (FR-COMMENT-043) — the API enforces it before send; integration tests cover the bypass paths (bulk-import comments, scheduled comments). |
| `isInternal = false` flag flipped via direct SQL | Low | Audit-log immutability + `AUDIT_SECURITY` row on customer-visible flag changes (FR-COMMENT-053); the security audit is reviewed quarterly per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md). |

---

## 8. Acceptance criteria (consolidated)

### Substrate
- [ ] `comment` and `comment_mention` tables exist with RLS policies covering tenant isolation, soft-delete filtering, and portal-user visibility.
- [ ] `comment.search_vector` GIN index exists; FTS query returns matches in ≤500ms p99 against a 1M-row tenant.
- [ ] Polymorphic-FK reconciliation job is scheduled and observed to clean orphans without false positives.

### Rich text
- [ ] Comments accept Markdown source (FR-COMMENT-011 subset); reject raw HTML with 422.
- [ ] Server-rendered `bodyRendered` HTML is sanitized; OWASP XSS test corpus produces no executable content.
- [ ] Tiptap-based editor renders correctly on desktop + tablet + 320px mobile; toolbar collapses on mobile.

### @-mentions
- [ ] Typing `@<partial>` triggers typeahead querying `cis_user`; selecting a result inserts a structured mention.
- [ ] Saving a comment with one or more mentions creates `comment_mention` rows; each mentioned user receives an `IN_APP` notification within 30s p99.
- [ ] Mentioning a portal user emits a confirmation modal; mentioning a non-existent user ID returns 422.
- [ ] Self-mentions are filtered.

### Attachments
- [ ] Attaching a file to a comment creates an `attachment` row with `entity_type = 'comment'`, `entity_id = <comment_id>`.
- [ ] Customer-visible comment attachments are downloadable from the portal; internal-comment attachments are not.

### Internal vs customer-visible
- [ ] `isInternal = true` default; setting `false` requires `comments.write_customer_visible` permission.
- [ ] Once `isInternal = false`, attempting to flip back to `true` returns 422.
- [ ] Customer with portal access sees `isInternal = false` comments on their own account graph; cannot see any internal comments or comments on other customers.
- [ ] Customer receives `COMMENT_FROM_UTILITY` notification (per their preferences) when a customer-visible comment is created on their account graph.

### Audit
- [ ] Every CRUD on `comment` emits an `audit_log` row of class `AUDIT_OPERATIONAL`.
- [ ] Edits to delivered customer-visible comments emit an additional `AUDIT_SECURITY` row (FR-COMMENT-053).
- [ ] Soft-deleted comments appear in the thread as a tombstone; the deleted body is queryable via `audit_log` for forensics.

### Search
- [ ] `GET /api/v1/comments/search?q=...` returns matches across all entity types the requester has read permission on.
- [ ] Portal users searching see only customer-visible comments on their own graph.
- [ ] Search results include parent entity context for navigation.

### In-app notifications
- [ ] `notification.channel` enum includes `IN_APP`.
- [ ] Bell-icon shows unread count; clicking shows recent notifications; `/inbox` page shows full history.
- [ ] Per-user preferences for `COMMENT_MENTION` and `COMMENT_FROM_UTILITY` are configurable.

### Per-entity adoption
- [ ] `<CommentThread />` is integrated on ServiceRequest, Account, Customer (Phase 1) and on Premise, Meter, ServiceAgreement, BillingCycle, RateSchedule (Phase 2).
- [ ] Adjustment + Payment adoption is committed in writing pending Module 10 build.

### Permissions
- [ ] Seven new permissions exist (FR-COMMENT-090); CSR default role gets four; customer-facing writes and admin overrides are explicit.

### Non-functional
- [ ] Thread load ≤300ms p99 on entities with up to 100 comments.
- [ ] Comment write ≤500ms p99 including all side effects.
- [ ] Mention notification visible in inbox ≤30s p99.

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — `audit_log` infrastructure (reused for comment audit trail)
  - [04-attachments.md](./04-attachments.md) — polymorphic Attachment model (extended with `Comment` entity type)
  - [05-customer-portal.md](./05-customer-portal.md) — portal communication scope (customer-visible comments surface as "Messages from Utility")
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `OPERATIONAL_LOG` retention class governs comment archival; `FINANCIAL` class for comments on adjustment/payment entities
  - [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — single-table architectural pattern reused (polymorphic comment table, not per-entity)
  - [docs/specs/13-notifications.md](../specs/13-notifications.md) — notification template + channel infrastructure (extended with `IN_APP` channel and two new templates)
  - [docs/specs/14-service-requests.md](../specs/14-service-requests.md) — current SR scope (Comments thread is the new operational surface for CSR notes; legacy `resolutionNotes` column stays as-is)
  - [docs/specs/15-customer-portal.md](../specs/15-customer-portal.md) — portal Phase 4.x scope; "Messages" page added in this doc's adoption phase
  - `packages/shared/prisma/migrations/20260423021900_fts/` — existing FTS pattern reused for comment search
  - `packages/api/src/lib/audit-wrap.ts` — existing audit wrapper reused for comment CRUD

- **External**:
  - Tiptap (`@tiptap/react` + `@tiptap/extension-mention`) — Markdown-first WYSIWYG editor
  - unified / remark / rehype / `rehype-sanitize` — server-side Markdown → safe HTML pipeline
  - OWASP XSS Filter Evasion Cheat Sheet — adversarial test corpus
  - PostgreSQL `tsvector` + GIN index — same FTS pattern proven on customer/premise/account/meter

---

**End of doc 11.**
