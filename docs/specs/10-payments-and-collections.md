# Payments and Collections

**Module:** 10 — Payments and Collections
**Status:** Phase 3 — the ledger, posting, payment recording, allocation, reversal, fees, waivers and write-offs all shipped in module 23 (slices 1–3). **Payment plans: slice 1 shipped 2026-10-29** — the agreement, both suppression points, allocation, the lifecycle, the API and the two screens. Still outstanding here: the portal view of a customer's own plan and the SaaSLogic payment schedule (plan slices 2–3), the collections workflow, and write-off *approval*.
**Entities:** PaymentPlan, PaymentPlanDebit (both shipped), AdhocCharge (planned), WriteOff (planned). The ledger itself — `LedgerEntry`, `LedgerApplication`, `LedgerReasonDef` — lives in module 23.

## Overview

The Payments and Collections module manages all post-billing financial activity: the receivable itself, payment recording and allocation, late fees, payment plans for delinquent accounts, ad hoc charges and credits, and write-offs of uncollectable balances.

**Key architectural boundary (revised 2026-10-09):** **CIS owns the ledger.** An issued `Bill` increases what the account owes; a recorded payment reduces it. CIS owns the `Payment` record, allocation priorities, payment plan terms and write-off workflows.

SaaSLogic owns only **card data, the hosted payment page, and settlement**. CIS stores no card or bank account numbers and stays out of PCI scope. When a SaaSLogic payment settles, CIS records a `Payment` and posts it.

Crucially, SaaSLogic is one tender among several — cash, check and lockbox payments never touch it. That is why the ledger cannot live in the payment processor. This replaces the earlier boundary, under which SaaSLogic owned "all payment processing… and real-time posting" and CIS merely received webhooks to update account standing.

### Status of the gap

Closed on both the charge and the payment side. `Account.balance` is written from the ledger inside the posting transaction and reconciled by `GET /api/v1/ar/reconciliation`; delinquency therefore sweeps real receivables rather than seeded values. Money received of any tender is recorded by `POST /api/v1/accounts/:id/payments`, allocated against open charges in the module 23 §6.3 order, and reversible for NSF via `POST /api/v1/ledger-entries/:id/reverse`. Waivers and write-offs shipped with module 23 slice 3, each citing a tenant-defined reason and kept as separate acts so concessions and bad debt stay separately reportable. Still outstanding here: payment plans, the collections workflow, and *approval* of a waiver or write-off — which needs a request object outside the ledger, because posting is final and a waiver awaiting approval must not already have reduced the balance.

Primary users: billing clerks, collections staff, finance managers, CSRs (for account inquiries).

## Planned Entities

### PaymentPlan (slice 1 shipped 2026-10-29)

A deferred payment agreement: an account may pay a **named set of overdue
debts** by instalments, and the delinquency ladder leaves those debts
alone while it is kept. Design:
`docs/superpowers/specs/2026-10-26-payment-plans-design.md`.

**Nothing about a plan changes the balance.** Agreeing one posts no
ledger entry, moves no debt and leaves `Account.balance` alone; it
changes *when* money is chased, not *what* is owed. That is what lets
every balance query in the codebase stay ignorant of plans, and it is
the deliberate departure from Oracle CC&B, where a payment arrangement
is its own service agreement and the overdue debt is transferred onto
it.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope, FK → Utility |
| account_id | UUID | Composite FK → Account (utility_id, id) |
| status | ENUM | ACTIVE, COMPLETED, DEFAULTED, CANCELLED |
| total_balance | DECIMAL(14,2) | Sum of the covered debits' **`open_amount`** at creation, frozen. Not `amount`: a $110.75 charge with $55.37 left owes $55.37 |
| down_payment | DECIMAL(14,2) | Nullable. The **first payment**, due on `start_date` |
| installment_amount | DECIMAL(14,2) | The base instalment; the first carries any rounding remainder |
| installment_frequency | ENUM | WEEKLY, BIWEEKLY, MONTHLY |
| installment_count | INTEGER | Instalments after the down payment |
| start_date | DATE | The down payment's due date. Instalment *n* falls on `start_date + (n-1) × frequency`, month-end clamped |
| grace_days | INTEGER | Frozen at agreement |
| missed_before_default | INTEGER | Frozen at agreement |
| partial_installment_counts | BOOLEAN | Frozen at agreement |
| current_bill_counts | BOOLEAN | Frozen at agreement |
| suppress_fees_while_kept | BOOLEAN | Frozen at agreement |
| assess_suppressed_fees_on_default | BOOLEAN | Frozen at agreement |
| late_notice_installment | INTEGER | Nullable. Highest instalment already noticed as late, so a nightly sweep tells the customer once rather than every night |
| status_changed_at | TIMESTAMPTZ | When the status last moved. `updated_at` cannot answer "defaulted when?" |
| approved_by | UUID | FK → CisUser, RESTRICT. NOT NULL — a plan with no record of who agreed it is what the audit discipline forbids |
| notes | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

**Six ways this differs from the sketch it replaces**, each for a reason:

