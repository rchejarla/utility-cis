# 12 — Corrections & Reversals of Posted Financial Transactions

**RFP commitment owner:** Split between **SaaSLogic Billing** (the financial system of record — owns invoices, payment ledger, payment reversals, NSF processing per [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md)) and **SaaSLogic Utilities** (originates `BillingRecord` rows that drive invoicing, owns adjustments / credit-memo issuance against an account, owns NSF posting on the CIS side, mirrors invoice + payment state from SaaSLogic, surfaces net-effect history for operators and customers). The boundary matters: a payment reversal is a SaaSLogic event that CIS receives via webhook; an adjustment reversal is a CIS event that CIS authors and pushes to SaaSLogic. This doc captures the CIS-side requirements and explicitly identifies what's delegated to SaaSLogic Billing.
**Status:** Drafted — **virtually no implementation.** The financial substrate (Bill/Invoice/Payment/Adjustment/NSF/Reversal/Ledger) does not exist in the schema yet. Module 09 (Billing) and Module 10 (Payments & Collections) are Phase 3 stubs. The webhook handlers from SaaSLogic (`/webhooks/payment-received`, `/webhooks/payment-reversed`) are designed in spec 21 but not built. The closest implemented analog is `ServiceSuspension`'s requestedBy/approvedBy approval pattern — operational, not financial. The audit framework exists at a foundation level but lacks the `event_class = FINANCIAL` classification + 7-year retention floor that this RFP claim leans on. `Account.balance` exists as a column but is never written by any code path.
**Effort estimate:** XL (~14-18 weeks). This isn't one feature; it's the financial substrate of the system. The work spans: building Module 09 BillingRecord with versioning + voids, building Module 10 Adjustment with reversal semantics, building NSF as a first-class operation, building the SaaSLogic webhook handlers for payment-received and payment-reversed, adding `event_class = FINANCIAL` to audit_log + the per-class retention floor (already specced in docs 01 and 08), implementing configurable approval thresholds, and implementing net-effect reporting that handles voids/reversals/adjustments correctly. Pieces of this depend on doc 01 (audit append-only enforcement), doc 08 (retention class infrastructure), and doc 11 (notes/comments on financial transactions). The doc itself is short by RFP-doc standards because most of the substrate is owned by [docs/specs/09-billing.md](../specs/09-billing.md), [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md), and [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md); this doc adds the correction/reversal-specific commitments on top.

---

## 1. RFP commitment (verbatim)

> Posted financial transactions are not silently edited; corrections are made by issuing reversing or adjusting transactions that maintain the audit trail. Bill voids, payment reversals, NSFs, and adjustment reversals are first-class operations with reason codes, approval requirements (configurable), and full audit-log capture. Reporting always reflects net effect.

The commitment decomposes into **seven guarantees**:

1. **Posted financial transactions are not silently edited.** Once an entity has crossed into a posted financial state, mutations to its monetary fields are forbidden. Corrections are issued as **separate, traceable entities** that reference the original.
2. **Corrections are reversing or adjusting transactions.** Two distinct mechanisms — full reversal (undoes the original) vs. adjustment (modifies net effect without erasing the original).
3. **Bill voids are first-class.** A bill that should not have been issued (wrong customer, wrong period, fraud) is voided — not deleted. The void is auditable.
4. **Payment reversals are first-class.** Including NSF reversals (the bank pulled the money back), customer-disputed reversals, and operator-initiated reversals.
5. **NSFs are first-class.** A returned-check fee is a posted charge with a defined reason code and an attached source-payment reference.
6. **Adjustment reversals are first-class.** An adjustment that was wrong (CSR error, supervisor reversed approval) is undone via a reversing adjustment, not a delete.
7. **Reason codes + configurable approval + audit + net-effect reporting.** Every operation above carries a code, gates on approval thresholds, emits audit, and the resulting reports show the **net** balance — not just the gross of original transactions.

