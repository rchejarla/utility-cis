# Delinquency

**Module:** 11 — Delinquency
**Status:** Phase 3 — design complete, implementation starting
**Entities:** `DelinquencyRule`, `DelinquencyAction`; new columns on `Account`

## Overview

The Delinquency module manages the lifecycle of past-due accounts — from initial detection through multi-tier notice escalation, shut-off eligibility, and resolution. It integrates with the Notification engine (Module 13) for automated notice delivery and will integrate with payment recording in Accounts Receivable (Module 23), which is what SaaSLogic's payment webhooks (Module 21) feed, and with Service Requests (Module 14) when those ship.

Delinquency rules are tenant-configurable: each utility defines its own escalation timelines, notice types, balance thresholds, and shut-off policies in accordance with local ordinance.

Primary users: collections staff, billing supervisors, CSRs.

## Data Model

### Account — new columns

| Column | Type | Notes |
|---|---|---|
| `balance` | DECIMAL(14,2) | Current outstanding balance. Default 0. A cache: recomputed from the AR ledger inside the posting transaction when a Bill posts (see module 23). |
| `last_due_date` | DATE | The **oldest open debit's** due date — not, despite the name, the most recent invoice's. Nullable: null when nothing is open. A cache written by AR posting (module 23) alongside `balance`. The evaluation job reads it to compute days past due, so an account carrying a six-month-old unpaid bill and a current one ages from the old one. Renaming the column is a module 23 slice 5 item. |
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
| effective_date | DATE | Rule takes effect on this date. **Gated since 2026-10-25:** a tier fires only where `effective_date <= account.last_due_date`. |
| fee_type | ENUM | Nullable — `FLAT_FEE`, `PERCENT_OF_BALANCE`. Null for a tier that charges nothing, which is every tier before 2026-10-25. |
| fee_amount | DECIMAL(10,4) | Nullable — an amount under FLAT_FEE, a rate under PERCENT_OF_BALANCE (0.0150 = 1.5%) |
| max_fee | DECIMAL(10,2) | Nullable — caps a percentage fee. CHECK refuses it on a flat one, which is its own cap. |
| fee_reason_id | UUID FK | Nullable — the `ledger_reason_def` the fee cites. Composite FK `(utility_id, fee_reason_id)`. |
| fee_mode | ENUM | `ACCUMULATE` (default) or `REPLACE_LOWER_TIERS` |
| service_request_type_code | VARCHAR(100) | Nullable — the work order this tier dispatches, by type code. No FK: see below. |
| reconnect_request_type_code | VARCHAR(100) | Nullable — the request raised when the account clears |
| created_at / updated_at | TIMESTAMPTZ | |

**CHECKs on the fee columns.** `fee_type`, `fee_amount` and
`fee_reason_id` are all set or all null — an amount with no reason is a
charge nobody can explain, a reason with no amount is dead configuration
that reads as if the tier charges something. `fee_amount > 0`. `max_fee`
only with `PERCENT_OF_BALANCE`. `fee_mode = 'REPLACE_LOWER_TIERS'` only
on a tier that charges, because otherwise the mode becomes a way to
spell "cancel the earlier late fees" — and forgiving a charge is a
waiver someone decided to grant, not a side effect of a schedule.

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
| fee_entry_id | UUID FK | Nullable — the `ledger_entry` this action raised. Composite FK `(utility_id, fee_entry_id)`. This link is how a replacing tier finds the fees the ladder owns. |
| resolved_at | TIMESTAMPTZ | Nullable — when delinquency was resolved |
| resolution_type | VARCHAR(50) | Nullable — `PAYMENT_RECEIVED`, `PAYMENT_PLAN`, `WRITE_OFF`, `WAIVED` |
| notes | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

**Indexes:** `(account_id, status)`, `(utility_id, status, tier)`, `(rule_id)`

**Partial unique index** `delinquency_action_one_live_per_rule` on
`(utility_id, account_id, rule_id) WHERE status IN ('PENDING','COMPLETED')`.
SQL only — Prisma cannot express a partial unique index, so `migrate dev`
would propose dropping it.