- **No `plan_type`.** INSTALLMENT, DEFERRED and LEVELIZED were three
  names for one mechanism; levelised billing is a *rating* feature, not
  a collections one.
- **No PENDING status.** An earlier draft had one for "agreed, down
  payment not yet received", with two transitions to leave it, and they
  changed nothing the system did — suppression began at agreement either
  way. The down payment is simply the first payment.
- **No `installments_paid`, `next_due_date` or `end_date`.** All three
  are derivable from `start_date`, the frequency, the count and the
  ledger, and a stored copy of a derivable figure is a copy that can
  disagree. `planProgress` computes them; there is no instalment table
  for the same reason.
- **The six judgement terms are columns on the row**, copied from the
  tenant's `paymentPlans` settings at agreement. A tenant lowering grace
  from five days to two must not break every plan already running.
- **`default_threshold` became `missed_before_default`**, and is joined
  by `grace_days`: late is not missed.
- **No `saaslogic_plan_id`.** Slice 3's business, once spec 21's vendor
  questions are answered.

### PaymentPlanDebit (slice 1)

Which debts a plan covers. Named explicitly rather than implied by a
`covers_debts_as_of` date, so a back-dated bill issued later cannot be
swept into an agreement nobody made about it, and `total_balance` can be
checked against the sum of what it covers.

| Field | Type | Notes |
|-------|------|-------|
| utility_id | UUID | PK part, FK → Utility |
| plan_id | UUID | PK part is `entry_id`; composite FK → PaymentPlan (utility_id, id) |
| entry_id | UUID | Composite FK → LedgerEntry (utility_id, id) |
| created_at | TIMESTAMPTZ | |

`PRIMARY KEY (utility_id, entry_id)` — a debit belongs to **at most one
plan**. The rows **persist after the plan ends**: they are history, and
every key is RESTRICT. Everything that asks "is this debt covered"
therefore joins through to `PaymentPlan.status` and reads `ACTIVE`;
testing membership of this table alone would suppress a debt forever,
including after default, *and would pass every test written while the
plan is still running*.
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

### PenaltyRule — withdrawn 2026-10-25, built on `DelinquencyRule` instead

This entity was planned here with `rule_name`, `account_type`,
`days_past_due`, `min_balance`, `is_active` and `effective_date`. Every
one of those is a column `DelinquencyRule` already has, and the
escalation an operator actually wants — $10 at 15 days, 1.5% at 30,
shut-off at 45 — is the tier ladder that already exists and is already
kept distinct by `@@unique([utility_id, account_type, tier])`. A
separate entity would have meant one row per rung anyway, two ladders to
maintain, and nothing keeping the two sets of thresholds in step.

So the fee went onto the tier. `fee_type`, `fee_amount`, `max_fee`,
`fee_reason_id` and `fee_mode` are columns on `delinquency_rule` — see
`docs/specs/11-delinquency.md`, which also records why the reason is
configuration rather than something the sweep could know.

**What would bring it back:** late fees on a cadence unrelated to
notices. The two share a schedule today because the tier that charges is
the tier that writes, and nothing has asked for a fee that fires where
no notice does.

---

## API Endpoints

All endpoints are planned for Phase 3.

### Payment Plans

