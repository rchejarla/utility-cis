# Delinquency

**Module:** 11 — Delinquency
**Status:** Stub (Phase 3)
**Entities:** DelinquencyRule (planned), DelinquencyAction (planned)

## Overview

The Delinquency module manages the full lifecycle of account delinquency — from initial past-due detection through multi-tier notice escalation, shut-off eligibility determination, field work order generation (door hangers, shut-off, reconnection), and resolution. It integrates with the billing engine (Module 09), notifications (Module 13), service requests (Module 14), and payment processing (Module 10).

Delinquency rules are tenant-configurable, allowing each utility to define their own escalation timelines, notice types, and shut-off thresholds in accordance with local ordinance.

Primary users: collections staff, field operations supervisors, CSRs, billing administrators.

## Planned Entities

### DelinquencyRule (planned)

Tenant-configured rules that define escalation tiers, waiting periods, and actions at each tier.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| rule_name | VARCHAR(255) | |
| account_type | ENUM | Nullable: RESIDENTIAL, COMMERCIAL, INDUSTRIAL, MUNICIPAL; null = all |
| commodity_id | UUID | Nullable FK → Commodity; null = all commodities |
| tier | INTEGER | Escalation tier: 1 (first notice), 2, 3... |
| days_past_due | INTEGER | Days after due date to trigger this tier |
| min_balance | DECIMAL(10,2) | Minimum balance for this tier to apply |
| action_type | ENUM | NOTICE_EMAIL, NOTICE_SMS, NOTICE_MAIL, DOOR_HANGER, SHUT_OFF_ELIGIBLE, DISCONNECT |
| notice_template_id | UUID | Nullable FK → NotificationTemplate (Module 13) |
| auto_apply | BOOLEAN | If true, trigger is automatic on schedule; if false, requires staff action |
| is_active | BOOLEAN | |
| effective_date | DATE | |
| created_at | TIMESTAMPTZ | |

**Example rule chain:**
- Tier 1 (day 10, $25 min): NOTICE_EMAIL — past due reminder
- Tier 2 (day 20, $25 min): NOTICE_MAIL — formal notice with door hanger warning
- Tier 3 (day 30, $50 min): DOOR_HANGER — physical door notice, 48-hour warning
- Tier 4 (day 35, $50 min): SHUT_OFF_ELIGIBLE — account eligible for service disconnection
- Tier 5 (day 37, $50 min): DISCONNECT — field work order created

---

### DelinquencyAction (planned)

Records each delinquency action taken against an account — the audit trail of the delinquency lifecycle.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| service_agreement_id | UUID | Nullable FK → ServiceAgreement |
| rule_id | UUID | FK → DelinquencyRule |
| tier | INTEGER | Copy of rule tier at time of action |
| action_type | ENUM | Matches DelinquencyRule.action_type |
| status | ENUM | PENDING, SENT, COMPLETED, RESOLVED, CANCELLED |
| balance_at_action | DECIMAL(10,2) | Account balance when action was triggered |
| days_past_due_at_action | INTEGER | |
| triggered_by | ENUM | AUTOMATED, MANUAL |
| triggered_by_user | UUID | Nullable FK → User (for MANUAL) |
| resolved_at | TIMESTAMPTZ | Nullable: when delinquency resolved (payment received) |
| resolution_type | ENUM | Nullable: PAYMENT_RECEIVED, PAYMENT_PLAN, WRITE_OFF, WAIVED, REINSTATED |
| service_request_id | UUID | Nullable FK → ServiceRequest (for DOOR_HANGER/DISCONNECT) |
| communication_log_id | UUID | Nullable FK → CommunicationLog (Module 13) |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

## API Endpoints

All endpoints are planned for Phase 3.

### Delinquency Rules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/delinquency-rules` | List configured rules |
| POST | `/api/v1/delinquency-rules` | Create a rule |
| PATCH | `/api/v1/delinquency-rules/:id` | Update a rule |
| DELETE | `/api/v1/delinquency-rules/:id` | Deactivate a rule |

### Delinquency Actions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/delinquency-actions` | List actions (filterable by account, tier, status) |
| GET | `/api/v1/delinquency-actions/:id` | Get action detail |
| POST | `/api/v1/delinquency-actions/:id/cancel` | Cancel a pending action |
| POST | `/api/v1/accounts/:id/delinquency/escalate` | Manually escalate account to next tier |
| POST | `/api/v1/accounts/:id/delinquency/resolve` | Mark delinquency resolved (on payment confirmation) |
| GET | `/api/v1/accounts/:id/delinquency` | Full delinquency history for an account |