It exists because `evaluateAll`'s own guard is an in-memory `Set` built
before its loop, which cannot see another process: the sweep runs hourly
with BullMQ retries behind it, so two `delinquency-tenant` jobs for one
tenant each build that `Set` separately. Partial on the two live
statuses, because a RESOLVED or CANCELLED action is history and must not
lock an account out of its own ladder. A losing insert is caught as
P2002 and the account skipped, not the tenant's sweep failed.

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
2. For each account, compute `daysPastDue = floor((today - lastDueDate) / 1 day)`. Since AR slice 1, `lastDueDate` is the oldest open debit's due date, so this is age of the oldest unpaid charge — not age of the latest bill. Covered by `delinquency-aging.integration.test.ts`.
3. Load active rules for this account's type, ordered by tier ascending.
4. For each rule where `daysPastDue >= rule.daysPastDue` and `balance >= rule.minBalance`:
   - Check if a DelinquencyAction already exists for this (account, rule). If yes, skip (no duplicate actions).
   - If account is protected and action_type is `SHUT_OFF_ELIGIBLE` or `DISCONNECT`, skip.
   - If `rule.autoApply` is false, skip (requires manual escalation).
   - Skip a rule whose `effective_date` is later than the account's `last_due_date`: it was not in force when the debt came due.
   - If `rule.notificationEventType` is set, call `sendNotification()`.
   - In one transaction: if the tier replaces, reverse the ladder's lower-tier fees; if it charges, raise the fee through `assessFee`; then create the DelinquencyAction naming that fee in `fee_entry_id`.
5. For actions where the linked notification has reached `status = SENT`, update the action to `COMPLETED`.
6. `sweepReconnections(utilityId)`, then `sweepDelinquencyWorkOrders(utilityId)` — the field work, in that order.

## What charges, and why it is shaped this way

Built 2026-10-25. Each of these was a decision with a rejected
alternative, recorded so the next reader does not have to re-derive it.

**The fee commits with the action, in one transaction.** The rejected
alternative was two statements. An account marked delinquent with no
charge, or charged with no record of which tier did it, are both worse
than a sweep that fails and can be re-run — and a duplicate fee is a
wrong bill. The fee is written first so the action names it in a single
insert, which also means a unique violation on the partial index above
rolls the fee back with it. The **notification stays outside and after**
the transaction: an external dispatch inside one holds a database lock
across someone else's network call, and a notice that fails to send
leaves `status` PENDING, which is what that column is for.

**A tier charges once per delinquency episode, and the gate is the
money rather than the action.** The partial unique index stops a second
*live* action, which is what keeps duplicates out of one sweep and out
of a concurrent one. It cannot stop a re-charge, because it is
deliberately partial: a cancelled or resolved action leaves the account
past due with nothing live, and the next hourly tick would charge the
tier again. A CSR pressing Cancel does exactly that, and
`resolveAccount` — granting a payment plan — cancels every PENDING
action at once, so an account on three charging tiers would be
re-charged all three, and again on every later resolve.

So a tier does not charge while its own last fee is **outstanding**,
meaning open or reversed. An open fee has not been dealt with; a
reversed one was somebody deciding the customer does not owe it, which
an hourly sweep must not overrule. Only a fee paid in full and not
reversed clears the way — which is also what ending an episode looks
like, so a customer who clears their balance and falls behind on a later
bill is charged again rather than paying one late fee per account per
lifetime.

**The episode closes for every tier, not only shut-off ones.**
`sweepReconnections` resolves every live action on an account whose
balance has reached zero. Filtering it on `reconnect_request_type_code`
was the first reading of #199 and it left the notice tiers — the ones
that charge the late fees — live forever, since nothing else resolves an
action: `resolveAccount` has one caller, a route. A reconnection request
is still raised only where the tier names one and the shut-off was
actually carried out.

**The notice is sent after the money commits, and outside its
transaction.** An external dispatch inside a transaction holds a
database lock across someone else's network call, and a notice that
fails to send must leave the action PENDING, which is what that status
is for. The ordering also matters on the failure path: a sweep that
rolls back — on a reason retired after the rule cited it — used to leave
a notice behind every hour while never writing an action or a fee.