This doc is the **operational policy layer** on top of the financial substrate. It does NOT design the substrate (that's specs 09, 10, 21). It commits the rules that govern how every reversal/correction operation across that substrate behaves.

---

## 2. Current state — what exists today

### 2.1 No financial entities exist ✗

**Status: Not implemented.** A grep across `schema.prisma` for `Bill`, `Invoice`, `Payment`, `Adjustment`, `NSF`, `Reversal`, `Ledger`, `Journal`, `FinancialTransaction`, `BillingRecord`, `AdhocCharge`, `WriteOff` returns zero matches.

The schema has 17 entities; none are financial transactions. Module 09 (Billing) and Module 10 (Payments & Collections) are Phase 3 stubs per their respective specs. The relevant planned entities — `BillingRecord`, `AdhocCharge`, `WriteOff`, `PenaltyRule`, `PaymentPlan` — are designed but not built.

### 2.2 SaaSLogic owns the payment ledger ⚠ (architectural delegation)

**Status: Boundary defined; implementation pending.** [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md) establishes that SaaSLogic Billing is the **system of record for invoices, payment ledger, and financial records**. CIS originates the billing instruction (a `BillingRecord` row driven by meter reads + rate calculation), hands it off to SaaSLogic, and receives back the resulting invoice/payment state via mirroring + webhooks.

For this RFP claim:
- **Payment reversals** happen *in SaaSLogic*. CIS receives them via `POST /api/v1/webhooks/payment-reversed` (designed, unbuilt).
- **Bill voids** are originated in CIS as a new `BillingRecord` version with `status = VOID`, then reflected in SaaSLogic via the standard handoff path. Voids on an already-issued invoice cascade through SaaSLogic's invoice-correction flow.
- **NSFs** are a hybrid: SaaSLogic detects the bank's return and notifies CIS; CIS posts the NSF fee as a CIS-owned ad-hoc charge.
- **Adjustment reversals** are pure-CIS — adjustments are CIS-owned (`AdhocCharge` per spec 10), so reversing one is a CIS-side operation that pushes another `AdhocCharge` row.

The boundary is well-defined in spec 21 but **none of the integration is built today.** Webhooks haven't been implemented. `Account.balance` is the column where SaaSLogic-mirrored balance would land but it's never written.

### 2.3 No reversal / void operations on any entity ✗

**Status: Not implemented.** Searching `packages/api/src/services/*.ts` for `reverse`, `void`, `chargeback`, `unpost`, `nsf`, `bounced`, `returned_payment`:

- `service-suspension.service.ts` has a `cancel` operation — operational, not financial.
- `service-request.service.ts` has a `cancel` transition — operational.
- Zero financial reversal logic.

There is no entity in the schema whose status enum includes `REVERSED`, `VOIDED`, or `NSF`.

### 2.4 No reason-code reference tables for financial domain ✗

**Status: Pattern exists for operational entities; no financial reason-code tables.** The codebase has reference tables for operational categorizations:

- `ServiceSuspensionTypeDef` (`schema.prisma:913-929`) — suspension types per tenant
- `ServiceRequestTypeDef` (`schema.prisma:1229-1244`) — service-request types

But `ServiceSuspension.reason` is a free-text `TEXT` field, not an enumerated FK. For financial entities, no reason-code tables exist (`AdjustmentReasonDef`, `ReversalReasonDef`, `BillVoidReasonDef`, `NSFReasonDef` — none exist).

[docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) line 50 designs a planned `AdhocCharge.reason_code VARCHAR(50)` with example values (`RETURNED_CHECK`, `RECONNECTION`, `COURTESY_CREDIT`, `MISSED_COLLECTION`) — but the entity is unbuilt and there's no reference table backing the codes.

### 2.5 No financial approval thresholds ⚠

**Status: One approval pattern exists; no financial thresholds.** `TenantConfig.requireHoldApproval Boolean @default(false)` (`schema.prisma:884`) gates a second-admin approval on `ServiceSuspension`. This is the **only** approval-gating config in the schema today.

There is no `tenant_config.adjustment_approval_threshold_dollars` or anything similar. There is no role-based gate that says "charges above $X require supervisor." [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) line 188 states that ad-hoc charges above a configurable threshold should require supervisor authorization, but the threshold field doesn't exist and the gating logic isn't implemented.

[01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 and [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 propose a generalized `pending_administrative_change` table for two-person approval — designed but not built. This doc reuses that proposal once it ships.

### 2.6 Audit framework exists but lacks financial-event classification ⚠

**Status: Foundational; missing financial-specific guarantees.** The existing `audit_log` table + `auditCreate` / `auditUpdate` wrappers (`packages/api/src/lib/audit-wrap.ts`) work correctly. ~18 services emit audit rows.

Gaps relevant to this RFP:
- **No `event_class` column.** Per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.4 (proposed FR-AUDIT-032), classification into `FINANCIAL | SECURITY | OPERATIONAL | TECHNICAL` is required to enforce the 7-year statutory retention on financial events. Not added.
- **No append-only enforcement.** UPDATE/DELETE on `audit_log` is not blocked by triggers (proposed FR-AUDIT-001/002 in doc 01, not built). A misbehaving service could in principle modify audit rows.
- **No 7-year financial retention.** [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.5 proposes the `STATUTORY_FLOORS_DAYS.AUDIT_FINANCIAL = 2555` floor in product code; not yet enforced.
- **No tamper-evidence chain.** Daily Merkle hash chains proposed in doc 01 §3.3, not built.

When the financial entities ship, audit rows will be emitted automatically *if* services use the existing wrappers. But the **classification + retention + tamper-evidence** guarantees that this RFP claim implicitly relies on are unbuilt.

### 2.7 `Account.balance` exists but is unmaintained ⚠

**Status: Column exists; never written.** `Account.balance Decimal @default(0) @db.Decimal(14, 2)` (`schema.prisma:332`). A grep for `account.balance =`, `balance:`, `balance +`, `balance -` in `packages/api/src/services/*.ts` returns zero writes. The column is a placeholder for the SaaSLogic webhook handler (designed in spec 21 §6.7 — invoice reconciler, not built) that would update it on `payment-received` / `payment-reversed` events.

For this RFP claim's "reporting always reflects net effect" guarantee, the `balance` field is the natural cache. Today it's permanently zero in production data.

### 2.8 No net-effect reporting ✗

**Status: Not applicable yet — financial entities don't exist.** With no `Bill`, `Payment`, or `Adjustment` rows, there's no aggregation surface to test net-effect against. The reporting module itself is also unbuilt (per [06-custom-fields.md](./06-custom-fields.md) §2.6 — "ad-hoc query builder doesn't exist; reports module is Phase 3").

### Summary

| Guarantee | Today |
|---|---|
| Posted financial transactions exist at all | ✗ |
| No silent edits on posted financials | N/A (no posted financials yet) |
| Bill void as first-class operation | ✗ (BillingRecord designed; void not designed) |
| Payment reversal as first-class | ✗ (delegated to SaaSLogic; webhook not built) |
| NSF as first-class | ✗ (not designed in any spec beyond a `reason_code` value) |
| Adjustment reversal as first-class | ✗ (Adjustment entity itself doesn't exist) |
| Reason codes (financial) | ✗ (pattern exists for operational; no financial reason tables) |
| Approval thresholds (configurable) | ✗ (only ServiceSuspension hold approval exists) |
| Full audit-log capture | ⚠ (framework exists; financial classification missing) |
| Reporting reflects net effect | ✗ |

---

## 3. Functional requirements

### 3.1 Immutability of posted financial entities

- **FR-REV-001** — Once an entity crosses into a **posted financial state**, its monetary fields MUST NOT be edited via UPDATE. Posted financial states (entity → state):
  - `BillingRecord` → `ISSUED`, `PAID`, `PARTIAL_PAID`, `OVERDUE`, `VOID`, `WRITTEN_OFF`
  - `AdhocCharge` (adjustments + ad-hoc fees) → `POSTED`, `REVERSED`
  - `Payment` (mirrored from SaaSLogic) → `POSTED`, `REVERSED`, `NSF_RETURNED`
  - `WriteOff` → `POSTED`, `REVERSED`
  - `NSFRecord` → `POSTED`, `WAIVED`

  The state-transition rules + the API service layer + the `audit_log` event_class predicate (FR-REV-040) jointly enforce this. The simplest defense is application-layer: the entity's PATCH endpoint rejects any field-set on monetary columns once the row is in a posted state.

- **FR-REV-002** — Non-monetary metadata MAY still be edited on posted financials (e.g., adding a note, attaching a document, correcting a non-financial typo in the description). Edits to non-monetary fields emit standard audit rows of class `AUDIT_FINANCIAL`. The boundary is per-entity:
  - `BillingRecord`: amount fields, period, account, charges JSON, total — frozen. Description text, attachments, internal notes — editable.
  - `AdhocCharge`: amount, account, reason_code, type — frozen. Description, attachments — editable.
  - Same pattern across the rest.

- **FR-REV-003** — Field-level CHECK constraints + a dedicated `before_update_financial` trigger reject any attempted UPDATE on a frozen monetary column when the row is in a posted state. Defense in depth — even a buggy service that bypasses the application layer cannot mutate a posted bill's amount.

### 3.2 Correction primitives — reversal vs. adjustment

The system supports **two distinct correction mechanisms**:

#### 3.2.1 Reversal — undo

- **FR-REV-010** — A **reversal** issues a new financial entity that completely undoes the original. It is *the inverse posting*. After a successful reversal, the net effect of `original + reversal` is zero monetary impact, and the audit trail clearly shows both rows.

  | Original entity | Reversal mechanism | Reversal entity |
  |---|---|---|
  | `BillingRecord(status: ISSUED)` | Bill void | `BillingRecord(status: VOID, reverses_id: <original.id>)` |
  | `Payment(status: POSTED)` | Payment reversal (operator-initiated) | `Payment(status: REVERSED, reverses_id: <original.id>)` |
  | `Payment(status: POSTED)` | NSF return (bank-initiated) | `Payment(status: NSF_RETURNED, reverses_id: <original.id>)` + `NSFRecord(...)` (FR-REV-022) |
  | `AdhocCharge(status: POSTED)` | Adjustment reversal | `AdhocCharge(status: REVERSED, reverses_id: <original.id>, amount: -<original.amount>)` |
  | `WriteOff(status: POSTED)` | Write-off reversal | `WriteOff(status: REVERSED, reverses_id: <original.id>)` |

- **FR-REV-011** — Every reversal entity MUST carry:
  - `reverses_id` — non-null FK to the original entity (same table — bill reverses bill, payment reverses payment, etc.)
  - `reason_code` — FK to the entity-specific reason-code reference table (FR-REV-030)
  - `reason_text` — free-text supplementary explanation; optional but encouraged for auditor narrative
  - `originator_id` — the user (or system actor for SaaSLogic-driven reversals like NSF) who initiated
  - `posted_at` — timestamp of the reversal posting
  - `audit_log` row of class `AUDIT_FINANCIAL` referencing both original and reversal (auto-emitted via existing `auditCreate` wrapper)

- **FR-REV-012** — The original entity's status transitions **simultaneously**, in the same transaction as the reversal posting:
  - `BillingRecord(status: ISSUED → VOID)` when its void posts
  - `Payment(status: POSTED → REVERSED)` when its reversal posts
  - `AdhocCharge(status: POSTED → REVERSED)` when its reversal posts
  - This way, querying the original tells you it was reversed; querying the reversal tells you what it reversed; both are in lockstep.

- **FR-REV-013** — Reversals are **terminal**. A reversal cannot itself be reversed. If the operator made a mistake reversing the wrong record, they post a new charge/payment/bill that mirrors the original — they don't "un-reverse." The audit trail shows: original posted, original reversed (with reason "operator error"), new entity created. This protects against tangled multi-level reversal chains that no auditor can follow.

#### 3.2.2 Adjustment — modify net effect without erasing

- **FR-REV-020** — An **adjustment** is a separate `AdhocCharge` row that modifies the customer's account balance without reversing any specific prior transaction. Use case: "courtesy credit for a billing dispute," "miscellaneous fee," "back-billing for under-metering caught after the fact."

  Adjustments are not reversals — they don't reference an `original_id`. They are first-class debits or credits in their own right. The original transaction stays as-is; the adjustment is additive.

- **FR-REV-021** — Adjustments themselves can be reversed (FR-REV-010 covers it — `AdhocCharge` reverses `AdhocCharge`). This is the "adjustment reversal" called out by the RFP.

#### 3.2.3 NSF — bank-returned payments

- **FR-REV-022** — An **NSF return** is a specialization of payment reversal (FR-REV-010) where the originating event is the bank pulling funds back. It MUST capture all of:
  1. `Payment(status: POSTED → NSF_RETURNED)` on the original payment, with `reverses_id = self` (self-reference indicates it was reversed by external event, not a follow-on payment)
  2. A new `NSFRecord` row capturing the bank's return reason, dishonor date, original payment reference, and the NSF-fee amount that the tenant chooses to charge.
  3. A new `AdhocCharge(type: NSF_FEE, amount: <fee>, originated_by_nsf_record_id: <id>)` for the customer-facing fee, posted automatically per the tenant's `nsf_fee_amount` config.
  4. An audit row of class `AUDIT_FINANCIAL` linking all three.

  This three-row pattern is intentional — auditors and operators need to see the original payment, the bank return, and the fee posting as separate events. Conflating them into one record loses information.

- **FR-REV-023** — `NSFRecord`:

  ```prisma
  model NSFRecord {
    id                String          @id @default(uuid()) @db.Uuid
    utilityId         String          @map("utility_id") @db.Uuid
    paymentId         String          @map("payment_id") @db.Uuid           // FK to the bounced Payment
    accountId         String          @map("account_id") @db.Uuid
    bankReturnDate    DateTime        @map("bank_return_date") @db.Date
    bankReturnReason  String          @map("bank_return_reason") @db.VarChar(64)  // e.g., "INSUFFICIENT_FUNDS", "STOP_PAYMENT", "ACCOUNT_CLOSED" (FK to NSFReasonDef)
    bankReturnReasonCode String?      @map("bank_return_reason_code") @db.VarChar(8)  // ACH return code (R01, R02, ... per NACHA)
    feeChargedAmount  Decimal         @map("fee_charged_amount") @db.Decimal(10, 2)
    feeChargeId       String?         @map("fee_charge_id") @db.Uuid                  // FK to AdhocCharge created for the fee
    status            NSFStatus       @default(POSTED)                                // POSTED | WAIVED
    waivedAt          DateTime?       @map("waived_at") @db.Timestamptz
    waivedBy          String?         @map("waived_by") @db.Uuid
    waivedReason      String?         @map("waived_reason") @db.VarChar(500)
    createdAt         DateTime        @default(now()) @map("created_at") @db.Timestamptz
    @@index([utilityId, accountId, bankReturnDate])
    @@map("nsf_record")
  }

  enum NSFStatus { POSTED  WAIVED }
  ```

- **FR-REV-024** — NSFs MAY be **received from SaaSLogic via webhook** rather than originated in CIS. SaaSLogic detects the bank return and POSTs to `/api/v1/webhooks/payment-reversed` with `reason: "NSF"` + the NACHA code. The CIS handler creates the three-row pattern of FR-REV-022 idempotently (same SaaSLogic event ID → same NSF record). The webhook handler runs with system-actor identity; the audit row records it as `actor: "saaslogic_webhook"`.

### 3.3 Reason codes — first-class reference tables

- **FR-REV-030** — Per-entity reason-code reference tables, all per-tenant configurable:

  | Reference table | Used by | Example codes (seed defaults) |
  |---|---|---|
  | `BillVoidReasonDef` | `BillingRecord(status: VOID)` | `WRONG_CUSTOMER`, `WRONG_PERIOD`, `RATE_ERROR`, `DUPLICATE`, `FRAUD`, `OPERATOR_ERROR`, `CUSTOMER_REQUEST` |
  | `PaymentReversalReasonDef` | `Payment(status: REVERSED)` | `OPERATOR_ERROR`, `DUPLICATE_PAYMENT`, `CUSTOMER_DISPUTE`, `REFUND_REQUEST`, `WRONG_ACCOUNT_APPLIED` |
  | `NSFReasonDef` | `NSFRecord.bankReturnReason` | `INSUFFICIENT_FUNDS`, `STOP_PAYMENT`, `ACCOUNT_CLOSED`, `INVALID_ROUTING`, `UNAUTHORIZED`, `OTHER` (mapped to NACHA R01-R85 in metadata) |
  | `AdjustmentReasonDef` | `AdhocCharge.reason_code` | `COURTESY_CREDIT`, `BILLING_DISPUTE_RESOLUTION`, `BACK_BILLING`, `LEAK_ADJUSTMENT`, `MISCELLANEOUS_FEE`, `RECONNECTION_FEE`, `LATE_FEE_WAIVER` |
  | `AdjustmentReversalReasonDef` | `AdhocCharge(status: REVERSED)` | `OPERATOR_ERROR`, `SUPERVISOR_OVERTURNED`, `CUSTOMER_DISPUTE_REVERSED`, `MISAPPLIED` |
  | `WriteOffReasonDef` | `WriteOff` | `BANKRUPTCY`, `UNCOLLECTIBLE`, `DECEASED`, `MOVED_NO_FORWARDING`, `LITIGATION_SETTLED`, `OTHER` |
  | `WriteOffReversalReasonDef` | `WriteOff(status: REVERSED)` | `RECOVERY`, `OPERATOR_ERROR`, `SETTLEMENT_PAID` |

  Each reference table follows the existing pattern of `ServiceSuspensionTypeDef` (`schema.prisma:913-929`):

  ```prisma
  model BillVoidReasonDef {
    id          String   @id @default(uuid()) @db.Uuid
    utilityId   String   @map("utility_id") @db.Uuid
    code        String   @db.VarChar(64)
    label       String   @db.VarChar(255)
    description String?  @db.Text
    requiresApprovalAt Decimal? @map("requires_approval_at") @db.Decimal(14, 2)  // null = always; non-null = threshold dollar amount above which dual approval is required
    sortOrder   Int      @default(0) @map("sort_order")
    isActive    Boolean  @default(true)
    @@unique([utilityId, code])
    @@map("bill_void_reason_def")
  }
  ```

  Same shape repeats for the other reason-code tables. Tenants seed with the product defaults and can add their own (e.g., a tenant in a state with its own UC-mandated codes).

- **FR-REV-031** — Every reversal/correction operation in §3.1-§3.2 MUST set `reason_code` to a valid row in the corresponding reference table. The API rejects with 422 on missing or invalid code. The reference-table values are themselves audit-logged when edited (per the standard audit wrapper) — operators cannot silently rename a code after it's been used.

- **FR-REV-032** — The `requiresApprovalAt` column on each reason-code row drives the dynamic approval threshold (FR-REV-040). Some codes are always approval-gated (set `requiresApprovalAt = 0`); some are unconditionally allowed (`requiresApprovalAt = null` is interpreted as "always require approval"); some are dollar-gated (`requiresApprovalAt = 500.00`). This puts the policy in tenant configuration, not in code, while still keeping CIS code aware of the structure.

### 3.4 Approval requirements — configurable thresholds

- **FR-REV-040** — Configurable approval gating per operation per reason code per dollar amount. The decision matrix:

  | Operation | Approval gate |
  |---|---|
  | `BillingRecord` void | Always requires `bills.void` permission. Optional dual-approval per `BillVoidReasonDef.requiresApprovalAt` and per `tenant_config.bill_void_dual_approval_threshold`. |
  | Payment reversal (operator-initiated) | Always requires `payments.reverse` permission. Optional dual-approval per `PaymentReversalReasonDef.requiresApprovalAt` and per `tenant_config.payment_reversal_dual_approval_threshold`. |
  | Payment reversal (SaaSLogic webhook) | No approval gate — the bank already returned the money; this is bookkeeping, not authorization. Audit captures the system actor. |
  | NSF posting (from webhook) | No approval gate — same reasoning as above. |
  | NSF fee waiver | Requires `nsf.waive` permission. Optional dual-approval per `tenant_config.nsf_waiver_dual_approval` boolean. |
  | Adjustment posting | Requires `adjustments.write` permission. Dual-approval per `AdjustmentReasonDef.requiresApprovalAt` and per `tenant_config.adjustment_dual_approval_threshold` (default $500). |
  | Adjustment reversal | Requires `adjustments.reverse` permission. Dual-approval per `AdjustmentReversalReasonDef.requiresApprovalAt`. |
  | Write-off | Always requires `writeoffs.write` permission. Dual-approval per `tenant_config.writeoff_dual_approval_threshold` (default $0 — every write-off is dual-approved). |
  | Write-off reversal | Requires `writeoffs.reverse` permission. Always dual-approved. |

  The gate evaluates: `(operation > min(reason_code.requires_approval_at, tenant_config.<entity>_dual_approval_threshold))`. Either side can demand the gate; both are checked.

- **FR-REV-041** — Dual approval is implemented via the **generalized `pending_administrative_change` table** from [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.5 / [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) §3.4.3 (proposed but not built; this doc reuses it once it ships). The flow:
  1. Originator submits the operation → API creates a `pending_administrative_change` row with `operationType` like `"reverse_payment"` / `"void_bill"` / `"reverse_adjustment"` and the proposed payload.
  2. Originator's UI confirms: "Approval required. We've notified your supervisor."
  3. A second admin with the corresponding permission opens their approvals inbox, reviews, approves or rejects.
  4. On approval, a worker executes the operation atomically (single transaction creating the reversal entity + transitioning the original's status + emitting audit + adjusting balance).
  5. On rejection, the proposal is closed with the rejection reason audit-logged.
  6. On 30-day expiry without action, the proposal expires; nothing happens.

- **FR-REV-042** — Self-approval is forbidden (the originator and approver MUST be different `cis_user.id`s; checked in the approval handler). `pending_administrative_change` records both — see doc 08 §3.4.3.

- **FR-REV-043** — `reverse_self_charge` (operator reversing a charge they themselves originated) requires dual approval REGARDLESS of dollar threshold. Reasoning: this is a high-risk fraud surface; even small-dollar self-reversals need a second eye.

- **FR-REV-044** — A separate per-tenant config `tenant_config.bulk_reversal_max_count` (default 100) caps how many records can be reversed in a single bulk operation. Above the cap → rejected with a clear error directing the operator to file multiple smaller batches or escalate to engineering for a one-off.

### 3.5 Audit-log capture — financial event class

- **FR-REV-050** — Every operation in §3.1-§3.4 emits one or more `audit_log` rows of class `AUDIT_FINANCIAL`. Concretely:
  - Bill void → 2 rows: `UPDATE BillingRecord (status: ISSUED → VOID)` + `CREATE BillingRecord(status: VOID, reverses_id: <orig>)`.
  - Payment reversal → 2 rows: `UPDATE Payment (status: POSTED → REVERSED)` + `CREATE Payment(status: REVERSED, reverses_id: <orig>)`.
  - NSF posting → 4 rows: payment status update + reversed payment row + `NSFRecord` create + `AdhocCharge` (NSF fee) create.
  - Adjustment reversal → 2 rows: `UPDATE AdhocCharge (status: POSTED → REVERSED)` + `CREATE AdhocCharge(status: REVERSED, reverses_id: <orig>)`.
  - Each row has `event_class = AUDIT_FINANCIAL` (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) FR-AUDIT-032).
  - `metadata` JSON includes `reason_code`, `reverses_id`, `originator_id`, `approver_id` (when dual-approved), `pending_administrative_change_id` (when applicable).

- **FR-REV-051** — `event_class = AUDIT_FINANCIAL` rows are subject to the **2,555-day (7-year) statutory floor** per [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) FR-RET-002 + FR-RET-071. A tenant's retention engine cannot purge financial audits before 7 years even if their policy says otherwise.

- **FR-REV-052** — Append-only enforcement on `audit_log` (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) FR-AUDIT-001/002, proposed) MUST be in place before this RFP claim is signed. Without it, the "not silently edited" guarantee leaks — a misbehaving service or DB admin could in principle edit audit rows themselves.

- **FR-REV-053** — Daily Merkle hash chains over `event_class = AUDIT_FINANCIAL` rows (per [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) §3.3) provide cryptographic tamper evidence. An auditor can verify the chain externally (CLI tool per FR-RET-063) without trusting the application database.

### 3.6 Net-effect reporting

- **FR-REV-060** — All financial-aggregation reports MUST compute **net effect** by summing original + corrections. Specifically:
  - **Account balance** = `SUM(BillingRecord.total_amount) - SUM(Payment.amount) + SUM(AdhocCharge.amount)` over rows whose status is in the active set (`ISSUED`, `PARTIAL_PAID`, `OVERDUE`, `POSTED`) PLUS `+ SUM(reverses.amount)` where the corresponding reverser is in (`VOID`, `REVERSED`).
  - **Revenue report** = sums by period; voided bills excluded; reversed payments excluded; NSF fees included; adjustments included with sign.
  - **Aging report** = uses balance per FR-REV-060 (accounts with negative balance from credits show as such; accounts with NSF-fee-driven balance show the fee).
  - **A/R aging** = same approach.

- **FR-REV-061** — `Account.balance` is the cached net result. Updates happen in the **same transaction as the entity transition** that triggered the change. E.g., the void of a $123 bill triggers an UPDATE on `account.balance = balance - 123` in the same transaction. This keeps the cache in step with the entity state.

  The cache is a *materialized denormalization*; the source of truth is the underlying entity rows. A nightly reconciliation job recomputes `balance` from scratch and alerts on drift (NFR-REV-005).

- **FR-REV-062** — When SaaSLogic owns a piece of the ledger (e.g., payment processing), the corresponding mirror table (`Payment` mirrored from SaaSLogic via spec 21 §6.7) updates `account.balance` on the same webhook that received the payment-received or payment-reversed event. The webhook handler runs in a transaction.

- **FR-REV-063** — Every report exposes a "net effect" toggle and a "gross effect" toggle. Default is net (the RFP guarantee). Gross is available for forensic reconciliation against external systems that track gross.

- **FR-REV-064** — Reports MUST distinguish three rendering modes:
  1. **Net effect** (default) — original transactions plus their reversals are netted; voided bills don't count; reversed payments don't count.
  2. **Gross with reversal annotations** — original transactions show with a strikethrough or "VOIDED" badge, and the reversal row is also shown, so an operator can see both.
  3. **Active only** — only currently-effective transactions are shown (same as net but with reversed/voided rows entirely hidden).

  A toggle in the report header switches between modes.

### 3.7 Operator UI — the corrections workflow

- **FR-REV-070** — A dedicated page per entity exposes the correction surface:
  - On a bill detail page: "Void this bill" button → reason-code dropdown → confirmation → submission. If approval-gated, returns a "submitted for supervisor approval" toast; otherwise the void posts immediately.
  - On a payment detail page: "Reverse this payment" button → reason-code dropdown → confirmation → submission.
  - On an adjustment detail page: "Reverse this adjustment" button → reason-code dropdown → confirmation → submission.
  - On an NSF record page: "Waive this NSF fee" button → reason-text → confirmation.

- **FR-REV-071** — Reversed/voided entities are shown with a clear visual treatment (red strikethrough on the amount, "VOID" or "REVERSED" badge, link to the reversing entity). The original is not hidden — operators should see the full history.

- **FR-REV-072** — The CSR's primary "Account history" view shows every financial event in chronological order with reversed/voided transactions visually paired (e.g., a payment posted on Mon and reversed on Tue appear adjacent with a connecting line). This is the operator's primary forensic view.

- **FR-REV-073** — An auditor-facing read-only "Financial events" page for each account shows the same chronology with full audit metadata (originator, approver, reason code, before/after JSON snippet) inline. Used during external audits.

### 3.8 Customer portal surfacing

- **FR-REV-080** — Reversed/voided transactions are visible to portal customers with appropriate visual treatment ("VOIDED" badge on the original; the reversal listed below it). Customers see the same chronological view as operators but with the audit metadata stripped (no actor names, no reason text — only the reason **code's customer-facing label**, configured per code).

- **FR-REV-081** — `BillVoidReasonDef`, `PaymentReversalReasonDef`, etc., have a `customerFacingLabel String?` column. If set, the portal shows that label; if null, the portal shows a generic "Adjusted" / "Reversed" / "Voided" with no detail. Tenants control what customers see.

- **FR-REV-082** — Customer-visible reversals MAY trigger a `COMMENT_FROM_UTILITY` notification (per [11-notes-and-comments.md](./11-notes-and-comments.md)) explaining the change. Optional per tenant configuration; rate-limited.

### 3.9 Non-functional requirements

- **NFR-REV-001** — Reversal posting latency: ≤500ms p99 for non-dual-approved operations.
- **NFR-REV-002** — Audit-row emission MUST be in the same transaction as the entity mutation. Saga-style two-phase emission is forbidden — atomicity is non-negotiable for financial events. (This aligns with the architectural-discipline principle from CLAUDE.md: don't reach for outbox/queue when in-transaction insert is correct and atomic.)
- **NFR-REV-003** — Bulk reversal (per FR-REV-044, capped at 100) latency: ≤30s p99 for the full batch.
- **NFR-REV-004** — `Account.balance` cache update MUST be in the same transaction as the financial event. No deferred recompute; no eventual consistency.
- **NFR-REV-005** — Daily reconciliation job recomputes `Account.balance` from scratch and alerts on drift > $0.01. Drift is treated as a P1 (cache and source of truth disagree on monetary value).
- **NFR-REV-006** — Per-class retention floor (FR-REV-051) MUST be enforced before any tenant onboards real financial data.
- **NFR-REV-007** — Append-only enforcement (FR-REV-052) MUST be in place before any tenant onboards real financial data.

---

## 4. Data model changes

### 4.1 Dependencies on other docs

This doc does not redefine the financial substrate. It depends on:

| From | Adds |
|---|---|
| [docs/specs/09-billing.md](../specs/09-billing.md) Phase 3 | `BillingRecord` with `status` enum extended with `VOID` + `reverses_id` FK |
| [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) Phase 3 | `AdhocCharge` with `status` enum and `reverses_id`; `Payment` mirror table; `WriteOff` with reversal support |
| [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md) Phase 3 | `/api/v1/webhooks/payment-received` and `/api/v1/webhooks/payment-reversed` handlers |
| [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) | `event_class` column on `audit_log` (`AUDIT_FINANCIAL`); append-only triggers; Merkle chain |
| [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) | `STATUTORY_FLOORS_DAYS.AUDIT_FINANCIAL = 2555`; `pending_administrative_change` generalized table |

### 4.2 New tables (specific to this doc)

| Table | Purpose | Section |
|---|---|---|
| `NSFRecord` | First-class NSF entity per FR-REV-023 | 3.2.3 |
| `BillVoidReasonDef` | Reference table per tenant | 3.3 |
| `PaymentReversalReasonDef` | Reference table per tenant | 3.3 |
| `NSFReasonDef` | Reference table per tenant | 3.3 |
| `AdjustmentReasonDef` | Reference table per tenant | 3.3 |
| `AdjustmentReversalReasonDef` | Reference table per tenant | 3.3 |
| `WriteOffReasonDef` | Reference table per tenant | 3.3 |
| `WriteOffReversalReasonDef` | Reference table per tenant | 3.3 |

### 4.3 Modified tables (defined elsewhere; this doc adds columns)

| Table | Change | Doc that owns it |
|---|---|---|
| `BillingRecord` | Add `reverses_id` FK; extend `status` enum with `VOID`; add `void_reason_code_id` FK | spec 09 |
| `AdhocCharge` | Add `reverses_id` FK; extend `status` enum with `REVERSED`; add `reason_code_id` and `reversal_reason_code_id` FKs | spec 10 |
| `Payment` | Add `reverses_id` FK; extend `status` enum with `REVERSED` and `NSF_RETURNED`; add `reversal_reason_code_id` FK | spec 10 / spec 21 mirror |
| `WriteOff` | Add `reverses_id` FK; extend `status` enum with `REVERSED`; add `reason_code_id` and `reversal_reason_code_id` FKs | spec 10 |
| `tenant_config` | Add: `bill_void_dual_approval_threshold`, `payment_reversal_dual_approval_threshold`, `nsf_waiver_dual_approval`, `adjustment_dual_approval_threshold`, `writeoff_dual_approval_threshold`, `nsf_fee_amount`, `bulk_reversal_max_count` | This doc |

### 4.4 Triggers

- `before_update_financial` on `BillingRecord`, `AdhocCharge`, `Payment`, `WriteOff` — rejects UPDATE on monetary columns when the row is in a posted state. Per FR-REV-003.

### 4.5 RLS

All new tables get tenant RLS via `utility_id` per the existing pattern. Reason-code reference tables also enforce tenant isolation — a tenant cannot see another tenant's reason codes.

---

## 5. Implementation sequence

This doc cannot ship in isolation — it depends on Module 09, Module 10, doc 01, doc 08, and the SaaSLogic webhook handlers. The sequence below assumes those land in a coordinated track.

### Phase 1 — Audit + retention preconditions (~3 weeks, owned by docs 01 + 08)

1. `event_class` column + classification + audit append-only triggers (per doc 01 FR-AUDIT-001/002, FR-AUDIT-032). 
2. `STATUTORY_FLOORS_DAYS.AUDIT_FINANCIAL = 2555` enforcement (per doc 08 FR-RET-071).
3. `pending_administrative_change` generalized table (per doc 08 FR-RET-050).
4. Merkle hash chain (per doc 01 §3.3) — can run in parallel.

### Phase 2 — Financial substrate (~6 weeks, owned by specs 09 + 10 + 21)

5. `BillingRecord` + status enum + originating logic (spec 09).
6. `AdhocCharge` + status enum + reason_code field (spec 10).
7. `Payment` mirror + webhook handlers `/payment-received` + `/payment-reversed` (spec 21).
8. `WriteOff` + status enum (spec 10).

### Phase 3 — Correction primitives (this doc) (~3 weeks)

9. **Reason-code reference tables + seeds** (~3 days). Seven new reference tables per FR-REV-030 with default codes.
10. **`reverses_id` FK columns + status-extension on the four entities** (~2 days).
11. **`before_update_financial` triggers** (~2 days).
12. **NSFRecord + NSF posting flow** (~3 days). Includes the three-row pattern of FR-REV-022 and the webhook idempotency for FR-REV-024.
13. **Reversal endpoints** (per entity: bill void, payment reversal, adjustment reversal, write-off reversal) (~5 days). Each is a single transaction: create reverser + update original status + update Account.balance + emit audit.
14. **Approval gating** (~3 days). Wire the `requiresApprovalAt` per-reason-code threshold + tenant-config thresholds + `pending_administrative_change` integration.
15. **`Account.balance` maintenance + nightly reconciliation job** (~2 days).

### Phase 4 — Reporting + UI (~2 weeks)

16. **Net-effect aggregation in reports + toggle** (~5 days). Account balance, A/R aging, revenue, daily summary all compute net.
17. **Operator UI: per-entity reversal buttons + chronological history view** (~3 days).
18. **Auditor "Financial events" page** (~2 days).
19. **Portal "Voided/Reversed" surfacing + customerFacingLabel** (~2 days).

### Phase 5 — Polish (~1 week)

20. **Bulk reversal cap + bulk-reversal UI** (~2 days).
21. **Self-reversal always-dual-approval** (~1 day).
22. **Customer notification for visible reversals** (~2 days; reuses [11-notes-and-comments.md](./11-notes-and-comments.md)).

**Phase 3-5 total (this doc's direct scope): ~6 weeks** with one engineer; ~4 weeks with two parallel tracks.

**Phase 1-5 total (everything required for the RFP claim to be true): ~14-18 weeks.**

---

## 6. Out of scope

1. **Partial reversals** — A reversal is for the full amount of the original. Reversing $50 of a $100 payment is not supported; if needed, post a $50 adjustment instead. Reasoning: partial reversals create chains that are very hard for auditors to follow; adjustments + balance math achieve the same outcome with a clearer trail.
2. **Multi-tier reversals** — Reversal of a reversal is forbidden (FR-REV-013). If the operator made an error, post a new transaction.
3. **Cross-tenant reversals** — A reversal cannot reference an entity in another tenant. (Tenant boundary is enforced by RLS at every step.)
4. **Cross-entity reversals** — A `Payment` cannot reverse an `AdhocCharge`; only same-table reversals (per FR-REV-010 matrix). To "undo" a charge with a payment, operate on the entities directly.
5. **Auto-reversal of related transactions** — Voiding a bill does NOT auto-reverse the payments that were applied to it. Operators must reverse the payments separately. Reasoning: a payment may be valid on its own (the customer paid; we just sent the wrong bill); auto-reversing the payment may create more confusion than it solves.
6. **Custom reversal workflows per tenant** — Tenants cannot define custom multi-step reversal workflows ("first my supervisor reviews, then the controller reviews, then…"). Single dual-approval is the only flow. Multi-step approval workflows are Phase 5+.
7. **Time-travel queries on financial state** — "What did Account 12345's balance look like on 2026-03-01?" requires querying the audit trail and replaying. The application does not provide a single endpoint for this; it's a forensic operation done via the auditor "Financial events" page (FR-REV-073) plus manual computation. A first-class point-in-time-balance endpoint is Phase 5+.
8. **Real-time payment reversal initiation from CIS** — CIS does not initiate payment reversals against the bank/processor. Only SaaSLogic does (or operators acting through SaaSLogic). CIS receives the reversal via webhook.
9. **Customer-initiated reversal requests** — A portal customer cannot click "reverse my payment" themselves. They must contact the utility; operator then files the reversal. Reasoning: customer-initiated financial reversals are a fraud surface; tenant policy decides whether to honor them.
10. **General ledger / chart-of-accounts** — CIS does not maintain double-entry bookkeeping. SaaSLogic Billing does. CIS' financial data is the *operational layer* (which customer owes what); SaaSLogic's is the *accounting layer*. This doc commits to ensuring CIS' operational data is correct and auditable; double-entry is not in scope.
11. **Tax-implication recalculation on reversal** — When a bill is voided, the tax implications (sales tax remitted? excise tax adjustments?) are computed by SaaSLogic Billing, not CIS. CIS receives the corrected invoice via mirroring.

---

## 7. Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Posted financial entity is silently edited via raw SQL | **Critical** | (a) Application-layer rejection on PATCH (FR-REV-001); (b) `before_update_financial` trigger (FR-REV-003); (c) audit-log append-only enforcement so even DB-direct edits are visible (FR-REV-052); (d) Merkle chain detects tampering after the fact (FR-REV-053). |
| Reversal posted against wrong original (operator error) | **Critical** | UI confirmation dialog showing original details; reversal is itself reversible-by-new-charge (not by un-reversal — FR-REV-013); audit trail records originator + approver. |
| `Account.balance` cache drifts from underlying entities | High | Updates in same transaction (FR-REV-061); nightly reconciliation job alerts on drift > $0.01 (NFR-REV-005); drift is P1. |
| NSF webhook fires twice (idempotency failure) | High | Webhook handler keys on SaaSLogic event ID; duplicate event ID is no-op. Same idempotency pattern as the bulk-import file SHA-256 layer ([09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) FR-ING-100). |
| Bulk reversal of 1000+ records swamps the system | Medium | Hard cap at 100 per batch (FR-REV-044); operators directed to file multiple batches or escalate. |
| Self-reversal as a fraud vector | High | Always dual-approved regardless of dollar amount (FR-REV-043); originator-vs-approver distinct check (FR-REV-042); audit + Merkle chain catch ex-post. |
| Reason-code library bloats unmanageably | Low | Per-tenant reference tables (FR-REV-030); tenants seed defaults and add only the codes their state-specific regulations require. Operations dashboard shows reason-code usage frequency to flag dead codes. |
| Operator floods customer with "voided" notifications | Medium | Per-tenant rate limit on `COMMENT_FROM_UTILITY` (per [11-notes-and-comments.md](./11-notes-and-comments.md) FR-COMMENT-043) caps customer-visible comment frequency. Configurable cap on auto-notification on reversals (default off for non-customer-facing reasons). |
| Approval expires after 30 days; reversal never executes | Low | UI surfaces pending approvals to the originator's inbox; 7-day reminder before expiry; operations dashboard tracks expiry rate per tenant; tenants can configure longer TTLs if their workflow demands it. |
| Inconsistent state between CIS-Account.balance and SaaSLogic ledger | High | Spec 21 §6.7 invoice reconciler runs nightly; mismatches are flagged + alerted; SaaSLogic is the source of truth, CIS reconciles to it. The webhook handlers run in transaction so single-event mismatches are unlikely. |
| Tenant configures threshold = $0 (every operation requires approval) by accident | Low | UI shows the threshold's effect ("This will require approval for every adjustment.") + a confirmation dialog. Tenant can adjust per-reason-code thresholds independently from the global default. |
| Reason code referenced by historical audit rows is later renamed | Medium | Reason code is referenced by ID, not text, in audit metadata. Renaming the label is allowed and reflected in renders; the underlying code is immutable per the standard reference-table pattern (`@@unique([utilityId, code])` per FR-REV-030). |
| Tax recalculation on void is missed because CIS doesn't own tax | Medium | Reversal handoff to SaaSLogic via the standard billing-instruction path (spec 21) ensures tax is recomputed by SaaSLogic. CIS does not duplicate tax logic. Documented in spec 21 §reversal-handoff (TBD as part of spec 21 Phase 3 build). |

---

## 8. Acceptance criteria (consolidated)

### Substrate (depends on docs 01, 08, specs 09, 10, 21)
- [ ] `audit_log.event_class` column exists; `AUDIT_FINANCIAL` rows are emitted for every monetary mutation.
- [ ] `audit_log` UPDATE/DELETE is rejected by trigger (per doc 01 FR-AUDIT-001).
- [ ] `STATUTORY_FLOORS_DAYS.AUDIT_FINANCIAL = 2555` is enforced.
- [ ] `pending_administrative_change` table exists and supports the operations from FR-REV-040.
- [ ] `BillingRecord`, `AdhocCharge`, `Payment`, `WriteOff` exist with `reverses_id` FK and extended status enums.

### Reversal primitives (this doc)
- [ ] `before_update_financial` triggers reject UPDATE on monetary columns of posted-status rows.
- [ ] Bill void posts a new `BillingRecord(status: VOID)`, transitions the original to `VOID`, emits 2 audit rows of class `AUDIT_FINANCIAL`, updates `Account.balance` — all in one transaction.
- [ ] Payment reversal (operator-initiated) posts a new `Payment(status: REVERSED)`, transitions the original, emits audit, updates balance.
- [ ] NSF return (webhook-driven) posts the three-row pattern (Payment update + Payment(REVERSED) + NSFRecord + AdhocCharge for fee) idempotently.
- [ ] Adjustment reversal posts a new `AdhocCharge(status: REVERSED, amount: -<orig>)`, transitions the original, emits audit, updates balance.
- [ ] Reversal of a reversal is rejected with 422.
- [ ] Self-reversal is always dual-approved regardless of amount.

### Reason codes
- [ ] Seven reason-code reference tables exist with default codes seeded per tenant.
- [ ] Every reversal endpoint requires a valid `reason_code` from the corresponding reference table; missing/invalid → 422.
- [ ] Reference-table edits emit standard audit rows.

### Approval
- [ ] Operations above the configured threshold (per reason code + per tenant config) require dual approval via `pending_administrative_change`.
- [ ] Originator and approver are distinct users.
- [ ] Pending approvals expire after 30 days with reminder at day 23.

### Reporting
- [ ] Account balance reflects net effect: `originals - reversals` using the FR-REV-060 formula.
- [ ] A/R aging, revenue report, daily summary all default to net effect.
- [ ] "Gross with reversal annotations" toggle shows originals + reversals visually paired.
- [ ] `Account.balance` reconciles to entity sum nightly with drift > $0.01 alerting.

### UI
- [ ] Per-entity detail pages have "Void/Reverse" buttons that open a reason-code dialog.
- [ ] CSR account history view shows reversed/voided transactions with visual pairing.
- [ ] Auditor "Financial events" page shows full audit metadata inline.
- [ ] Portal surfaces voided/reversed transactions with `customerFacingLabel` if set.

### Non-functional
- [ ] Reversal posting ≤500ms p99 (NFR-REV-001).
- [ ] Bulk reversal of 100 records ≤30s p99 (NFR-REV-003).
- [ ] All audit-row emission in same transaction as entity mutation (NFR-REV-002).
- [ ] Daily reconciliation job runs and clears with no drift (NFR-REV-005).

---

## 9. References

- **Internal**:
  - [01-audit-and-tamper-evidence.md](./01-audit-and-tamper-evidence.md) — `event_class` enum + append-only enforcement + Merkle chain (preconditions for FR-REV-050..053)
  - [08-data-retention-archival-purge.md](./08-data-retention-archival-purge.md) — `AUDIT_FINANCIAL` 7-year statutory floor + `pending_administrative_change` (preconditions for FR-REV-041, FR-REV-051)
  - [09-bulk-upload-and-data-ingestion.md](./09-bulk-upload-and-data-ingestion.md) — file-SHA-256 idempotency pattern reused for webhook idempotency (FR-REV-024)
  - [10-draft-status-and-posting.md](./10-draft-status-and-posting.md) — drafts are explicitly NOT for posted financials (this doc covers what happens after a financial entity is posted)
  - [11-notes-and-comments.md](./11-notes-and-comments.md) — customer-visible comment notification path used for `customerFacingLabel` rendering (FR-REV-080..082)
  - [docs/specs/09-billing.md](../specs/09-billing.md) — defines `BillingRecord` (extended in this doc with VOID + reverses_id)
  - [docs/specs/10-payments-and-collections.md](../specs/10-payments-and-collections.md) — defines `AdhocCharge`, `WriteOff` (extended in this doc with REVERSED)
  - [docs/specs/21-saaslogic-billing.md](../specs/21-saaslogic-billing.md) — defines the SaaSLogic boundary; webhook handlers `payment-received` / `payment-reversed` are owned by spec 21
  - `packages/api/src/lib/audit-wrap.ts` — existing audit wrapper pattern reused for financial entities
  - `packages/shared/prisma/schema.prisma` — current schema (BillingRecord, AdhocCharge, Payment, WriteOff, NSFRecord, all reason-code tables added by this doc + the dependent specs)

- **External**:
  - NACHA Operating Rules — ACH return codes (R01-R85) mapped to `NSFReasonDef.bankReturnReasonCode`
  - Generally Accepted Accounting Principles (GAAP) — guides "net effect" reporting semantics
  - State utility commission rules (jurisdiction-specific) — drive certain reason codes (e.g., write-off bankruptcy rules)
  - PCI-DSS — applies to SaaSLogic Billing (CIS does not handle card data)

---

**End of doc 12.**
