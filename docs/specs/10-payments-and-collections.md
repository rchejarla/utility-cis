# Payments and Collections

**Module:** 10 — Payments and Collections
**Status:** Stub (Phase 3)
**Entities:** PaymentPlan (planned), AdhocCharge (planned), WriteOff (planned)

## Overview

The Payments and Collections module manages all post-billing financial activity: payment processing, payment allocation, late fees, payment plans for delinquent accounts, ad hoc charges and credits, and write-offs of uncollectable balances.

**Key architectural boundary:** Payment processing (PCI compliance, ACH, credit card, real-time posting, reversals) is owned entirely by SaaSLogic. CIS does not store payment card numbers, bank account numbers, or process transactions. CIS owns the business rules — allocation priorities, payment plan terms, write-off workflows — and receives payment events from SaaSLogic via webhook to update account standing.

Primary users: billing clerks, collections staff, finance managers, CSRs (for account inquiries).

## Planned Entities

### PaymentPlan (planned)

Installment arrangement for accounts that cannot pay their balance in full. Negotiated by collections staff and tracked in CIS; payment execution is handled by SaaSLogic.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| plan_type | ENUM | INSTALLMENT, DEFERRED, LEVELIZED |
| status | ENUM | PENDING, ACTIVE, COMPLETED, DEFAULTED, CANCELLED |
| total_balance | DECIMAL(10,2) | Total amount included in plan at creation |
| down_payment | DECIMAL(10,2) | Nullable: required upfront payment |
| installment_amount | DECIMAL(10,2) | Amount per installment |
| installment_frequency | ENUM | WEEKLY, BIWEEKLY, MONTHLY |
| installment_count | INTEGER | Total number of installments |
| installments_paid | INTEGER | Default 0 |
| next_due_date | DATE | |
| start_date | DATE | |
| end_date | DATE | Calculated at creation |
| default_threshold | INTEGER | Number of missed installments before DEFAULTED |
| saaslogic_plan_id | UUID | Nullable: SaaSLogic payment schedule reference |
| approved_by | UUID | FK → User |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Status transitions:** PENDING → ACTIVE (on down payment received) → COMPLETED | DEFAULTED | CANCELLED

---

### AdhocCharge (planned)

One-time fees or credits applied to an account outside of the regular billing cycle. Examples: returned check fee, service call fee, reconnection fee, courtesy credit.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| service_agreement_id | UUID | Nullable FK → ServiceAgreement |
| charge_type | ENUM | FEE, CREDIT, ADJUSTMENT |
| description | VARCHAR(500) | |
| amount | DECIMAL(10,2) | Positive = charge; negative = credit |
| reason_code | VARCHAR(50) | e.g. RETURNED_CHECK, RECONNECTION, COURTESY_CREDIT, MISSED_COLLECTION |
| applied_date | DATE | |
| saaslogic_charge_id | UUID | Nullable: reference after submitted to SaaSLogic |
| status | ENUM | PENDING, SUBMITTED, ACCEPTED, REJECTED |
| applied_by | UUID | FK → User |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |

---

### WriteOff (planned)

Records the formal decision to write off an uncollectable balance. Requires supervisor approval and triggers a SaaSLogic credit memo.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| account_id | UUID | FK → Account |
| write_off_amount | DECIMAL(10,2) | |
| write_off_date | DATE | |
| reason | VARCHAR(500) | |
| reason_code | ENUM | BANKRUPT, DECEASED, UNCOLLECTABLE, SKIP, OTHER |
| status | ENUM | PENDING_APPROVAL, APPROVED, REJECTED, SUBMITTED |
| requested_by | UUID | FK → User |
| approved_by | UUID | Nullable FK → User |
| approved_at | TIMESTAMPTZ | |
| saaslogic_credit_id | UUID | Nullable: SaaSLogic credit memo reference |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |

---

### PenaltyRule (planned)

Tenant-configurable late fee rules applied automatically when payments are overdue.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| rule_name | VARCHAR(255) | |
| account_type | ENUM | Nullable: applies to all types if null |
| days_past_due | INTEGER | Days after due date before fee applies |
| fee_type | ENUM | FLAT_FEE, PERCENT_OF_BALANCE |
| fee_amount | DECIMAL(10,4) | Dollar amount or percentage (e.g., 0.015 = 1.5%) |
| max_fee | DECIMAL(10,2) | Nullable: cap on percentage-based fees |
| min_balance | DECIMAL(10,2) | Minimum balance required before fee applies |
| is_active | BOOLEAN | |
| effective_date | DATE | |
| created_at | TIMESTAMPTZ | |