**Replacement happens only once this tier knows it will charge.** The
reversal used to run first, so a percentage tier whose base rounded to
nothing reversed the fee below it and raised nothing in its place. That
is forgiveness arriving as a side effect of a schedule — the thing
`delinquency_rule_replace_needs_fee` exists to forbid — and the CHECK
could not see it, because it constrains configuration and this is an
outcome.

**The work-order sweep asks about the account, not only the action.**
`evaluateAll`'s protected-account guard keys on `action_type`, while
dispatch keys on the tier's `service_request_type_code`, so a tier with
a notice action type and a shut-off work order reached a protected
account. The sweep now requires `is_protected = false`, an ACTIVE
account that still owes something, and an active rule — the last
because `DELETE` on a rule only clears `is_active`, and an account that
has since paid should not have a crew sent to it.

**Which reason the fee cites is configuration on the tier.** The
rejected alternative was any code the service could have known: there is
none, because reason codes are tenant-configurable and a utility that
names its own "Late charge" would be missed by any list this codebase
could hold. `fee_reason_id` is a composite FK, so a tier cannot cite
another tenant's reason.

**That reason is validated when the rule is saved**, by the same
`resolveReason` gate `assessFee` uses — `prisma` satisfies its
transaction-client type, so it is literally the same gate and the same
vocabulary (404 `REASON_NOT_FOUND`, 422 `REASON_TYPE_MISMATCH`). Both
layers stay: the save-time one is for the operator, since otherwise a
tier saved against an `ADJUSTMENT_DEBIT` reason throws at 03:00 inside a
worker, possibly after other accounts in the tenant have been noticed.
The sweep-time one stays because a reason can be retired after a rule
cites it, and then the sweep must fail rather than charge.

**A percentage charges principal.** The base is the sum of open amounts
over entries whose reason is not a penalty (`LedgerReasonDef.isPenalty`),
excluding `DEPOSIT`. Excluding every `FEE` was the obvious rule and the
wrong one: it would stop a late fee applying to an unpaid tap fee, which
is money owed for work actually done. Including penalties charges 1.5%
of the previous tier's own late fee. Open credits reduce the base, and
the base is clamped at zero.

**Replacement walks `fee_entry_id`, never a reason.** A
`REPLACE_LOWER_TIERS` tier reverses the fees *this ladder* raised at
lower tiers of the same `account_type`. A returned-payment fee and a
late fee a CSR added by hand have no delinquency action, so neither is
reachable, whatever the tenant has named its reasons — the question is
ownership, not category. A fee already reversed is skipped:
`reverseEntry` refuses a second reversal with a 409, and the state is
reachable because `resolveAccount` resolves only the highest live tier.

**Reversing a paid fee returns the payment to credit**, which the new
fee then absorbs: $10 paid, $25 raised, $15 still owed on fees and no
money missing. Whether a bill nets that into one line or shows the
reversal and the re-allocation is billing policy; the ledger is
unambiguous either way.

**The work orders are sweeps, not part of the transaction.** The
rejected alternative was threading `existingTx` through
`nextRequestNumber`, which opens a transaction of its own for the
counter row — a nested call would hold a second pooled connection while
the first holds the account lock, and under an hourly fan-out across
tenants that is how a pool runs dry. The deciding asymmetry is simpler
than that, though: a *late* work order costs nothing, a *duplicate* fee
is a wrong bill. So the money is atomic and the dispatch is eventually
correct. Both sweeps are keyed on state, which makes them idempotent by
construction and lets them recover when the service request module was
unavailable.

**A reconnection is asked for only where the disconnection happened** —
the shut-off request exists and is `COMPLETED`. An account that paid
before a crew went out has nothing to turn back on. The action resolves
either way, with `resolution_type` read from the ledger's most recent
credit rather than assumed, because a balance can reach zero by being
written off and recording that as a payment received would put a
falsehood in the collections record.