Shipped in slice 1. Module `delinquency` — a plan is what a utility
offers instead of chasing, so it answers to the authority that
configures the ladder. `VIEW` to read, `CREATE` to agree, `EDIT` to
cancel: a CSR who may agree a plan at the counter is not thereby someone
who may tear one up.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/accounts/:id/payment-plans` | Plans for an account, newest first, each with derived `remaining`, `onTrack` and `installmentsBehind` |
| POST | `/api/v1/accounts/:id/payment-plans` | Agree a plan. Body names `entryIds`; answers with the derived schedule |
| GET | `/api/v1/payment-plans/:id` | Detail: derived progress, derived schedule, and each covered debt with its bill provenance |
| POST | `/api/v1/payment-plans/:id/cancel` | Cancel a live plan. Idempotent on one already ended |
| GET | `/api/v1/delinquency/plan-terms` | The tenant's terms |
| PUT | `/api/v1/delinquency/plan-terms` | Replace the terms namespace |

**There is no `PATCH`.** "Update plan terms (pre-active)" needed a
pre-active state, and there is none — a plan is ACTIVE from agreement.
Changing what was agreed means cancelling and agreeing another, which is
also what leaves an honest record.

**No top-level `GET /api/v1/payment-plans`.** A plan is one account's
arrears; nothing yet asks for every plan in the tenant, and the sweep
reads the table directly. It arrives when a Collections work-list does.

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

1. **CIS owns the ledger; SaaSLogic owns the card rail.** CIS never stores card or bank account numbers — card entry and settlement stay on SaaSLogic's hosted page. But CIS records every `Payment` regardless of tender, because cash, check and lockbox payments never pass through SaaSLogic. Posting is CIS's.

2. **Payment posting:** when a payment is recorded — whether from a settled SaaSLogic transaction or entered at the counter — CIS: (a) reduces what the account owes, (b) clears Account.status from SUSPENDED if the balance is resolved, (c) writes an AuditLog entry, (d) triggers a notification event (Module 13). All in one transaction, per the project's atomicity preference.

   **Nothing increments a counter on the plan.** The old (c) advanced
   `PaymentPlan.installments_paid` and `next_due_date`; neither column
   exists, because both are derivable and a counter would disagree with
   the ledger the moment money reached a covered debt by another route —
   a waiver, a write-off, or a customer paying more than the schedule
   asked. How far a plan has got is computed from what is still open on
   the debts it covers.

   What allocation *does* do differently on a plan: a payment settles
   **uncovered** debts first, and covered ones only once those are
   clear. Without that, a customer on a plan pays their current bill,
   the oldest-due rule puts it on the oldest arrears, the current bill
   stays open, and rule 7a below then defaults the plan — of a customer
   who paid exactly what they were asked to pay, on time. A payment
   marked against a plan goes to that plan's debits only, and any excess
   stays as a credit rather than spilling onto a debt the customer did
   not nominate.

3. **Payment allocation priority:** CIS allocates to charges in this priority order (configurable per tenant): (1) reconnection fees, (2) late fees and penalties, (3) oldest unpaid bills (FIFO by billing period). This is CIS logic now — previously it was described as rules communicated to SaaSLogic at integration setup.

4. **Overpayments:** if a payment exceeds the outstanding balance, CIS records a credit on the account and applies it to future bills. Previously delegated to SaaSLogic.

5. **Partial payments:** Allowed by default. Partial payment does not prevent continued late fee accrual on the remaining balance. Account status transitions to SUSPENDED only per delinquency rules (Module 11), not on partial payment alone.

6. **Late fee / penalty application (built 2026-10-25):** the delinquency sweep raises it, not a job of its own. A tier that configures `fee_type` and `fee_amount` charges through `assessFee` inside the same transaction that writes its `DelinquencyAction`, citing the reason the tier names. It is a `FEE` ledger entry on our own ledger — not an AdhocCharge, and not submitted to SaaSLogic, because CIS is the system of record for what is owed and SaaSLogic is told an amount. A percentage tier charges principal, excluding entries whose reason is itself a penalty. Bozeman Req 145; `docs/specs/11-delinquency.md` has the rules and the reasoning.

7. **Payment plan creation prerequisites:** A plan covers **named open
   debits**, not "the balance": at least one, each still open, none
   already in another plan, all on this account, and only one ACTIVE
   plan per account. `total_balance` is the sum of those debits'
   `open_amount`, frozen. Current-period bills accrue normally outside
   the plan unless the operator ticks them in — a bill charge that is
   not yet due opens **unticked**, so the proposed total is the
   account's past-due balance and Illinois' rule that an agreement
   includes the current bill is offered rather than assumed. A fee
   raised on a covered bill opens ticked, because leaving it out would
   suppress the bill while its own fee climbed the ladder days later.

7a. **What breaks a plan.** Either test: instalments *missed* (date plus
   `grace_days` passed) reaching `missed_before_default`, or — when
   `current_bill_counts` — an uncovered debit going past due. **Late is
   not missed:** an instalment inside grace leaves the plan ACTIVE with
   suppression intact, which is the state a CSR screen shows as "1
   payment behind". "Nothing uncovered" is not "an unpaid current bill":
   an account with no uncovered debt has nothing for the second test to
   look at and must not default because the question found no rows.

7b. **Completion is derived, never counted.** A plan is COMPLETED when
   every debit it covers is at `open_amount = 0`, whether that happened
   by payment, waiver or write-off. Counting instalments received would
   hold a plan open over debts that no longer exist — suppressing a
   ladder with nothing to suppress and waiting for money that will never
   arrive. Completion is settled before defaulting in the same pass,
   because a plan cannot be both and the answer must not depend on
   which question was asked first.

7c. **Ending a plan touches no money.** Cancelling and defaulting write
   no ledger entry, reverse none and move no debt: the covered debts
   return to the ladder exactly as they were, **at their real ages**. A
   consequence worth knowing: the next sweep then files every tier they
   qualify for, so a customer can receive the tier-1 email, the tier-2
   email and the tier-3 SMS in one night and then shut-off eligibility.
   That is correct by the rules and unpleasant in the inbox; fewer
   notices is the notification configuration's problem, not the plan's.

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
| 145 | Auto late fees/penalties | **Built 2026-10-25** — on `DelinquencyRule`, raised by the delinquency sweep (sp/11) |
| 146 | Write-off workflow | Phase 3: WriteOff entity + approval workflow |
| 147–148 | Payment plans | Phase 3: PaymentPlan entity |
| 149–150 | Aging dashboard (real-time) | Phase 3: AR aging from SaaSLogic data |
| 152–156 | Multi-account portal, third-party payer, payment allocation | Phase 4: customer portal |
| 157–164 | Payment processing (PCI, ACH, real-time posting, reversals) | Delegated to SaaSLogic; webhook integration Phase 3 |