---

## API Endpoints

All endpoints are planned for Phase 3.

### Payment Plans

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/payment-plans` | List plans (filterable by account, status) |
| POST | `/api/v1/payment-plans` | Create payment plan |
| GET | `/api/v1/payment-plans/:id` | Get plan detail with installment schedule |
| PATCH | `/api/v1/payment-plans/:id` | Update plan terms (pre-active) |
| POST | `/api/v1/payment-plans/:id/cancel` | Cancel an active plan |
| GET | `/api/v1/accounts/:id/payment-plans` | All plans for an account |

### Ad Hoc Charges

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/adhoc-charges` | List charges (filterable by account, type, date) |
| POST | `/api/v1/adhoc-charges` | Apply a charge or credit to an account |
| POST | `/api/v1/adhoc-charges/bulk` | Apply a fee to multiple accounts (e.g., all delinquent) |
| GET | `/api/v1/adhoc-charges/:id` | Get charge detail |
| DELETE | `/api/v1/adhoc-charges/:id` | Void a pending charge (pre-submission only) |
| GET | `/api/v1/accounts/:id/adhoc-charges` | All ad hoc charges for an account |

### Write-Offs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/write-offs` | Submit a write-off request |
| GET | `/api/v1/write-offs` | List write-offs (filterable by status, date) |
| GET | `/api/v1/write-offs/:id` | Get write-off detail |
| POST | `/api/v1/write-offs/:id/approve` | Supervisor approves write-off |
| POST | `/api/v1/write-offs/:id/reject` | Supervisor rejects write-off |
| GET | `/api/v1/accounts/:id/write-offs` | All write-offs for an account |

### Penalty Rules

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/penalty-rules` | List configured penalty rules |
| POST | `/api/v1/penalty-rules` | Create penalty rule |
| PATCH | `/api/v1/penalty-rules/:id` | Update rule |
| DELETE | `/api/v1/penalty-rules/:id` | Deactivate rule |

### Payment Event Webhook (SaaSLogic → CIS)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/webhooks/payment-received` | Payment posted in SaaSLogic |
| POST | `/api/v1/webhooks/payment-reversed` | Payment reversed in SaaSLogic |
| POST | `/api/v1/webhooks/plan-payment-received` | Installment payment received |
| POST | `/api/v1/webhooks/plan-defaulted` | Payment plan missed threshold |

## Business Rules

1. **SaaSLogic owns all payment processing.** CIS does not accept payment data (card numbers, bank accounts). All payment entry, PCI compliance, ACH processing, and real-time posting happens in SaaSLogic. CIS receives payment events via signed webhook.

2. **Payment event handling:** On `payment-received` webhook, CIS: (a) updates Account.status from SUSPENDED if balance is resolved, (b) increments PaymentPlan.installments_paid and updates next_due_date if account is on a plan, (c) creates an AuditLog entry, (d) triggers a notification event (Module 13).

3. **Payment allocation priority:** When a payment is received, SaaSLogic allocates to charges in this priority order (configurable per tenant): (1) reconnection fees, (2) late fees and penalties, (3) oldest unpaid invoices (FIFO by billing period). CIS communicates allocation rules to SaaSLogic during integration setup.

4. **Overpayments:** If payment exceeds outstanding balance, SaaSLogic records a credit balance on the account. CIS reflects this in account display. Credit application to future bills is handled by SaaSLogic.

5. **Partial payments:** Allowed by default. Partial payment does not prevent continued late fee accrual on the remaining balance. Account status transitions to SUSPENDED only per delinquency rules (Module 11), not on partial payment alone.

6. **Late fee / penalty application:** A nightly automated job evaluates all overdue accounts against active PenaltyRule definitions. If an account's balance has been past due for `days_past_due` days and meets the `min_balance` threshold, an AdhocCharge of type FEE is created automatically and submitted to SaaSLogic (Bozeman Req 145).

7. **Payment plan creation prerequisites:** A payment plan can only be created on an account with a positive balance. The total_balance at creation is the current balance at time of plan negotiation. Current-period bills accrue normally outside the plan unless the plan explicitly covers them.

