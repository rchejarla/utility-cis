# Delinquency

**Module:** 11 — Delinquency
**Status:** Phase 3 — design complete, implementation starting
**Entities:** `DelinquencyRule`, `DelinquencyAction`; new columns on `Account`

## Overview

The Delinquency module manages the lifecycle of past-due accounts — from initial detection through multi-tier notice escalation, shut-off eligibility, and resolution. It integrates with the Notification engine (Module 13) for automated notice delivery and will integrate with SaaSLogic payment webhooks (Module 10) and Service Requests (Module 14) when those modules ship.

Delinquency rules are tenant-configurable: each utility defines its own escalation timelines, notice types, balance thresholds, and shut-off policies in accordance with local ordinance.

Primary users: collections staff, billing supervisors, CSRs.

## Data Model

### Account — new columns

| Column | Type | Notes |
|---|---|---|
| `balance` | DECIMAL(14,2) | Current outstanding balance. Default 0. Updated manually by CSR or by future SaaSLogic webhook. |
| `last_due_date` | DATE | Most recent invoice due date. Nullable. Used by the evaluation job to compute days past due. |
| `is_protected` | BOOLEAN | Default false. Exempt from SHUT_OFF_ELIGIBLE and DISCONNECT actions. |
| `protection_reason` | TEXT | Nullable. Why the account is protected (e.g., "life support equipment", "extreme weather moratorium"). |

### DelinquencyRule

Tenant-configured escalation rules. One row per tier per account type. Rules form a chain: tier 1 triggers first, tier 2 triggers if tier 1 is unresolved after more days, and so on.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| name | VARCHAR(255) | "Past Due Reminder" |
| account_type | ENUM | Nullable — null means all account types |
| commodity_id | UUID FK | Nullable — null means all commodities |
| tier | INT | Escalation order: 1, 2, 3, 4... |
| days_past_due | INT | Days after due date to trigger this tier |
| min_balance | DECIMAL(10,2) | Minimum balance for this tier to apply |
| action_type | VARCHAR(50) | `NOTICE_EMAIL`, `NOTICE_SMS`, `DOOR_HANGER`, `SHUT_OFF_ELIGIBLE`, `DISCONNECT` |
| notification_event_type | VARCHAR(100) | Maps to a NotificationTemplate event type (e.g., `delinquency.tier_1`). Nullable for non-notice action types. |
| auto_apply | BOOLEAN | If true, nightly job triggers automatically. If false, requires staff action. |
| is_active | BOOLEAN | |
| effective_date | DATE | Rule takes effect on this date |
| created_at / updated_at | TIMESTAMPTZ | |

**Unique:** `(utility_id, account_type, tier)` — one rule per tier per account type per tenant. Null account_type = "default for all types."
**Index:** `(utility_id, is_active, tier)`

**Example rule chain:**
- Tier 1 (day 10, $25 min): NOTICE_EMAIL → `delinquency.tier_1`
- Tier 2 (day 20, $25 min): NOTICE_EMAIL → `delinquency.tier_2`
- Tier 3 (day 30, $50 min): NOTICE_SMS → `delinquency.tier_3`
- Tier 4 (day 35, $50 min): SHUT_OFF_ELIGIBLE → no notification
- Tier 5 (day 37, $50 min): DISCONNECT → `delinquency.tier_4`

### DelinquencyAction

One row per action taken or scheduled against an account. The audit trail of the entire delinquency lifecycle.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID FK | Which account |
| rule_id | UUID FK | Which rule triggered this |
| tier | INT | Copy of rule tier at trigger time (frozen) |
| action_type | VARCHAR(50) | Copy of rule action_type (frozen) |
| status | ENUM | `PENDING`, `COMPLETED`, `RESOLVED`, `CANCELLED` |
| balance_at_action | DECIMAL(10,2) | Balance when triggered (frozen) |
| days_past_due_at_action | INT | Days past due when triggered (frozen) |
| triggered_by | VARCHAR(20) | `AUTOMATED` or `MANUAL` |
| triggered_by_user_id | UUID | Nullable — for MANUAL triggers |
| notification_id | UUID FK | Nullable — links to the Notification row when a notice was sent |
| resolved_at | TIMESTAMPTZ | Nullable — when delinquency was resolved |
| resolution_type | VARCHAR(50) | Nullable — `PAYMENT_RECEIVED`, `PAYMENT_PLAN`, `WRITE_OFF`, `WAIVED` |
| notes | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