### Reporting

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/delinquency/eligible-for-shutoff` | Accounts at SHUT_OFF_ELIGIBLE tier |
| GET | `/api/v1/delinquency/summary` | Counts by tier and total delinquent balance |

## Business Rules

1. **Automated nightly evaluation:** A scheduled job runs nightly to evaluate all active service agreements against DelinquencyRule definitions. Accounts meeting tier criteria have DelinquencyActions created automatically if `auto_apply=true`.

2. **Tier progression:** Tiers escalate sequentially. An account cannot skip from Tier 1 to Tier 4 automatically. Each tier creates a DelinquencyAction; if unresolved, the account progresses to the next tier on the next evaluation cycle.

3. **Resolution clears delinquency:** When a payment event is received from SaaSLogic (Module 10 webhook), all open DelinquencyActions for the account are resolved with `resolution_type=PAYMENT_RECEIVED`. If the payment only partially resolves the balance, resolution only occurs when balance drops below the tier's `min_balance`.

4. **Payment plan stays delinquency:** Creating a payment plan (Module 10) can halt further delinquency escalation if the plan includes a `resolution_type=PAYMENT_PLAN` resolution on the current tier. New escalation resumes only if the payment plan defaults.

5. **Shut-off eligibility:** Accounts at the SHUT_OFF_ELIGIBLE tier are listed in the eligible-for-shutoff report. A supervisor must manually authorize the disconnect action (DISCONNECT tier), which then creates a ServiceRequest (Module 14) for field work.

6. **Protected accounts:** Certain accounts may be exempt from shut-off (e.g., life support equipment registered, extreme weather moratorium). This requires a protection flag on the Account entity (to be added in Phase 3). Protected accounts are excluded from DISCONNECT actions.

7. **Door hangers:** The DOOR_HANGER action creates a ServiceRequest of type DOOR_HANGER in Module 14. The field crew delivers the physical notice and marks the SR complete. The DelinquencyAction updates to COMPLETED on SR closure.

8. **Reconnection work orders:** After shut-off, when the account pays and resolves delinquency, a RECONNECT ServiceRequest is created automatically (Bozeman Req 199). Reconnection may require a reconnection fee (AdhocCharge via Module 10).

9. **Delinquency visibility in CSR:** Account lookups in the admin UI surface an active delinquency indicator when any DelinquencyAction is in PENDING or SENT status (Bozeman Req 23). The indicator shows current tier and next action.

10. **Municipal accounts:** MUNICIPAL account type may have different rules (e.g., no automatic shut-off). Handled by creating separate DelinquencyRule rows with `account_type=MUNICIPAL` and appropriate action types (omitting DISCONNECT).

11. **Audit trail:** All DelinquencyAction state changes are logged in AuditLog with actor, timestamp, and before/after state. Manual escalations include the user who triggered them.

12. **Notification integration:** NOTICE_EMAIL and NOTICE_SMS action types trigger notification sends via Module 13. The `notice_template_id` on the rule references a NotificationTemplate. The resulting CommunicationLog ID is stored on the DelinquencyAction.

## UI Pages

All pages are planned for Phase 3.

### Delinquency Dashboard (`/delinquency`)

- Summary cards: accounts by tier (Tier 1, 2, 3+), total delinquent balance, accounts eligible for shut-off, pending door hangers
- Aging breakdown chart (30/60/90/120+ days)
- "Run Delinquency Evaluation" manual trigger (in addition to nightly automatic)
- List: accounts by tier with balance, days past due, last action

### Shut-Off Eligibility Queue (`/delinquency/shutoff-eligible`)

- Table of SHUT_OFF_ELIGIBLE accounts
- Per-row: account, customer, balance, days past due, last notice date
- Actions: Authorize Disconnect (creates DISCONNECT DelinquencyAction + ServiceRequest), Waive (with reason), Mark Payment Plan
- Bulk authorize selected accounts
- Filter: by commodity, account type, balance threshold

### Account Delinquency Detail (within Account Detail tab)

- Current delinquency tier indicator
- Timeline of all DelinquencyActions: tier, action type, date, status, resolution
- Links to associated ServiceRequests and CommunicationLogs
- Manual escalation and resolution actions

### Delinquency Rules Configuration (`/settings/delinquency-rules`)

- Table of rules organized by account type and tier
- Edit rule: days_past_due, min_balance, action_type, notice template
- Rule chain preview: visualizes the escalation timeline for a given account type
- Enable/disable individual rules

## Phase Roadmap

- **Phase 1 (Complete):** Account.status includes SUSPENDED. AuditLog for all changes.

- **Phase 3 (Planned):**
  - DelinquencyRule entity + configuration UI
  - DelinquencyAction entity + lifecycle management
  - Nightly automated delinquency evaluation job
  - Integration with SaaSLogic payment webhooks (Module 10) for resolution
  - Integration with NotificationTemplate (Module 13) for notice sending
  - Integration with ServiceRequest (Module 14) for door hangers and disconnect/reconnect work orders
  - Delinquency dashboard and shut-off eligibility queue
  - Account-level delinquency status indicator in CSR UI
  - Protected account flag (life support, weather moratorium)
  - Reporting: aging summary, shut-off report

- **Phase 4 (Planned):** Customer portal alerts for delinquency status. Self-service payment to resolve delinquency.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 23 | Delinquency flagging visible during lookup | Phase 3: delinquency indicator on account lookup |
| 124 | Shut-off rules | Phase 3: DelinquencyRule with SHUT_OFF_ELIGIBLE action |
| 125 | Multi-tier notices | Phase 3: tier-based rule chain with configurable notice types |
| 126 | Auto-identification of shut-off candidates | Phase 3: nightly job + shut-off eligibility queue |
| 127 | Delinquency reporting | Phase 3: aging dashboard, shut-off report |
| 151 | Shut-off eligibility rules | Phase 3: SHUT_OFF_ELIGIBLE tier action |
| 198 | Delinquency work orders (door hangers, shut-offs) | Phase 3: DOOR_HANGER and DISCONNECT DelinquencyActions → ServiceRequests |
| 199 | Reconnection work orders | Phase 3: auto-created RECONNECT ServiceRequest on payment resolution |