8. **Payment plan default:** If an account misses `default_threshold` consecutive installments, the plan status transitions to DEFAULTED. CIS fires a domain event that ApptorFlow can use to trigger escalation (e.g., collections referral, shut-off workflow).

9. **Ad hoc charges require authorization:** Fee and ADJUSTMENT type charges above a configurable dollar threshold require supervisor-level role to create. CREDIT type charges always require supervisor authorization. Enforced via RBAC at API layer.

10. **Bulk ad hoc charges:** `POST /api/v1/adhoc-charges/bulk` requires a filter criteria body (e.g., all accounts with `delinquency_status=NOTICE_SENT`) and a confirmation step. Creates individual AdhocCharge records per account and batches submission to SaaSLogic.

11. **Write-off approval workflow:** Write-off requests enter PENDING_APPROVAL status. A supervisor (separate from the requester) must approve. On approval, CIS submits a credit memo request to SaaSLogic to zero the balance, then updates account standing. Rejected write-offs remain in the account's history.

12. **Deposit application:** When an account is closed (status → FINAL), the deposit balance (Account.deposit_amount) is applied to the final bill. If deposit exceeds final balance, the remainder is refunded via SaaSLogic. If deposit is insufficient, the remainder enters collections (Bozeman Reqs 20–21).

## UI Pages

All pages are planned for Phase 3.

### Payment Plans List (`/payment-plans`)

- Table: account number, customer name, plan type, total balance, installments paid/total, next due date, status badge
- Filters: status, date range
- Create plan button → plan creation form

### Payment Plan Detail (`/payment-plans/:id`)

- Plan terms and status
- Installment schedule: table of all installments with paid/due status
- Payment history: payments received from SaaSLogic webhook
- Cancel/modify actions
- Default warning if installments missed

### Account Collections Panel (within Account Detail)

- Outstanding balance (pulled from SaaSLogic)
- Active payment plan summary
- Late fees history
- Ad hoc charges and credits
- Write-off history
- "Apply Fee/Credit" action
- "Create Payment Plan" action
- "Submit Write-Off" action

### Ad Hoc Charges (`/adhoc-charges`)

- Table of all charges across accounts
- Filter by type, reason code, date, submitted/pending
- Bulk application form

### Write-Offs (`/write-offs`)

- Pending approval queue (supervisor view)
- Approve/reject actions with notes
- Write-off history by account

### Penalty Rules (`/settings/penalty-rules`)

- List of active penalty rules
- Create/edit rule form
- Effective date management
- Preview: shows which accounts would be affected by a new rule

## Phase Roadmap

- **Phase 1 (Complete):** Account.deposit_amount, deposit_waived fields. SaaSLogic account ID reference on Account.

- **Phase 2 (Planned):** Deposit refund workflow on account closure.

- **Phase 3 (Planned):**
  - PaymentPlan entity + API + UI
  - AdhocCharge entity + API + UI (individual and bulk)
  - PenaltyRule entity + automated late fee job
  - WriteOff entity + approval workflow
  - SaaSLogic payment event webhooks
  - Payment allocation rule configuration
  - Deposit application on final bill
  - Aging dashboard (surfaced in Module 09 billing dashboard)

- **Phase 4 (Planned):** Customer portal payment entry (via SaaSLogic embedded UI or redirect). Third-party payer portal (Bozeman Reqs 152–156).

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 20 | Deposit refund on close | Phase 2: deposit refund workflow |
| 21 | Apply deposit to unpaid charges | Phase 3: deposit application on final bill |
| 143–144 | Ad hoc fees (individual, all, subset) | Phase 3: AdhocCharge entity + bulk endpoint |
| 145 | Auto late fees/penalties | Phase 3: PenaltyRule entity + nightly job |
| 146 | Write-off workflow | Phase 3: WriteOff entity + approval workflow |
| 147–148 | Payment plans | Phase 3: PaymentPlan entity |
| 149–150 | Aging dashboard (real-time) | Phase 3: AR aging from SaaSLogic data |
| 152–156 | Multi-account portal, third-party payer, payment allocation | Phase 4: customer portal |
| 157–164 | Payment processing (PCI, ACH, real-time posting, reversals) | Delegated to SaaSLogic; webhook integration Phase 3 |
