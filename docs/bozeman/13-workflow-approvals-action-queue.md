# 13 — Workflow, Approvals, and Action Queue

**RFP commitment owner:** SaaSLogic Utilities — split between `packages/shared/prisma/schema.prisma` (`WorkflowDefinition` + `WorkflowVersion` + `Delegation` + `Escalation` + `CisUserManager` org-chart relation; reuses `pending_administrative_change` from docs 01/08/10/12 and `Notification` + `Comment` from doc 11), `packages/api/src/services/workflow/*` (rule engine evaluator, scheduler-trigger fan-out, escalation worker), `packages/api/src/services/delegation.service.ts`, `packages/web/app/(admin)/settings/workflows/*` (the no-code visual rule builder), and `packages/web/components/action-queue/*` (My Tasks + visual workflow path + dashboard widgets). Cross-cuts heavily with [11-notes-and-comments.md](./11-notes-and-comments.md) (in-app channel + bell icon + @-mentions + comment threads — this doc adds workflow-task notifications on top of that substrate; broadcast messages reuse the same notification template engine), [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 + [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 (`pending_administrative_change` reused for approval requests; this doc adds delegation + escalation on top), and [docs/specs/14-service-requests.md](../specs/14-service-requests.md) (the existing SR state machine becomes the first migration target — its hardcoded `VALID_TRANSITIONS` map is replaced by a `WorkflowDefinition` row).
**Status:** Drafted — minimal implementation. **No workflow rule engine exists.** State machines are hardcoded (e.g., `service-request.service.ts:33-41` is a literal `VALID_TRANSITIONS` map). The "automation" Settings page exists but only toggles four hardcoded schedulers on/off — no rule builder. `Sla.escalationHours` and `Sla.escalationUserId` columns exist but **no worker reads them.** No `Delegation` entity. No `manager` / `reportsTo` column on `CisUser`. No "My Tasks" inbox. The "daily digest" is a settings toggle that persists a boolean — no worker generates the email. `UserPreference.preferences` is a `Json @default("{}")` column that no code path writes to or reads from.
**Effort estimate:** XL (~16-22 weeks). This doc covers six RFP claims and the substrate underneath all of them. The largest cost is the **no-code rule engine** (~5-7 weeks: schema, evaluator, UI builder, version + rollback). Second-largest is the **action-queue + visualization layer** (~3-4 weeks: My Tasks, dashboard widgets, visual workflow path, transition history view). Third is the **delegation + escalation + org chart** (~2-3 weeks). Fourth is **email digest + per-category notification preferences** (~1-2 weeks). The doc reuses substantial existing infrastructure: `pending_administrative_change` from docs 01/08/10/12, `Notification` + `Comment` from doc 11, audit log from doc 01, retention from doc 08.

---

## 1. RFP commitments (verbatim)

This doc covers **six bundled RFP claims**, all facets of the workflow/approval/notification system:

> **1. Workflow rules.** Workflows are configured in the Settings module using a no-code rule builder. Triggers (entity created, status changed, field updated, scheduled time, external event), conditions (field comparisons, role of the actor, value thresholds), and actions (assign, notify, set status, create child entity, call external integration via Apptorflow) are defined visually. Workflows are versioned; previous versions remain available for audit and rollback.

> **2. User notifications.** In-application action queue ("My Tasks"), email digest at user-configurable cadence, immediate email or SMS for time-sensitive actions, and dashboard widgets showing aged items. Notification preferences are user-configurable by category.

> **3. In-system communications.** @-mentions on entities create in-system notifications; comment threads on entities preserve discussion alongside the work item; broadcast messages can be sent to roles or groups; and internal vs. customer-visible flagging on comments lets internal discussion happen without exposure to residents.

> **4. Workflow visibility.** Each entity displays its current workflow state, the history of state transitions (with actor and timestamp), pending actions for the current user or for the team, and a visual workflow path showing where the entity sits in the overall process.

> **5. Approver delegation.** Approver delegation is supported with start/end dates and optional restrictions (e.g., delegate only for amounts under $X). Delegations are visible to administrators and captured in the audit log. Delegated approvals carry the original approver's role authority but record the actual delegate as the actor.

> **6. Escalation.** Approval rules support timed escalation: if an approver has not acted within a configurable SLA, the request escalates to a designated alternate or to the approver's manager (per the org chart configured in Settings). Escalation events are logged. Approvers receive reminder notifications at configurable intervals before escalation occurs.

The six topics share a substrate — workflow definitions, approval requests, escalation worker, action queue, org chart, notification preferences. They're treated as facets of one capability rather than six independent ones, both because they share entities and because they're meaningless in isolation (approval delegation needs approval requests; escalation needs SLA tracking; My Tasks needs both, plus comment mentions from doc 11).

---

## 2. Current state — what exists today

### 2.1 Workflow rule engine ✗

**Status: Not implemented.** A grep across the schema for `Workflow`, `Rule`, `Trigger`, `Action`, `Condition`, `WorkflowDefinition`, `WorkflowVersion` returns zero matches.

The closest things are:

- **`service-request.service.ts:33-41`** — a literal hardcoded `VALID_TRANSITIONS` map dictating SR state-machine transitions:

  ```typescript
  const VALID_TRANSITIONS: Record<ServiceRequestStatus, ServiceRequestStatus[]> = {
    NEW:           ["ASSIGNED", "CANCELLED"],
    ASSIGNED:      ["IN_PROGRESS", "CANCELLED"],
    IN_PROGRESS:   ["PENDING_FIELD", "COMPLETED", "FAILED", "CANCELLED"],
    // ...
  };
  ```

  This is the existing system's "workflow definition" — code, not data. Tenants cannot edit it.

- **`DelinquencyRule`** (`schema.prisma:1132-1155`) — a small condition-based rule table with fields `daysPastDue`, `minBalance`, `accountType`, `tier`, `actionType` (a `VARCHAR`). It's the closest thing to a "rule" today, but actions are an enumerated string and there's no UI builder; rules are inserted via SQL or API.

- **`/settings/automation` page** — toggles four hardcoded schedulers (suspension, notification send, SLA breach, delinquency dispatcher) on/off. Doesn't define rules; just enables/disables existing code paths.

### 2.2 No-code rule builder UI ✗

**Status: Not implemented.** Settings sub-pages: `api-keys`, `automation` (just toggles), `billing`, `branding`, `custom-fields` (per [06-custom-fields.md](./06-custom-fields.md)), `danger-zone`, `general`, `notifications` (provider config + a digest toggle stub), `numbering`, `retention`, `slas` (CRUD per request_type/priority — parameter editor for SLA hours, not a rule builder), `theme`. None of these are workflow rule builders.

### 2.3 SR state-transition audit ✓

**Status: Implemented** (limited to entities that go through `auditUpdate()`). When `transitionServiceRequest()` runs, the audit row captures `actorId`, `actorName`, `beforeState.status`, `afterState.status`, `createdAt`. Per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md), the framework is sound but doesn't yet have `event_class` classification, append-only enforcement, or per-class retention.

### 2.4 My Tasks / action queue ✗

**Status: Not implemented.** Searched schema for `Task`, `TaskQueue`, `Inbox`, `ActionItem`, `PendingTask`, `ActionQueue` — zero matches. No `/tasks`, `/inbox`, or "My Work" page in the web app. The closest analog is the SR list filter `?assignedTo=<userId>&status=IN_PROGRESS`, but that's per-entity-type, not a unified action queue.

### 2.5 Email digest ⚠ stub only

**Status: Partial.** `tenant_config.notifications` JSON includes `dailyDigestEnabled: boolean` (toggled in `/settings/notifications/page.tsx`). Saving the toggle persists. **No worker generates the digest.** The settings page itself acknowledges this: *"The sender address and digest toggle are persisted now. SMS provider setup and per-event templates are part of the Phase 3 notification engine and are not yet implemented."*

### 2.6 Notification preferences (per-user, per-category) ⚠ schema only

**Status: Schema exists; UI and consumption logic do not.**

```prisma
model UserPreference {
  id          String    @id @default(uuid()) @db.Uuid
  utilityId   String    @map("utility_id") @db.Uuid
  userId      String    @map("user_id") @db.Uuid
  themeMode   ThemeMode @default(SYSTEM) @map("theme_mode")
  preferences Json      @default("{}") @map("preferences")
  ...
}
```

`preferences Json` is the catch-all column where notification preferences would live. Today: zero code reads it. No UI configures it. The "category" concept exists (`Notification.event_type`) but is just a tag on outbound notifications — there's no opt-in/opt-out logic.

### 2.7 Dashboard widgets for aged items ✗

**Status: Not implemented.** Portal dashboard shows accounts/usage; admin has no dashboard. No widget aggregates "items waiting > N days" anywhere.

### 2.8 In-system communications (@-mentions, comment threads, broadcasts, internal flag) ✗

**Status: Per [11-notes-and-comments.md](./11-notes-and-comments.md), nothing is implemented.** Eight entities have ad-hoc free-text `notes` columns that overwrite on edit. No `Comment` entity, no rich-text editor, no @-mention parsing, no internal/customer-visible flag pattern, no broadcast mechanism. Doc 11 commits the substrate; this doc reuses it and adds workflow-specific touches (broadcast and per-category preferences).

### 2.9 Workflow visualization ✗

**Status: Not implemented.** Searched dependencies for `react-flow`, `cytoscape`, `mermaid`, `vis-network`, `dagre` — none. Searched UI for state-machine diagrams — none. The only graph visualization is `customer-graph-view.tsx` (the Customer/Account/Premise relationship visualizer), which uses a custom SVG layout, not a generalized library.

### 2.10 Org chart / manager hierarchy ✗

**Status: Not implemented.** `CisUser` (`schema.prisma:703-729`) has no `managerId`, `reportsTo`, `supervisorId`, or any hierarchy column. Searched code for `manager`, `reports_to`, `org_chart`, `hierarchy` — zero matches in production code.

[10-draft-status-and-posting.md](./10-draft-status-and-posting.md) FR-DRAFT-013 mentions `drafts.read_subordinate` as a tenant-configurable role and references "the org-hierarchy table" parenthetically — that table doesn't exist; the reference was forward-looking.

### 2.11 Approver delegation ✗

**Status: Not implemented.** Searched schema for `Delegation`, `Delegate`, `OutOfOffice`, `vacation`, `actingFor` — zero matches. The only approval pattern in the codebase is `ServiceSuspension.requestedBy` + `approvedBy` (`schema.prisma:943-944`), which has no delegation concept.

### 2.12 SLA / escalation ⚠ schema only

**Status: Partial.** The `Sla` model (`schema.prisma:1249-1268`) has the columns but no logic acts on them:

```prisma
model Sla {
  ...
  responseHours    Decimal
  resolutionHours  Decimal
  escalationHours  Decimal?
  escalationUserId String?      @map("escalation_user_id") @db.Uuid
  ...
}
```

The `sla-breach-worker.ts` (Task 8 of the scheduler migration) only flags an SR as `slaBreached` when `slaBreachDue` passes. It does NOT:
- Check `escalationHours` independently of `resolutionHours`
- Send reminder notifications before escalation
- Route to `escalationUserId`
- Log "escalation occurred" as a distinct event

### 2.13 Generalized approval-request entity ⚠ proposed in docs 01/08/10/12

**Status: Proposed in four prior docs, not built.** [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 introduced `pending_security_change`; [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 generalized it to `pending_administrative_change`; [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) §3.4.3 reuses it for high-stakes draft posts; [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) §3.4 reuses it for financial reversals. It's **the** approval substrate this doc should build on. None of it is implemented yet.

### Summary

| Guarantee | Today |
|---|---|
| No-code workflow rule builder | ✗ |
| Workflow versioning + rollback | ✗ |
| My Tasks / action queue | ✗ |
| Email digest (configurable cadence) | ⚠ (toggle only) |
| Immediate email/SMS for time-sensitive | ⚠ (templates exist; trigger plumbing absent for non-SR events) |
| Dashboard widgets for aged items | ✗ |
| Per-user, per-category notification preferences | ⚠ (column exists; never read or written) |
| @-mentions / comment threads / internal flag | ✗ (covered by [doc 11](./11-notes-and-comments.md)) |
| Broadcast messages to roles or groups | ✗ |
| Current workflow state per entity | ✓ (every entity's `status` column) |
| State-transition history (actor, timestamp) | ⚠ (audit log; needs UI surface) |
| Pending actions for current user / team | ✗ |
| Visual workflow path | ✗ |
| Approver delegation with date range + restrictions | ✗ |
| Org chart / manager hierarchy | ✗ |
| Timed escalation with reminder notifications | ✗ |
| Escalation events logged | ✗ |

---

## 3. Functional requirements

### 3.1 Workflow rule engine

#### 3.1.1 Schema

- **FR-WF-001** — A `WorkflowDefinition` table holds **versioned workflows** per tenant. Each version is immutable; editing produces a new version row. The currently-active version per `(tenant, scope)` is determined by the most recent `WorkflowVersion` with `status = ACTIVE`.

  ```prisma
  model WorkflowDefinition {
    id            String   @id @default(uuid()) @db.Uuid
    utilityId     String   @map("utility_id") @db.Uuid
    name          String   @db.VarChar(200)
    scope         String   @db.VarChar(64)  // "service_request" | "adjustment" | "rate_schedule" | "billing_cycle" | ... | "global"
    description   String?  @db.Text
    createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
    @@unique([utilityId, name])
    @@index([utilityId, scope])
    @@map("workflow_definition")
  }

  model WorkflowVersion {
    id              String              @id @default(uuid()) @db.Uuid
    utilityId       String              @map("utility_id") @db.Uuid
    definitionId    String              @map("definition_id") @db.Uuid
    versionNumber   Int                 @map("version_number")
    status          WorkflowVersionStatus @default(DRAFT)
    spec            Json                // canonical JSON DSL (FR-WF-002)
    publishedAt     DateTime?           @map("published_at") @db.Timestamptz
    publishedBy     String?             @map("published_by") @db.Uuid
    retiredAt       DateTime?           @map("retired_at") @db.Timestamptz
    retiredBy       String?             @map("retired_by") @db.Uuid
    notes           String?             @db.Text
    createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz

    definition WorkflowDefinition @relation(fields: [definitionId], references: [id])
    @@unique([definitionId, versionNumber])
    @@index([utilityId, status])
    @@map("workflow_version")
  }

  enum WorkflowVersionStatus {
    DRAFT       // editable; not in effect
    ACTIVE      // current version; engine uses this one
    RETIRED     // historical; preserved for audit
  }
  ```

  **Why two tables:** the definition is the stable identity (workflow name + scope); versions are immutable specs. New version → insert a new `workflow_version` row. Activate → set old ACTIVE to RETIRED + new DRAFT to ACTIVE in same transaction. Roll back → activate an older RETIRED version (which becomes ACTIVE; current ACTIVE → RETIRED).

- **FR-WF-002** — `WorkflowVersion.spec` is a canonical JSON DSL with three top-level sections: `triggers`, `conditions`, `actions`. Schema (Zod-validated):

  ```typescript
  type WorkflowSpec = {
    triggers: Trigger[];
    conditions: Condition[];   // ANDed; OR via nested groups
    actions: Action[];
    onFailure: "abort" | "continue" | "notify";
    timeout: { seconds: number };
  };

  type Trigger =
    | { type: "entity_created"; entityType: string }
    | { type: "status_changed"; entityType: string; from?: string; to?: string }
    | { type: "field_updated"; entityType: string; field: string; threshold?: { op: "gt"|"lt"|"eq"; value: unknown } }
    | { type: "scheduled"; cron: string; timezone: string }
    | { type: "external_event"; channel: string };  // routed via Apptorflow

  type Condition =
    | { type: "field_compare"; field: string; op: "eq"|"ne"|"gt"|"gte"|"lt"|"lte"|"in"|"matches"; value: unknown }
    | { type: "actor_role_in"; roles: string[] }
    | { type: "value_threshold"; field: string; min?: number; max?: number; currency?: string }
    | { type: "and"; children: Condition[] }
    | { type: "or"; children: Condition[] }
    | { type: "not"; child: Condition };

  type Action =
    | { type: "assign"; assignTo: { kind: "user"|"role"|"manager_of"; ref: string } }
    | { type: "notify"; channel: "in_app"|"email"|"sms"; to: { kind: "user"|"role"|"actor"|"originator"|"manager"|"customer"; ref?: string }; templateCode: string }
    | { type: "set_status"; status: string }
    | { type: "set_field"; field: string; value: unknown }
    | { type: "create_child"; childEntityType: string; payload: Record<string, unknown> }
    | { type: "create_approval_request"; approvers: { kind: "user"|"role"|"manager_of"; ref: string }[]; sla: { hours: number; escalateTo?: { kind: "user"|"role"|"manager_of"; ref: string } } }
    | { type: "call_external"; via: "apptorflow"; connector: string; params: Record<string, unknown> };
  ```

  The DSL is **bounded** — operators can compose only the listed primitives. Free-form scripting (JavaScript, Lua, etc.) is **explicitly out of scope** to keep the rule space auditable and the surface attack-resistant.

- **FR-WF-003** — Rules execute via a `workflow-engine` BullMQ worker (added to the existing scheduler infrastructure per [docs/specs/14-service-requests.md](../specs/14-service-requests.md)). The worker:
  1. On every domain event (entity create/update/status change/field update), filters active workflow versions by `(utilityId, scope, trigger.type)` — single query per event.
  2. For each matching version, evaluates `conditions` against the event payload + the current actor.
  3. If conditions pass, executes `actions` in order, in a single transaction where possible.
  4. Action failures are handled per `onFailure`: abort (rollback), continue (next action), or notify (emit notification then continue).
  5. Each rule execution emits an audit row of class `AUDIT_OPERATIONAL` with the workflow version, trigger, conditions matched, and actions executed.

#### 3.1.2 No-code rule builder UI

- **FR-WF-010** — A new admin page at `/settings/workflows` lists all `WorkflowDefinition` rows with their current active version. Operators can:
  - Create a new workflow (selects a scope; opens the visual builder for the first version).
  - Edit a workflow (clones the active version into a new DRAFT for editing; original ACTIVE remains unchanged).
  - Publish a draft (transition DRAFT → ACTIVE; previous ACTIVE → RETIRED).
  - View version history with side-by-side diffs.
  - Roll back to a prior version (selects a RETIRED version; promotes it to ACTIVE).

- **FR-WF-011** — The visual builder is a three-pane layout (mobile-responsive per [02-mobile-and-responsive-ui.md](./02-mobile-and-responsive-ui.md) Tier 2 — desktop-optimized, tablet-usable):
  - **Triggers pane** — drag-and-drop trigger blocks; each block has its own configuration form (entity type picker for entity_created; field + threshold picker for field_updated; cron picker for scheduled).
  - **Conditions pane** — tree of AND/OR/NOT groupings with leaf field comparisons. Each leaf has a field picker (entity-type-aware), an operator dropdown, and a value input.
  - **Actions pane** — sequential list of actions. Each action has its own form.
  - Live preview shows a textual summary: *"WHEN a service request is created, IF amount > $500 AND actor.role = 'csr_junior', THEN create approval request to role 'manager' with 24h SLA."*

- **FR-WF-012** — The builder is built with **React Flow** (`@xyflow/react`) for the trigger/action graph view. React Flow was chosen because it's well-maintained, accessible, mobile-aware, and bundle size is acceptable (~150KB minified gzipped for the full feature set we use). Custom node types render the trigger/condition/action forms inline.

- **FR-WF-013** — Saving a draft validates the spec against the Zod schema at the API. Invalid drafts can be saved (per [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — drafts can be incomplete) but cannot be published. Publishing requires full validation pass.

- **FR-WF-014** — Publishing a workflow version is itself an approval-gated operation per [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) FR-DRAFT-090 (`WorkflowDefinition` is added to the doc-10 adoption list). High-stakes workflows (e.g., financial-impact actions like `create_child: AdhocCharge`) require dual approval to publish. Per-tenant config; default is dual-approval-required for any workflow with a financial action.

#### 3.1.3 Versioning + rollback

- **FR-WF-020** — Every published version is preserved indefinitely (per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — workflow versions inherit the entity's retention class, default `OPERATIONAL_LOG` 2-year minimum; tenants can override to `AUDIT_FINANCIAL` 7-year if their workflows have material financial impact).

- **FR-WF-021** — Rollback to a prior RETIRED version is itself an audit-logged operation. The old ACTIVE version transitions to RETIRED with `retiredBy` populated; the chosen RETIRED version transitions to ACTIVE. Both transitions in one transaction; one audit row of class `AUDIT_OPERATIONAL`.

- **FR-WF-022** — Each `audit_log` row emitted by a workflow execution carries `metadata: { workflowVersionId, definitionId, triggerType }`. This means an auditor can trace back: *"This bill void was triggered by the workflow X at version 5. Here's the spec for version 5."*

### 3.2 Action queue ("My Tasks")

- **FR-WF-030** — A new `Task` table — the polymorphic action-queue substrate:

  ```prisma
  model Task {
    id              String     @id @default(uuid()) @db.Uuid
    utilityId       String     @map("utility_id") @db.Uuid
    assigneeId      String?    @map("assignee_id") @db.Uuid    // null = unassigned, claimable by team
    teamRoleId      String?    @map("team_role_id") @db.Uuid   // role-scoped task; any user with the role can claim or work on it
    sourceType      String     @map("source_type") @db.VarChar(64)  // "approval_request" | "comment_mention" | "sr_assigned" | "workflow_action" | ...
    sourceId        String     @map("source_id") @db.Uuid
    parentEntityType String?   @map("parent_entity_type") @db.VarChar(64)  // breadcrumb context for the task UI
    parentEntityId  String?    @map("parent_entity_id") @db.Uuid
    title           String     @db.VarChar(255)
    description     String?    @db.Text
    priority        TaskPriority @default(NORMAL)
    dueAt           DateTime?  @map("due_at") @db.Timestamptz
    status          TaskStatus  @default(OPEN)
    completedAt     DateTime?  @map("completed_at") @db.Timestamptz
    completedBy     String?    @map("completed_by") @db.Uuid
    createdAt       DateTime   @default(now()) @map("created_at") @db.Timestamptz

    @@index([utilityId, assigneeId, status, dueAt])
    @@index([utilityId, teamRoleId, status, dueAt])
    @@index([utilityId, sourceType, sourceId])  // dedupe + lookup by source
    @@map("task")
  }

  enum TaskStatus { OPEN  IN_PROGRESS  COMPLETED  CANCELLED }
  enum TaskPriority { LOW  NORMAL  HIGH  URGENT }
  ```

  **Why a separate table** (vs. unifying with `Notification`): tasks are **action-required**, notifications are **information**. A user gets one of each for the same event (notification: "you've been assigned a high-priority approval"; task: "approve this proposal by 2pm tomorrow"). Tasks have lifecycle (OPEN → COMPLETED); notifications don't (read/unread, that's it). Tasks have due dates and priority; notifications don't. Conflating them produces a confused mental model and a confused query pattern.

- **FR-WF-031** — Tasks are **created** by:
  - Workflow `assign` action (FR-WF-002) → one Task row with `sourceType: "workflow_action"`.
  - `pending_administrative_change` row creation → one Task row per approver with `sourceType: "approval_request"`.
  - `service_request` assignment → one Task row with `sourceType: "sr_assigned"` (replaces the implicit "your assigned SRs" filter from today).
  - `comment_mention` (per [11-notes-and-comments.md](./11-notes-and-comments.md)) → optional, configurable: a mention can either be *just* a notification (default) OR can also create a task if `requireResponse: true` is set on the comment.
  - Future: when modules 09/10 ship, financial events (e.g., overdue customer follow-up) generate tasks via workflow rules.

- **FR-WF-032** — Tasks are **completed** by:
  - The user explicitly marks done (or explicitly cancels with a reason).
  - The source event reaches a terminal state (e.g., the approval is decided → all per-approver tasks for that approval auto-complete; the SR transitions out of `ASSIGNED` → the assignment task auto-completes).
  - Auto-complete uses the `(sourceType, sourceId)` index — when a source entity transitions, its tasks are looked up and marked completed in the same transaction.

- **FR-WF-033** — A new `/my-tasks` page in admin shows:
  - **Open** tab — tasks assigned to me + unassigned tasks for roles I hold (claimable). Sorted by `priority DESC, dueAt ASC, createdAt ASC`. Each task shows title, source-entity breadcrumb, due date (with relative time + traffic-light color: green ≥3d, yellow <3d, red overdue), and an inline action button when applicable.
  - **In Progress** tab — tasks I claimed but haven't completed.
  - **Recently Completed** tab — last 30 days; click to navigate to the source entity.

- **FR-WF-034** — Bulk actions on the My Tasks page: select N tasks → claim, mark complete, reassign (to another user with the right role), defer (set a `deferredUntil` field that hides until that date — different from `dueAt`).

- **FR-WF-035** — A "Team Tasks" tab on a per-role basis shows all open tasks for the role. Available to users with `tasks.read_team` permission. Useful for supervisors triaging.

### 3.3 Notifications — categories, preferences, digest

#### 3.3.1 Categories

- **FR-WF-040** — Notifications are categorized by **event family**, not by entity type. Categories (extensible per tenant):

  | Category | Examples |
  |---|---|
  | `assignment` | Task assigned to me; SR assigned to me; approval request requires my action |
  | `mention` | I was @-mentioned in a comment |
  | `escalation` | A request I haven't actioned is about to escalate |
  | `customer_message` | Customer-visible comment posted on an account I own (delegated case) |
  | `system` | Workflow rule failed; integration error; tenant-config change |
  | `digest` | Daily/weekly summary |
  | `broadcast` | Tenant-wide announcement (FR-WF-060) |

  The categories are **product-fixed** (changes via release, not per-tenant config) so the per-user preference matrix stays stable.

#### 3.3.2 Per-user preferences

- **FR-WF-050** — `UserPreference.preferences` JSON column gets a defined shape — `notifications: { <category>: { in_app: bool, email: bool, sms: bool, frequency: "immediate" | "digest_daily" | "digest_weekly" | "off" } }`. Per category, per channel, per cadence. The shape is Zod-validated at the API.

- **FR-WF-051** — Every notification send queries the recipient's `UserPreference`. If the relevant `(category, channel)` is `off`, the send is skipped (and a debug-only audit row of class `AUDIT_TECHNICAL` records the suppression). If `frequency: "digest_*"`, the notification is queued for the next digest run instead of sent immediately.

- **FR-WF-052** — Defaults per category (out of the box):
  - `assignment`: `in_app: true (immediate), email: true (digest_daily), sms: false`
  - `mention`: `in_app: true (immediate), email: false, sms: false`
  - `escalation`: `in_app: true (immediate), email: true (immediate), sms: false`
  - `customer_message`: `in_app: true (immediate), email: false, sms: false`
  - `system`: `in_app: true (digest_daily), email: false, sms: false`
  - `digest`: `email: true (always), in_app: true (immediate), sms: false`
  - `broadcast`: `in_app: true (immediate), email: true (immediate), sms: false`

- **FR-WF-053** — A new admin page at `/settings/notifications` (extending the existing page) renders the preferences matrix. Save persists to `UserPreference.preferences`. Reset-to-default button restores tenant defaults. Tenant admins MAY set tenant-level defaults that override product defaults (per-tenant defaults stored in `tenant_config.notification_defaults`).

- **FR-WF-054** — Time-sensitive overrides: the workflow engine (FR-WF-002 `notify` action) can specify `overrideUserPreference: true` for genuinely urgent events (e.g., security incident, payment failure during automated reconnection). Overriding emits an extra `AUDIT_OPERATIONAL` row noting the override + reason. Tenants can audit override frequency to ensure operators aren't crying wolf.

#### 3.3.3 Email digest

- **FR-WF-060** — A new `digest-builder` worker runs at the cadence configured per user (`digest_daily` at the user's preferred local time, default 7am tenant timezone; `digest_weekly` Monday 7am). For each user with `frequency: "digest_*"` on at least one category:
  1. Query unread `Notification` rows for the user with channel `IN_APP` and a category whose preference is `digest_*`, since the last digest send.
  2. Group by category and source entity.
  3. Render an HTML email using a `DIGEST_DAILY` / `DIGEST_WEEKLY` notification template.
  4. Send via the existing notification engine (per [docs/specs/13-notifications.md](../specs/13-notifications.md)).
  5. Mark the in-app notifications as `digestedAt` so they don't re-appear in the next digest (they remain readable in the inbox per [11-notes-and-comments.md](./11-notes-and-comments.md)).

- **FR-WF-061** — The digest email links every item back to its source entity in the admin app (or portal app for portal users — but in practice portal users rarely opt for digest; default off).

- **FR-WF-062** — Empty digest is suppressed — the worker doesn't send a "you have nothing to do" email.

#### 3.3.4 Immediate channels

- **FR-WF-063** — When a category's `frequency: "immediate"` for a channel, the notification is sent right away through that channel:
  - `in_app` → adds a `Notification` row with `channel: IN_APP`, surfaced in the bell-icon UI from [11-notes-and-comments.md](./11-notes-and-comments.md).
  - `email` → enqueues to the existing email notification queue (per [docs/specs/13-notifications.md](../specs/13-notifications.md)).
  - `sms` → enqueues to the SMS queue (per spec 13).

  Implementation: one `notifications` queue with channel routing; the existing infrastructure already handles this for non-workflow notifications.

#### 3.3.5 Dashboard widgets

- **FR-WF-070** — A new `/dashboard` admin page (the admin app has none today) shows configurable widgets. Default widgets:
  - **My Tasks** — open task count + breakdown by priority + link to `/my-tasks`.
  - **Aged Approvals** — pending approval requests assigned to me (or escalated to me) > 24h, > 3d, > 7d.
  - **Team Workload** — for users with `tasks.read_team`, count of open tasks per role.
  - **Recent Mentions** — last 5 mentions in comments on entities I own.
  - **System Health** — tenant-admin only: scheduler status, recent failed integrations, audit volume.

- **FR-WF-071** — Each widget is a separate React component under `packages/web/components/dashboard/widgets/*`. Tenants can configure (Phase 2) which widgets appear per role. For the initial RFP scope, the default widget set per built-in role is fixed; per-user customization is Phase 5+.

### 3.4 Workflow visibility — current state, history, pending, visual path

- **FR-WF-080** — Every entity that has a workflow (i.e., a `WorkflowDefinition` exists with `scope = <entityType>`) gets a **Workflow Status** section on its detail page showing:
  - **Current state** — the entity's `status` value with a colored chip and a short description.
  - **History of state transitions** — a chronological list of `audit_log` rows where `before_state.status != after_state.status` for this entity, each row showing: from → to, actor name, timestamp, and (if the transition was workflow-driven) a link to the workflow version that drove it.
  - **Pending actions** — `Task` rows with `parentEntityType + parentEntityId` matching this entity, sorted by priority + due date.
  - **Visual workflow path** — a rendered diagram of the active workflow version's state machine, with the current state highlighted and the path traveled marked. Nodes the entity may transition to next are highlighted differently.

- **FR-WF-081** — The **visual workflow path** is rendered using the same React Flow engine as the rule builder (FR-WF-012), but in read-only display mode. The diagram is auto-laid-out via `@xyflow/react`'s built-in dagre layout. Nodes have hover tooltips with the transition's conditions.

- **FR-WF-082** — Hardcoded state machines that exist today (`service-request.service.ts:33-41`) are **migrated** to `WorkflowDefinition` rows during Phase 1 of this doc's implementation. After migration:
  - The hardcoded `VALID_TRANSITIONS` map is replaced with a call to `workflowEngine.allowedTransitions(entity)`.
  - The same set of transitions is preserved (no behavior change).
  - Tenants gain the ability to add restrictions or new states via the rule builder.
  - Audit history retroactively links to the migrated workflow version (one synthetic version per state machine, marked `migratedFromCode: true`).

- **FR-WF-083** — When workflows reference custom states (per FR-WF-002 `set_status` action) that don't exist in the entity's status enum yet, the workflow validation prevents publish. The entity's status enum must be extended in code first (a release-level change), then the workflow can reference the new state. Reasoning: arbitrary tenant-defined state names would break every cross-entity report; product-controlled state names keep the data model coherent.

### 3.5 Approver delegation

- **FR-WF-090** — A new `Delegation` table:

  ```prisma
  model Delegation {
    id              String   @id @default(uuid()) @db.Uuid
    utilityId       String   @map("utility_id") @db.Uuid
    delegatorId     String   @map("delegator_id") @db.Uuid     // person whose authority is delegated
    delegateId      String   @map("delegate_id") @db.Uuid       // person receiving authority
    scope           String   @db.VarChar(64)                    // "all" | "approvals" | "<workflow_definition_id>" | "<role_id>"
    startsAt        DateTime @map("starts_at") @db.Timestamptz
    endsAt          DateTime @map("ends_at") @db.Timestamptz
    maxDollarAmount Decimal? @map("max_dollar_amount") @db.Decimal(14, 2)  // null = no limit
    reason          String?  @db.Text
    createdBy       String   @map("created_by") @db.Uuid
    createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
    revokedAt       DateTime? @map("revoked_at") @db.Timestamptz
    revokedBy       String?  @map("revoked_by") @db.Uuid

    @@index([utilityId, delegatorId, startsAt, endsAt])
    @@index([utilityId, delegateId, startsAt, endsAt])
    @@map("delegation")
  }
  ```

- **FR-WF-091** — When the approval-engine looks up "who can approve X for delegator D right now," it queries:

  ```sql
  SELECT delegate_id FROM delegation
  WHERE utility_id = ?
    AND delegator_id = ?
    AND now() BETWEEN starts_at AND ends_at
    AND revoked_at IS NULL
    AND (scope = 'all' OR scope = 'approvals' OR scope = ?)
    AND (max_dollar_amount IS NULL OR max_dollar_amount >= ?)
  ```

  Multiple active delegations are fine — any of the delegates can approve. The first to act wins.

- **FR-WF-092** — When a delegate approves, the approval is recorded with **two actor fields**:
  - `acted_by_user_id` = the delegate (who actually clicked approve)
  - `authority_of_user_id` = the delegator (whose role authority granted the approval)

  The audit log captures both. Reports show the delegate as the actor for accountability ("Sue approved this on Tuesday at 3pm"), but the approval rule succeeds because the delegator's authority applied.

- **FR-WF-093** — Delegations are visible to:
  - The delegator and delegate (always — both see "I delegated X to Y" / "Y delegated to me" on their profile pages).
  - Tenant admins via a new `/admin/delegations` page (active + recent + revoked, filterable).
  - All audit-class consumers (every Delegation creation/revocation emits an `AUDIT_SECURITY` row — delegating approval authority is a sensitive operation).

- **FR-WF-094** — Restrictions:
  - `maxDollarAmount` — if the approval request involves a dollar amount (extracted from the `pending_administrative_change.proposedState`), the delegate can act only if the amount is within the cap.
  - `scope = "<workflow_definition_id>"` — limit delegation to a specific workflow.
  - `scope = "<role_id>"` — limit delegation to one of the delegator's roles (if the delegator wears multiple hats and only wants to delegate one).

- **FR-WF-095** — Self-delegation forbidden (`delegatorId != delegateId` enforced at the API). Chained delegation forbidden — the delegate cannot themselves further delegate the granted authority. (Reasoning: chained delegation creates accountability fog. If the delegate is going on vacation, the original delegator should set a fresh delegation directly to whoever's available.)

- **FR-WF-096** — A user with `delegations.admin` permission can create or revoke delegations on behalf of others (e.g., HR team setting up a vacation delegation when an employee forgets). This is itself audit-logged with both the admin actor and the delegator. Restricted to specific roles per tenant.

### 3.6 Escalation

- **FR-WF-100** — Approval requests created via FR-WF-002's `create_approval_request` action OR via direct service-layer calls (`pending_administrative_change`) carry an SLA configuration:

  ```prisma
  // Added to pending_administrative_change (per docs 01/08)
  slaResponseHours    Int?          @map("sla_response_hours")
  escalationConfig    Json?         @map("escalation_config")
  // ^ shape: { steps: [{ afterHours, escalateTo: { kind, ref } }, ...], reminders: [{ atHoursRemaining, channel }] }
  escalatedAt         DateTime?     @map("escalated_at") @db.Timestamptz
  escalatedToUserId   String?       @map("escalated_to_user_id") @db.Uuid
  escalatedFromConfig Json?         @map("escalated_from_config")  // snapshot of the rule that escalated, for audit
  ```

- **FR-WF-101** — A new `escalation-worker` BullMQ job runs every 5 minutes. For each `pending_administrative_change` row with `status = PENDING` and an `escalationConfig`:
  1. Compute the elapsed hours since `requested_at`.
  2. For each `reminders[i]` not yet sent, if `(slaResponseHours - elapsedHours) ≤ atHoursRemaining`, send a reminder notification through the configured channel and mark `reminders[i].sentAt`.
  3. For each `steps[i]` not yet executed, if `elapsedHours ≥ steps[i].afterHours`, execute the escalation: create a new approval request assigned to `steps[i].escalateTo` (resolved per FR-WF-103), mark `escalatedAt`, `escalatedToUserId`, and emit an `AUDIT_OPERATIONAL` row.
  4. The original approver's task remains open (per FR-WF-031 the source-entity transition closes it, but escalation is not a transition — it's an addition); the original approver MAY still act if they pick up the request before the escalatee. Whoever acts first wins; the other approver's task auto-closes.

- **FR-WF-102** — `escalateTo: { kind: "manager_of", ref: "<originator_id>" | "<approver_id>" }` triggers an org-chart lookup (FR-WF-110). If no manager is configured, the escalation falls back to the configured `escalationConfig.fallbackUserId` or aborts with an `AUDIT_OPERATIONAL` warning.

- **FR-WF-103** — Reminders are per-user notifications using the `escalation` category (FR-WF-040). They respect user preferences but the workflow can `overrideUserPreference: true` for the final reminder before escalation actually fires (typically 1h-out reminder is overridable, earlier reminders are not).

- **FR-WF-104** — Escalation events are queryable via `audit_log WHERE entity_type = 'pending_administrative_change' AND action = 'ESCALATED'`. The audit row includes `metadata: { fromUserId, toUserId, ruleStepIndex, elapsedHours }`.

- **FR-WF-105** — Tenants can suppress escalation per workflow with `escalationConfig: null` — no escalation for that workflow, just an SLA for reporting purposes (or no SLA at all).

### 3.7 Org chart / manager hierarchy

- **FR-WF-110** — A new `CisUserManager` table — *not* a column on `CisUser`, because:
  - One user may have different managers in different domains (e.g., reports to the CFO for financial approvals, the COO for operational approvals).
  - Managers change more often than user records; a separate table avoids `audit_log` noise on `CisUser`.
  - Multiple-manager support is a small Phase 2 ask away if needed.

  ```prisma
  model CisUserManager {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    userId      String   @map("user_id") @db.Uuid          // the subordinate
    managerId   String   @map("manager_id") @db.Uuid       // the manager
    domain      String   @default("default") @db.VarChar(64)  // "default" | "financial" | "operational" | "<custom>"
    effectiveFrom DateTime @map("effective_from") @db.Timestamptz @default(now())
    effectiveTo   DateTime? @map("effective_to") @db.Timestamptz
    createdBy   String   @map("created_by") @db.Uuid
    createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz

    @@unique([utilityId, userId, domain, effectiveFrom])
    @@index([utilityId, userId, effectiveFrom, effectiveTo])
    @@index([utilityId, managerId])
    @@map("cis_user_manager")
  }
  ```

- **FR-WF-111** — A new `/settings/org-chart` admin page lets tenant admins maintain the hierarchy. View modes:
  - **List** — table with filters (user, manager, domain).
  - **Tree** — visual tree per domain, navigable.
  - Edit by clicking a user → reassign manager. Editing emits `AUDIT_SECURITY` rows.

- **FR-WF-112** — Bulk import from CSV — operators upload an org-chart CSV (`employee_email, manager_email, domain`) and the importer creates `CisUserManager` rows. Reuses the bulk-upload pipeline from [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md).

- **FR-WF-113** — Cycle detection — the import + UI prevent assigning A→B→A. The validation runs server-side at every save (depth limit 8 levels; if a chain exceeds 8 levels, save fails — no real org chart is that deep, and a deeper one signals a misconfiguration).

- **FR-WF-114** — `manager_of(user_id, domain)` SQL helper resolves the current manager:

  ```sql
  CREATE OR REPLACE FUNCTION manager_of(p_user_id uuid, p_domain text DEFAULT 'default')
  RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER AS $$
    SELECT manager_id FROM cis_user_manager
    WHERE user_id = p_user_id AND domain = p_domain
      AND now() BETWEEN effective_from AND COALESCE(effective_to, 'infinity'::timestamptz)
    ORDER BY effective_from DESC LIMIT 1
  $$;
  ```

  Used by escalation worker (FR-WF-102) and by workflow `assignTo: { kind: "manager_of" }` (FR-WF-002).

### 3.8 In-system communications — broadcasts (delta from doc 11)

[doc 11](./11-notes-and-comments.md) covers @-mentions, comment threads, internal-vs-customer-visible flag, and in-app notifications. This doc only adds **broadcasts**.

- **FR-WF-120** — A new `Broadcast` table:

  ```prisma
  model Broadcast {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    title       String   @db.VarChar(255)
    body        String   @db.Text                  // Markdown source (subset per doc 11)
    bodyRendered String? @map("body_rendered") @db.Text  // sanitized HTML cache
    audience    Json     // shape: { kind: "role" | "tenant" | "users", ref?: string, userIds?: string[] }
    sentAt      DateTime? @map("sent_at") @db.Timestamptz   // null = scheduled or draft
    scheduledFor DateTime? @map("scheduled_for") @db.Timestamptz
    sentBy      String   @map("sent_by") @db.Uuid
    createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
    @@index([utilityId, sentAt])
    @@map("broadcast")
  }
  ```

- **FR-WF-121** — Sending a broadcast:
  1. Resolves the audience (role members, tenant users, named user list).
  2. For each recipient, creates one `Notification` row with `category = "broadcast"` and channel routing per the recipient's preferences.
  3. The broadcast itself is the source entity; clicking the in-app notification navigates to a dedicated broadcast view (read-only Markdown render).

- **FR-WF-122** — Broadcasts are NOT created via the `Comment` infrastructure (per doc 11) because:
  - Broadcasts have no parent entity.
  - Broadcasts are one-way (no replies).
  - Audience targeting differs (role/tenant vs. comment visibility-per-row).

  They share the **rendering pipeline** (Markdown source + sanitized HTML) and the **notification channel infrastructure**, but the entity model is separate.

- **FR-WF-123** — Permission `broadcasts.send` required to create a broadcast. Audit row emitted on send (class `AUDIT_OPERATIONAL`). Tenant admins see all broadcasts via `/admin/broadcasts`.

- **FR-WF-124** — Broadcasts are NOT customer-portal-visible by default. To send a tenant-wide announcement to portal customers, tenants use the existing portal email/SMS notification path (per [05-customer-portal.md](./05-customer-portal.md)) with a different template — that's a separate feature, not a broadcast. A broadcast is operator-to-operator.

### 3.9 Non-functional requirements

- **NFR-WF-001** — Workflow rule evaluation latency: ≤500ms p99 from triggering event to all actions complete (excluding async actions like external API calls).
- **NFR-WF-002** — `/my-tasks` page load: ≤500ms p99 for users with up to 200 open tasks.
- **NFR-WF-003** — Dashboard load: ≤1s p99 with all default widgets.
- **NFR-WF-004** — Digest worker run: ≤30 minutes p99 for tenants with up to 5K users.
- **NFR-WF-005** — Escalation worker tick: 5 minutes; max latency from SLA breach to escalation action ≤5 minutes.
- **NFR-WF-006** — Workflow rule builder save: ≤2s p99 from publish click to ACTIVE.
- **NFR-WF-007** — `/settings/org-chart` tree render: ≤1s p99 for org charts up to 10K nodes per domain.
- **NFR-WF-008** — Reminder notification before escalation: bounded delivery latency ≤30s p99 from reminder timestamp to in-app inbox.
- **NFR-WF-009** — All audit emission stays in-transaction with the entity mutation that triggered it (per CLAUDE.md architectural-discipline guidance — no outbox pattern). Workflow execution audit is in the same transaction as the workflow's actions.

---

## 4. Data model changes

### 4.1 New tables

| Table | Purpose | Section |
|---|---|---|
| `workflow_definition` | Per-tenant workflow identity (name + scope) | 3.1.1 |
| `workflow_version` | Immutable spec versions; one ACTIVE per definition | 3.1.1 |
| `task` | Polymorphic action queue (My Tasks substrate) | 3.2 |
| `delegation` | Approver delegation with date range + restrictions | 3.5 |
| `cis_user_manager` | Org-chart relations (multi-domain) | 3.7 |
| `broadcast` | Operator-to-operator broadcasts | 3.8 |

### 4.2 Modified tables

| Table | Change | Reason |
|---|---|---|
| `pending_administrative_change` (defined in doc 08) | Add `slaResponseHours`, `escalationConfig`, `escalatedAt`, `escalatedToUserId`, `escalatedFromConfig` | Escalation per FR-WF-100..104 |
| `pending_administrative_change` | Add `acted_by_user_id` and `authority_of_user_id` (replacing the implied single-actor model) | Delegation per FR-WF-092 |
| `notification` (defined in [13-notifications.md](../specs/13-notifications.md), extended by [11-notes-and-comments.md](./11-notes-and-comments.md)) | Add `category` enum column | Per-category preferences per FR-WF-040 |
| `notification` | Add `digestedAt` column | Per FR-WF-060 dedupe |
| `user_preference` | Define and Zod-validate the `preferences` JSON shape (no schema change; documentation + runtime validation) | Per FR-WF-050 |
| `tenant_config` | Add `notification_defaults` JSON, `delegation_max_dollar_default` (numeric), `escalation_default_sla_hours` (int) | Per FR-WF-053, FR-WF-094 |

### 4.3 New enums

```prisma
enum WorkflowVersionStatus { DRAFT  ACTIVE  RETIRED }
enum TaskStatus            { OPEN  IN_PROGRESS  COMPLETED  CANCELLED }
enum TaskPriority          { LOW  NORMAL  HIGH  URGENT }
enum NotificationCategory  { ASSIGNMENT  MENTION  ESCALATION  CUSTOMER_MESSAGE  SYSTEM  DIGEST  BROADCAST }
```

### 4.4 New SQL helpers

- `manager_of(user_id, domain)` (FR-WF-114).

### 4.5 RLS

All new tables get tenant RLS via `utility_id` per the existing pattern. `task` adds a per-user predicate so users see only their tasks + tasks for roles they hold + (for admins) all tasks. `delegation` is visible to delegator, delegate, and tenant admins.

### 4.6 Worker queues

- `workflow-engine` — consumes domain events; evaluates triggers/conditions; executes actions.
- `escalation-worker` — 5-min cron tick; scans `pending_administrative_change` for SLA breaches and reminder thresholds.
- `digest-builder` — scheduled per user's preferred cadence (daily/weekly).

---

## 5. Implementation sequence

### Phase 1 — Substrate (~5 weeks)

1. **`pending_administrative_change` from docs 01/08 — actually build it** (~1 week). Prerequisite for everything else. Includes the dual-approval flow and the delegation-aware actor fields (FR-WF-092).
2. **`task` table + creators + completers + `/my-tasks` page** (~1 week). Wires up SR assignment, comment mention (per doc 11), and approval-request task creation.
3. **`workflow_definition` + `workflow_version` schema + JSON spec validator + `workflow-engine` worker** (~2 weeks). Core engine. Migrate the SR `VALID_TRANSITIONS` map into a synthetic workflow row to validate end-to-end.
4. **`/settings/workflows` no-code rule builder UI (React Flow)** (~1 week). Visual builder; save as DRAFT; publish to ACTIVE; rollback. The per-trigger-type and per-action-type forms are templated.

### Phase 2 — User-facing surfaces (~3 weeks)

5. **`category` column on Notification + per-user preferences UI + Zod-validated JSON shape** (~3 days).
6. **`digest-builder` worker + DIGEST_DAILY / DIGEST_WEEKLY templates** (~3 days).
7. **`/dashboard` admin page + default widgets** (~1 week). My Tasks summary, Aged Approvals, Team Workload, Recent Mentions, System Health.
8. **Workflow visibility on entity detail pages** (~1 week). Current state chip, transition history list (driven by `audit_log` query), pending tasks, visual workflow path (React Flow read-only mode).

### Phase 3 — Approval flows (~3 weeks)

9. **`delegation` table + delegation creation UI + delegate-aware approval lookup** (~1 week).
10. **`cis_user_manager` table + `/settings/org-chart` page + bulk CSV import** (~1 week).
11. **`escalation-worker` + reminder notifications + escalation actions in `pending_administrative_change`** (~1 week).

### Phase 4 — Broadcasts + polish (~1 week)

12. **`broadcast` table + send UI + recipient fan-out** (~3 days).
13. **Permissions audit + role refactor** (~2 days). Confirm `tasks.read_team`, `delegations.admin`, `broadcasts.send`, `workflows.publish`, `workflows.publish_high_stakes` are wired correctly.

**Total: ~12 weeks** with one engineer; ~8-9 weeks with two parallel tracks (Phases 2 + 3 can overlap once Phase 1 lands).

Combined with the prior commitments: this doc's implementation lands on top of doc 11's notes-and-comments substrate and doc 01/08/10/12's `pending_administrative_change` substrate. If those haven't shipped yet, this doc's Phase 1 carries them — adding ~3-4 weeks to the total — for a realistic XL of ~15-16 weeks one-engineer.

---

## 6. Out of scope

1. **Free-form scripting in workflow rules** — operators cannot write JavaScript, Lua, or any imperative language inside a rule. The DSL is bounded (FR-WF-002). Custom logic is a feature request that becomes a new DSL primitive.
2. **AI-suggested rules / "auto-build a workflow from this conversation"** — Phase 5+.
3. **Cross-tenant workflow templates** — workflows are per-tenant; no marketplace, no template sharing across tenants.
4. **Real-time collaborative rule editing** — like doc 10, two operators editing the same DRAFT workflow version use the optimistic-locking + conflict-merge pattern from doc 10. No CRDT-style live co-editing.
5. **Customer-portal task surface** — portal customers don't have tasks. Their interaction is request-driven (file SR, view bill, pay). Adding a "tasks" notion to the portal is out of scope.
6. **Per-tenant notification categories** — categories are product-fixed (FR-WF-040). Adding tenant-defined categories is Phase 5.
7. **External calendar integration for delegations** — vacation auto-detected from Google Calendar / Outlook integrations is Phase 5+.
8. **SLA reporting dashboards** — beyond the per-entity workflow visibility (FR-WF-080), there's no aggregated SLA-performance dashboard ("90th percentile approval time per workflow"). Phase 5+.
9. **Escalation chains beyond 3 steps** — `escalationConfig.steps` supports up to 3 escalation levels in the initial release. Deeper chains are uncommon and produce confused accountability. Phase 5+ if real demand.
10. **Native mobile push for escalation reminders** — per [03-progressive-web-app.md](./03-progressive-web-app.md), web push is portal-only; admin uses email/SMS for time-sensitive reminders. Native push is Phase 5+.
11. **Workflow simulation / "what would happen if this rule fired against last week's data"** — useful operator tool but Phase 5+.
12. **Custom widgets on the dashboard** — Phase 1 ships fixed widget set per role; tenant-customizable widgets and per-user dashboard layouts are Phase 5+.
13. **Org chart from external HR system** — FR-WF-112 supports CSV import. Realtime sync from Workday/BambooHR/etc. is Phase 5+.
14. **Multiple simultaneous active versions of a workflow (A/B testing)** — only one ACTIVE per definition (FR-WF-001). Splitting traffic between two versions is Phase 5+.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Workflow rule misfires (e.g., approval auto-bypass via condition oversight) | **Critical** | High-stakes workflow publishing requires dual approval (FR-WF-014). Spec validation rejects logically broken DSL. Workflow audit row records every execution + the version + matched conditions. Rollback is a single click. |
| Workflow rule firing in an infinite loop (action triggers itself) | High | Workflow engine tracks per-event execution depth; depth > 5 aborts with `AUDIT_OPERATIONAL` warning. Rule builder warns when an action would trigger the same rule's trigger. |
| Delegate exceeds delegated authority | High | `maxDollarAmount` enforced at the approval-engine layer (FR-WF-094). Audit-log records both `acted_by_user_id` and `authority_of_user_id`. Operations dashboard tracks delegation usage; outliers reviewed. |
| Manager-of lookup returns null at escalation time | Medium | `escalationConfig.fallbackUserId` covers the gap (FR-WF-102). Operations dashboard tracks fallback usage; persistent fallbacks signal an org-chart gap to fix. |
| Notification preferences silently drop critical events | High | Workflow `overrideUserPreference` flag (FR-WF-054) bypasses preferences for genuine emergencies. Tenant admins audit override frequency to ensure operators aren't crying wolf. |
| Escalation worker fires twice (clock skew) | Medium | Idempotency on `pending_administrative_change.escalatedAt` — once set, the worker doesn't re-escalate. |
| Digest worker overwhelms email service on first run | Medium | Per-tenant digest schedule staggered by hash(tenantId) (NFR-WF-004 has 30-min budget — scheduling spread across the hour). Email-service rate limit configured per tenant. |
| Visual workflow path renders incorrectly for complex state machines | Low | React Flow with dagre layout handles up to ~50 nodes well; beyond that, layout degrades. Hard cap: workflows with >50 states fail validation (no real workflow has 50+ states; cap signals a misconfiguration). |
| Broadcast accidentally targets all customers (not operators) | High | `Broadcast.audience` schema doesn't allow `customer` audience kinds (FR-WF-124 — broadcasts are operator-only). Customer-targeted announcements use a separate path. |
| Org-chart tree explodes with cycles | Medium | Cycle detection at save time (FR-WF-113). Depth limit 8 levels. Validation rejects cycles. |
| Workflow rule references a field that was renamed in custom-fields (per doc 06) | Medium | Custom-field renames go through doc 06's draft + post pipeline (per doc 10) and at publish time emit a "fields referenced by N workflows" warning. Operators acknowledge before the rename completes; affected workflows are flagged for review. |
| `pending_administrative_change` becomes a hot table (many concurrent approvals + escalations) | Low | Existing partitioning pattern from doc 08 §3.3.1 applies (range-partitioned monthly by `requested_at`). Indexes on `(utility_id, status, expires_at)` keep dispatcher queries fast. |
| Delegation chained via multiple delegations (A→B, B→C — does C have A's authority?) | Low | Chained delegation is forbidden (FR-WF-095). Delegate cannot further delegate. |
| Self-delegation (vacation: I delegate to myself) | Low | Forbidden at API layer (FR-WF-095). |
| User in the org chart leaves the company; their reports lose their manager | Medium | Off-boarding workflow (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — covered by user-deactivation path) sets `effective_to` on all `cis_user_manager` rows where the user is manager. Ops dashboard surfaces orphaned reports for HR to reassign. |

---

## 8. Acceptance criteria (consolidated)

### Workflow rule engine
- [ ] `workflow_definition` and `workflow_version` tables exist with RLS.
- [ ] DRAFT/ACTIVE/RETIRED lifecycle works; only one ACTIVE per definition; rollback flips an old RETIRED to ACTIVE atomically.
- [ ] `workflow-engine` worker fires for every domain event and evaluates matching rules.
- [ ] Rule execution emits audit rows linking to the workflow version.
- [ ] Hardcoded SR `VALID_TRANSITIONS` map is migrated to a workflow row; behavior unchanged.

### No-code rule builder
- [ ] `/settings/workflows` page exists with list view + builder.
- [ ] Builder uses React Flow; drag-drop triggers/conditions/actions; save as DRAFT, publish to ACTIVE.
- [ ] High-stakes workflows (financial actions) require dual approval to publish.
- [ ] Spec is Zod-validated; invalid specs cannot publish.
- [ ] Version history shows side-by-side diffs.

### My Tasks / action queue
- [ ] `task` table exists with RLS.
- [ ] Tasks are created from approval requests, workflow assigns, SR assignments, comment mentions (when configured).
- [ ] `/my-tasks` page shows Open / In Progress / Recently Completed tabs.
- [ ] Bulk actions (claim, complete, reassign, defer) work.
- [ ] Team Tasks view available with `tasks.read_team`.

### Notifications
- [ ] `notification.category` column exists with the enum from FR-WF-040.
- [ ] `UserPreference.preferences.notifications` shape is Zod-validated; UI configures per category × per channel × per cadence.
- [ ] Digest worker runs per user's preferred schedule; renders DIGEST_DAILY / DIGEST_WEEKLY templates; marks notifications digestedAt.
- [ ] Empty digest is suppressed.
- [ ] Time-sensitive override flag bypasses preferences with audit.

### Dashboard widgets
- [ ] `/dashboard` admin page exists with default widget set.
- [ ] My Tasks, Aged Approvals, Team Workload, Recent Mentions, System Health widgets render correctly.

### Workflow visibility
- [ ] Entity detail pages with workflows show: current state chip + transition history + pending tasks + visual workflow path.
- [ ] Visual path uses React Flow read-only mode with current state highlighted.
- [ ] Transition history clicks deep-link to the workflow version + audit row.

### Delegation
- [ ] `delegation` table exists with RLS.
- [ ] Active delegation honored at approval-time; expired/revoked delegations are not.
- [ ] `maxDollarAmount` cap enforced.
- [ ] Audit row records both `acted_by_user_id` and `authority_of_user_id`.
- [ ] Self-delegation rejected. Chained delegation rejected.

### Org chart
- [ ] `cis_user_manager` table exists with RLS.
- [ ] `/settings/org-chart` page renders list + tree view.
- [ ] CSV bulk import works through doc 09 ingestion pipeline.
- [ ] Cycle detection rejects A→B→A; depth > 8 rejected.
- [ ] `manager_of()` SQL helper works.

### Escalation
- [ ] `escalation-worker` ticks every 5 minutes.
- [ ] Reminder notifications sent at configured `atHoursRemaining` thresholds.
- [ ] Escalation routes to `escalateTo` (user / role / manager_of); fallback applies if manager unset.
- [ ] Escalation events emit audit rows of class `AUDIT_OPERATIONAL`.
- [ ] Original approver and escalatee can both act; first to act wins.

### Broadcasts
- [ ] `broadcast` table exists with RLS.
- [ ] Sending a broadcast fans out to recipients per audience configuration.
- [ ] Customer audience kinds rejected (operators-only).
- [ ] Permission `broadcasts.send` required.

### Non-functional
- [ ] Workflow execution ≤500ms p99 (NFR-WF-001).
- [ ] My Tasks page ≤500ms p99 (NFR-WF-002).
- [ ] Dashboard ≤1s p99 (NFR-WF-003).
- [ ] Escalation worker tick latency ≤5min (NFR-WF-005).

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — `pending_administrative_change` (used as approval-request substrate); audit append-only enforcement
  - [05-customer-portal.md](./05-customer-portal.md) — portal-side notification scope (broadcasts are operator-side; portal customer notifications use a separate path)
  - [06-custom-fields.md](./06-custom-fields.md) — custom field references in workflow rule conditions; rename impact analysis
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `pending_administrative_change` generalized; retention class for workflow versions and broadcasts
  - [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) — org chart CSV bulk import reuses the ingestion pipeline
  - [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — workflow versioning reuses the single-table draft pattern; `WorkflowDefinition` is added to the doc-10 adoption list; concurrent rule edits use the optimistic-locking + conflict-merge UI
  - [11-notes-and-comments.md](./11-notes-and-comments.md) — IN_APP notification channel + bell icon + @-mentions + comment threads + internal-vs-customer flag (this doc adds workflow-task notifications and broadcasts on top)
  - [12-corrections-and-reversals.md](./12-corrections-and-reversals.md) — financial reversal approvals route through `pending_administrative_change` (escalation per FR-WF-100..104 applies)
  - [docs/specs/13-notifications.md](../specs/13-notifications.md) — notification template engine; channel infrastructure (extended with `category`)
  - [docs/specs/14-service-requests.md](../specs/14-service-requests.md) — SR state machine and SLA model; `Sla.escalationHours` and `Sla.escalationUserId` columns become functional with this doc's escalation worker
  - `packages/api/src/services/service-request.service.ts:33-41` — current hardcoded `VALID_TRANSITIONS` map (migrated to a workflow row)
  - `packages/api/src/lib/audit-wrap.ts` — existing audit wrapper used for workflow execution audit
  - `packages/shared/prisma/schema.prisma` — current schema (extended with the tables above)

- **External**:
  - React Flow (`@xyflow/react`) — visual workflow builder library
  - dagre — auto-layout algorithm used by React Flow for state-machine diagrams
  - Apptorflow (the company integration platform) — `external_event` triggers and `call_external` actions route through Apptorflow connectors

---

**End of doc 13.**