**The type codes have no foreign key.** `service_request_type_def`
admits global rows with a null `utility_id`, which a tenant-scoped
composite key cannot reference, and a single-column key to a table whose
rows may be global would let one tenant's rule point at another's
private type. `assertServiceRequestTypeCode` validates them when the
rule is saved, and the sweep skips a code deactivated since rather than
failing the tenant's whole pass over one account.

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

### Delinquency Rules (`/delinquency/rules`)

- Table of rules organized by tier
- Create/edit: tier, days past due, min balance, action type, notification event type (dropdown), auto-apply toggle
- Rule chain preview: shows the escalation timeline visually

**The fee and work-order fields (built 2026-10-25).** Two more groups
in the editor: *Late fee* — what it charges (nothing, a flat amount, or a
percentage), the amount or rate, an optional cap on a percentage, the
FEE reason it books to, and whether a higher tier keeps or replaces it —
and *Field work*, the work order this tier raises and the reconnection
request raised when the balance clears. The table gains a **Late Fee**
column so the whole ladder's charges read at a glance.

The editor holds the rate in the operator's units, not the column's.
`fee_amount` stores a rate — 0.0150 is 1.5% — and the field is labelled
`Rate (%)`, so the conversion happens once on save and once on load. A
test pins it, because sending the typed number straight through gives
the tenant a 0.015% late fee that every constraint accepts and nobody
notices for months.

The three fee fields are always sent as a group, which is what the API
requires and which also sidesteps `feeMode` being refused on its own.

**Both pickers depend on other modules** — `ar_adjustments:VIEW` for the
fee reasons, `service_requests:VIEW` for the type codes — so a role
holding only delinquency permissions cannot populate them. The field
says which permission is missing rather than showing an empty dropdown,
which would read as "this tenant has none".

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
- The seeded payments deliberately land on a billed account rather than on either delinquent one, so the two opening balances this module's demo depends on stay untouched.
- Two seeded accounts get an opening-balance `ADJUSTMENT_DEBIT` written straight into the ledger, with `balance` and `lastDueDate` written to match on the account row, so the evaluation job has ledger-backed balances and `GET /api/v1/ar/reconciliation` reports no drift on a fresh seed. The seeder deliberately does not go through `generateBillForAccount` or `postBill` — that would drag rate schedules and meter reads into seeding a balance
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
- Payment-driven balance updates: recording a payment recomputes balance and lastDueDate from the ledger (module 23 slice 2), and SaaSLogic payment results feed the same path
- ~~Auto-resolve delinquency on payment confirmation~~ — **done 2026-10-25**, but on *state* rather than on a payment event: `sweepReconnections` asks which live actions have a cleared balance. Hanging it off `recordPayment` would have put collections in the money path, so taking a payment could fail because the service request module refused.
- Reconnection fee as ad-hoc charge on resolution after disconnect — still open. The `RECONNECT_FEE` reason is seeded and `assessFee` would raise it; nothing decides when.

### Phase 3.3 (After Module 14 — Service Requests) — **done 2026-10-25**
- ~~DOOR_HANGER action creates a ServiceRequest of type DOOR_HANGER~~ · ~~DISCONNECT action creates a ServiceRequest for field crew~~ — generalised: any tier that names a `service_request_type_code` dispatches that type, because the codes are the tenant's own and a utility whose crews work off their own system wants the notice tiers and no work orders at all.
- ~~Reconnection ServiceRequest created on payment after disconnect~~ — and only where the disconnection was actually carried out, so an account that paid before a crew went out has no-one sent in either direction.
- ~~DelinquencyAction.status updated on SR closure~~ — **inverted, deliberately.** The action resolves when the *balance* clears, not when a work order closes; a closed shut-off request is instead the evidence that there is something to turn back on. Closing a work order says a crew did what it was told, which is not the same as the debt being settled.

### Still open in collections
- Payment plans (#147, #148) — no entity. This slice is what makes one worth offering: until now the ladder decided and nothing happened.
- The aging dashboard (#149, #150).
- The fee and work-order fields on the rules form (see the UI section).