**Indexes:** `(account_id, status)`, `(utility_id, status, tier)`, `(rule_id)`

### Status lifecycle

```
PENDING → COMPLETED    (notification delivered or staff confirmed field work)
PENDING → RESOLVED     (payment received before action was carried out)
PENDING → CANCELLED    (staff waived, payment plan created, superseded)
COMPLETED → RESOLVED   (payment received after action was carried out)
```

On payment:
- Actions in `PENDING` → `CANCELLED` (no longer needed)
- The most recent action in `COMPLETED` or `PENDING` → `RESOLVED` with `resolution_type`
- Earlier `COMPLETED` actions stay `COMPLETED` (they are historical facts)

### Protected accounts

Accounts with `is_protected = true` are excluded from `SHUT_OFF_ELIGIBLE` and `DISCONNECT` action types. The evaluation job skips those tiers for protected accounts. Notice tiers (NOTICE_EMAIL, NOTICE_SMS) still apply — the customer still gets past-due reminders, they just cannot be shut off.

## Nightly Evaluation Job

Runs hourly inside the BullMQ worker process (`packages/api/src/worker.ts`). The dispatcher (`workers/delinquency-dispatcher.ts`) reads tenant config and enqueues a per-tenant `delinquencyTenant` job; the consumer (`workers/delinquency-worker.ts`) calls `evaluateDelinquencyForTenant(utilityId, now)` and updates `tenantConfig.delinquencyLastRunAt`. See `docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md` for the BullMQ architecture.

**Algorithm:**

1. Query all accounts where `balance > 0` and `lastDueDate IS NOT NULL`.
2. For each account, compute `daysPastDue = floor((today - lastDueDate) / 1 day)`.
3. Load active rules for this account's type, ordered by tier ascending.
4. For each rule where `daysPastDue >= rule.daysPastDue` and `balance >= rule.minBalance`:
   - Check if a DelinquencyAction already exists for this (account, rule). If yes, skip (no duplicate actions).
   - If account is protected and action_type is `SHUT_OFF_ELIGIBLE` or `DISCONNECT`, skip.
   - If `rule.autoApply` is false, skip (requires manual escalation).
   - Create DelinquencyAction with `status = PENDING`, `triggeredBy = AUTOMATED`.
   - If `rule.notificationEventType` is set, call `sendNotification()` and store the notification ID on the action.
5. For actions where the linked notification has reached `status = SENT`, update the action to `COMPLETED`.

**Tick interval:** hourly (same as suspension scheduler). Delinquency evaluation is not time-sensitive to the second — hourly is sufficient.

## API Endpoints

### Delinquency Rules

| Method | Path | Module | Description |
|---|---|---|---|
| GET | `/api/v1/delinquency-rules` | delinquency | List rules (filterable by account_type, is_active) |
| POST | `/api/v1/delinquency-rules` | delinquency | Create rule |
| GET | `/api/v1/delinquency-rules/:id` | delinquency | Get rule detail |
| PATCH | `/api/v1/delinquency-rules/:id` | delinquency | Update rule |
| DELETE | `/api/v1/delinquency-rules/:id` | delinquency | Deactivate rule |

### Delinquency Actions

| Method | Path | Module | Description |
|---|---|---|---|
| GET | `/api/v1/delinquency-actions` | delinquency | List actions (filterable by account, tier, status) |
| GET | `/api/v1/delinquency-actions/:id` | delinquency | Action detail |
| POST | `/api/v1/delinquency-actions/:id/cancel` | delinquency | Cancel a pending action |
| POST | `/api/v1/accounts/:id/delinquency/escalate` | delinquency | Manually escalate to next tier |
| POST | `/api/v1/accounts/:id/delinquency/resolve` | delinquency | Mark delinquency resolved |
| GET | `/api/v1/accounts/:id/delinquency` | delinquency | Full delinquency history for an account |

### Reporting

| Method | Path | Module | Description |
|---|---|---|---|
| GET | `/api/v1/delinquency/eligible-for-shutoff` | delinquency | Accounts at SHUT_OFF_ELIGIBLE tier |
| GET | `/api/v1/delinquency/summary` | delinquency | Counts by tier and total delinquent balance |

### Operations

| Method | Path | Module | Description |
|---|---|---|---|
| POST | `/api/v1/delinquency/evaluate` | delinquency | Manual trigger of the evaluation job (admin use) |

## UI Pages

### Delinquency Dashboard (`/delinquency`)

- Summary cards: accounts by tier, total delinquent balance, accounts eligible for shut-off, pending actions count
- Account list: sortable table showing account number, customer name, balance, days past due, current tier, last action date, status
- "Run Evaluation" button for manual trigger
- Filter by: tier, account type, balance range, status

### Shut-Off Eligibility Queue (`/delinquency/shutoff-eligible`)

- Table of accounts at SHUT_OFF_ELIGIBLE tier
- Per row: account number, customer, balance, days past due, last notice date, protection status
- Actions per row: Authorize Disconnect (creates DISCONNECT action), Waive (with reason), Mark Payment Plan
- Bulk authorize selected accounts
- Protected accounts shown but with a shield indicator and disabled disconnect button

### Account Detail — Delinquency Tab

- Timeline of all DelinquencyActions for this account, newest first
- Each action: tier, action type, status badge, date, balance at action, notification link
- Manual escalation and resolution buttons
- Current balance and days past due at the top
- Protection toggle (admin only)

### Settings → Delinquency Rules (`/settings/delinquency-rules`)

- Table of rules organized by tier
- Create/edit: tier, days past due, min balance, action type, notification event type (dropdown), auto-apply toggle
- Rule chain preview: shows the escalation timeline visually

## Sidebar

New **Collections** section in the sidebar with:
- Delinquency Dashboard
- Shut-Off Queue

## RBAC

New `delinquency` module added to MODULES constant. Permissions:
- System Admin / Utility Admin: full CRUD + evaluate
- CSR: VIEW + manual escalate/resolve
- Read-Only: VIEW

## Seed Data

- 5 sample delinquency rules (tier 1–5 as described in the example chain)
- Set balance and lastDueDate on a few seeded accounts so the evaluation job has something to process
- 2–3 sample DelinquencyActions showing different statuses

## Business Rules

1. **Tier progression:** tiers escalate sequentially. An account cannot skip tiers automatically. Each tier creates one action; if unresolved, the next tier triggers on the next evaluation cycle.
2. **No duplicate actions:** the evaluation job checks for existing actions per (account, rule) before creating. Re-running the job is idempotent.
3. **Protected accounts:** exempt from shut-off tiers. Notice tiers still apply.
4. **Resolution clears current tier:** when payment resolves delinquency, the current PENDING action → CANCELLED, the most recent active action → RESOLVED. Earlier COMPLETED actions are not touched.
5. **Partial payment:** if payment drops balance below the current tier's min_balance but not below a lower tier's, only the current tier resolves. The account drops back to the appropriate lower tier on the next evaluation cycle.
6. **Notification integration:** notice-type actions call `sendNotification()` with the rule's `notificationEventType`. The notification ID is stored on the action. When the notification reaches SENT status, the action transitions to COMPLETED.
7. **Manual escalation:** staff can escalate an account to the next tier without waiting for the nightly job. This creates a new action with `triggeredBy = MANUAL`.
8. **Audit trail:** all DelinquencyAction state changes are logged in AuditLog.

## Phase Roadmap

### Phase 3.1 (Building now)
- Account balance/lastDueDate/isProtected columns
- DelinquencyRule + DelinquencyAction entities
- Rule CRUD API + validators
- Action CRUD API (list, detail, cancel, escalate, resolve)
- Evaluation service + nightly job
- Notification integration (sendNotification calls)
- Reporting endpoints (eligible-for-shutoff, summary)
- Seed rules + test data
- Delinquency dashboard + shut-off queue UI
- Account detail delinquency tab
- Settings → Delinquency Rules
- RBAC module + permissions

### Phase 3.2 (After SaaSLogic billing)
- Auto-update balance and lastDueDate from SaaSLogic invoice/payment webhooks
- Auto-resolve delinquency on payment confirmation
- Reconnection fee as ad-hoc charge on resolution after disconnect

### Phase 3.3 (After Module 14 — Service Requests)
- DOOR_HANGER action creates a ServiceRequest of type DOOR_HANGER
- DISCONNECT action creates a ServiceRequest for field crew
- Reconnection ServiceRequest created on payment after disconnect
- DelinquencyAction.status updated on SR closure
