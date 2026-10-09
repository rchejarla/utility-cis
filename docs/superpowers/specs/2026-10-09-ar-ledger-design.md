# Accounts Receivable — Ledger Design

**Date:** 2026-10-09
**Module:** 23 — Accounts Receivable (new)
**Status:** Design
**Depends on:** Rate Model v2 slices 5a–5b.2 (`BillSegment`, `Bill` — shipped)
**Blocks:** module 21 (SaaSLogic payment collection), aging/dunning reporting, portal amount-due

---

## 1. The problem

The billing chain dead-ends:

```
rate() -> BillSegment -> Bill -> (nothing)
```

Nothing writes `Account.balance`. The only reference to it in the API is a read filter in `delinquency.service.ts:17` (`balance: { gt: 0 }`, plus `lastDueDate: { not: null }`), and nothing writes `lastDueDate` either. Both values exist only because the seeder sets them — on a freshly seeded dev database, account `0001000-00` "owes" $412.80 with **zero bills and zero bill segments** behind it.

So today:

- Generating a real `Bill` does not change what an account owes.
- There is nowhere to record money received. No `Payment` entity exists; "payment" appears in exactly one API file, as a notification template variable.
- The delinquency module — rules, tiers, notice templates, shut-off eligibility — evaluates fiction.

A working rate engine, bill segments, account-level bills and a delinquency engine are all in place. The thing connecting billing to collections is a column nobody writes.

### 1.1 Why a per-charge ledger rather than a balance column

Two Bozeman requirements settle this:

- **Reqs 149–150** — a real-time aging dashboard. Aging means "how much is 30/60/90 days overdue," which requires knowing *which* charges are unpaid and when each was due. A single balance number cannot produce it.
- **Reqs 157–164** — payment posting and reversals. Reversing an NSF payment requires knowing what that payment had been applied to.

Neither is answerable from one number per account, and retrofitting granularity into financial history means splitting historical rows — the migration nobody wants to write.

---

## 2. Goals and non-goals

### 2.1 Goals

- An open-item ledger: every charge, payment, fee, credit, write-off and reversal is a row with its own remaining balance and due date.
- Issuing a `Bill` creates a receivable, atomically.
- Recording a payment reduces it, allocated across open charges by a stated priority.
- Waiving, correcting and writing off are three distinct, separately reportable acts.
- A statement view the customer can actually read: previous balance, activity, current charges, **total amount due**.
- Aging buckets.
- `Account.balance` provably equal to the ledger.

### 2.2 Non-goals (deferred, each named with its blocker)

- **Late-fee generation.** `DelinquencyRule` has `actionType` as a free-text VarChar (so `LATE_FEE` is expressible) but **no fee amount column**, and `DelinquencyAction` records no amount. Generation needs a schema change there. This spec ensures a fee has somewhere to live and somewhere to appear.
- **Refund processing.** An over-waived or overpaid account leaves an open credit, which *is* a refund due. The ledger represents the state; disbursing money is separate.
- **Deposit application at closure.** `Account.depositAmount` sits outside the ledger. Bozeman reqs 23–24 want refund at closure and application to unpaid charges. Applying a deposit is just a credit entry, so the ledger accommodates it without schema change.
- **Payment plans.** Module 10.
- **Approval thresholds** ("waivers over $50 need a supervisor"). Not a column away — see §4.4. Posting is final, so a pending waiver cannot be a ledger entry; it needs a request object outside the ledger. `docs/bozeman/13-workflow-approvals-action-queue.md`, with `ServiceSuspension` as the shape to follow.
- **Double-entry bookkeeping, chart of accounts, fund accounting.** Out, and deliberately. `docs/bozeman/12-corrections-and-reversals.md:459` establishes that CIS is the operational layer — which customer owes what — and the accounting layer lives elsewhere. `14-special-assessments.md:701` uses the same split for bond proceeds. This design is single-entry open-item AR.
- **The SaaSLogic adapter.** Module 21, which is blocked on this.

---

## 3. Decisions and rationale

Recorded because several of these reversed during design, and the reasoning matters more than the conclusion.

### 3.1 One ledger entry per `Bill`, not per `BillSegment` or per line

**Rejected: per `BillSegmentLine`.** Lines share a due date and are never paid separately. Their detail already lives in `BillSegmentLine`, traceable to the rate component that produced it. 20–40 rows per bill, no question answered.

**Rejected: per `BillSegment`** (one per service agreement — water, sewer, stormwater, refuse). Tempting, because Bozeman **req 61** says *"multiple services on a single consolidated bill while maintaining service-level accounting"* and a bill-level entry cannot attribute arrears to a service. Rejected anyway: nothing in the code needs per-service arrears today. `/delinquency/shutoff-eligible` is balance-threshold based. Req 61's accounting visibility is satisfied on the charge side by `BillSegment` + `BillSegmentLine`, and service attribution stays derivable by joining `bill -> bill_segment` for reporting.

**What this gives up, explicitly:** which *service* a partial payment paid. $150 against a $200 water-plus-refuse bill is apportionable only as an estimate, not a fact. **Revisit when** per-service shut-off or per-fund revenue reporting needs that as a fact.

A side benefit: one entry per bill means one rounding step (§4.6), with no remainder to distribute across segments.

### 3.2 The entry stores its own amount — a snapshot, not a cache

`LedgerEntry.amount` for a bill charge looks like a copy of `bill.total`. The no-duplication alternative — store only `openAmount` and join for the rest — was rejected for two reasons:

1. **Non-bill charges have nothing to join to.** A fee, adjustment, write-off or payment has no `bill` behind it, so the column is needed regardless. Deriving it for one type and storing it for the others makes `amount` conditionally meaningful and every balance query a conditional join.
2. **A receivable must be frozen at posting.** Slice 5d is *rebill/corrections*; bill amounts will change. Deriving the receivable would mean correcting a bill silently rewrites what the customer owed last month. You post a correcting entry; you do not edit history.

This codebase already made the same call for the same reason one slice earlier — `Bill.billingCycleId` carries the comment *"Cycle in effect at issue time. Materialized so a later cycle switch on the Account doesn't rewrite history."*

What is **never** copied: line labels, quantities and rate provenance. Those stay in `BillSegmentLine`; the entry points at the bill.

### 3.3 Fixed `LedgerEntryType` enum, not a per-tenant table

**Rejected: a tenant-scoped type table** with `sign` and `allocationPriority` columns, by analogy with `RateComponentKind` (a `utility_id`-scoped table whose seeded codes the engine branches on — `rate.ts:51` tests `kindCode === "minimum_bill"`).

Rejected because no utility would add or remove one. Every utility bills, takes payments, charges late/NSF/reconnection fees, waives, and writes off bad debt. The list describes *mechanics*, not local policy. The table was reached for because it felt more flexible — the "future flexibility" justification CLAUDE.md rejects.

An enum is also better where it fits: typos are compile errors, switches are exhaustively checked, and reporting categories stay comparable across tenants rather than each inventing its own spelling of "late fee". Adding a type later means teaching the engine new behaviour anyway, so a migration is the honest cost.

**Naming.** This schema already distinguishes the two cases consistently: `XType` is a fixed enum (`MeterType`, `CustomerType`, `ContainerType`, `ServicePointType`, `MeterEventType`), while `XTypeDef` and `XKind` are tenant-configurable tables (`PremiseTypeDef`, `AccountTypeDef`, `MeasureTypeDef`, `SuspensionTypeDef`, `RateComponentKind`). A draft called this enum `LedgerEntryKind`, which reuses "Kind" with the opposite meaning — a reader who knows `RateComponentKind` is a table would expect the same here. Hence `LedgerEntryType`, and `LedgerReasonDef` for the table, keeping the `*Def` suffix that already signals tenant-configurable.

### 3.3a Direction is explicit data, not the sign of `amount`

**Rejected: a signed `amount`** — debits positive, credits negative — justified in a draft as making the balance "a plain `SUM()`".

That justification does not hold. §5 computes the balance from **`openAmount`**, which is non-negative on both sides by design, so direction-aware arithmetic is required regardless. Signing `amount` bought nothing and cost two things:

1. **A redundancy.** `type` implies direction, and the sign had to agree with it — two sources for one fact, held together by a constraint.
2. **An exemption.** `REVERSAL` has no direction derivable from its type, so it had to be excluded from that constraint. A model needing a special case for one of its core operations — NSF, corrections and rebills are all reversals — is mis-factored.

So `direction` is its own column, `amount` is a positive magnitude, and a reversal simply takes the opposite direction of the entry it reverses. The cost, stated honestly: net sums need `CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END` rather than a bare `SUM`. That is not a new cost, only a visible one.

### 3.4 Extensibility lives in the *reason*, not the type

What genuinely varies per utility is the business reason behind a fee or adjustment: tap fee, meter test fee, backflow test, tamper charge, "courtesy — first occurrence". Those grow without code changes. Hence `LedgerReasonDef`, tenant-scoped, following the established `*TypeDef` convention.

### 3.5 Waive, correct, write off — three distinct acts

| Situation | What is posted | Type |
|---|---|---|
| The charge was **wrong** | reverse it | `REVERSAL` |
| The charge was **right**, we forgive it | credit it | `ADJUSTMENT_CREDIT` + reason |
| The charge was **right**, uncollectable | write it off | `WRITE_OFF` + reason |

Collapsing these loses three facts a finance department reports separately: **billing accuracy**, **concessions**, and **bad debt**. Once collapsed it is unrecoverable from history.

The short rule: **wrong → rebill. Right but forgiven → credit.**

Nothing is ever deleted or edited. `bill.total` is never touched by a waiver: the bill stands as issued and the *receivable* is reduced. If the bill was computed wrong, that is a rebill, not a waiver.

### 3.6 `Account.balance` stays, as a transactionally-written cache

**Rejected: deriving the balance on every read.** `delinquency.service.ts` filters on it, there is an index `(utility_id, balance)`, and the accounts list sorts by it. Deriving would put an aggregate on every list query.

**Rejected: updating it from an event handler or background job.** That reintroduces exactly the atomicity gap CLAUDE.md calls out in the EventEmitter audit pipeline. Posting an entry and moving the balance happen in one transaction or not at all.

The ledger is the truth; the balance is a cache written in the posting transaction, so it cannot drift, and §7 proves it.

### 3.7 Bill posting is configurable, and needs no status enum

Some utilities want to review bills before they become receivable; some do not. Configurable per tenant, overridable per account, **default auto-post**.

**Rejected: a `DRAFT`/`ISSUED`/`VOID` enum on `Bill`.** Posted-ness is already a fact of the ledger — does an entry exist with this `billId`? Slice 5b deliberately deferred that enum ("Bill exists = issued"), and this keeps that decision.

One nullable field is added: `Bill.postedAt`, written in the posting transaction. The review workflow needs an operator screen listing *unposted bills in this cycle*, which is a filter; an anti-join against the ledger works but is awkward to index and cannot report *when* posting happened. It is a cache of a derivable fact, same pattern and same reconciliation guarantee as `Account.balance`.

The lifecycle rule then falls out with no new state:

- **Unposted bill** — deletable and regenerable. Nothing is in the ledger, so no history to preserve.
- **Posted bill** — immutable. Corrections go through rebill (slice 5d).

### 3.8 Naming

**Rejected: `ArTransaction` / `ArApplication`.** Rule 1 of the design rules says a name that needs working out has failed, and there is direct evidence: the abbreviation needed expanding mid-design for the person who owns the codebase. Prisma models share one global namespace, so a folder cannot qualify them — the name must carry itself.

`LedgerEntry` — one financial event against an account. `LedgerApplication` — which credit paid down which debit, and by how much. "Accounts Receivable" stays the module name in prose, where there is room to spell it out.

### 3.9 Accounts Receivable is its own module

The test is dependency direction. The ledger's consumers are Billing (09, posts a charge), Delinquency (11, reads arrears and assesses fees), Customer portal (15, shows amount due), Payments & Collections (10, records payments and waivers), Payment collection (21, registers an amount), and Reporting (17, aging).

If the ledger lived inside Payments and Collections, Billing and Delinquency would depend on a payments module to do their own jobs. The ledger depends on none of them. That is a real boundary, not file-shuffling — and by CLAUDE.md's own test the second consumer arrived four times over.

**Module 10 is reduced** to what it is actually about: taking payments at the counter and by lockbox, payment plans, the collections workflow, write-off approval. Those call AR.

**Code layout:** `packages/api/src/services/ar/`, as `services/imports/` already does. Files inside are `posting.service.ts`, `allocation.service.ts`, `aging.service.ts`, `statement.service.ts` — not `ar-posting.service.ts`, because the folder qualifies them and doing both stutters (rule 3).

---

## 4. Data model

### 4.1 Enums

```prisma
enum LedgerEntryType {
  BILL_CHARGE       // debit  — an issued Bill; provenance billId; idempotent
  FEE               // debit  — off-cycle (late, NSF, reconnection); assessedOnId
  ADJUSTMENT_DEBIT  // debit  — manual increase
  PAYMENT            // credit — triggers allocation
  ADJUSTMENT_CREDIT  // credit — manual (waiver, goodwill)
  WRITE_OFF          // credit — uncollectable
  REVERSAL           // negates a prior entry; direction taken from reversesId
}

enum PaymentTender {
  CARD      // SaaSLogic hosted page
  ACH
  CASH
  CHECK
  LOCKBOX
}
```

```prisma
enum LedgerDirection {
  DEBIT    // increases what the customer owes the utility
  CREDIT   // reduces what the customer owes the utility
}
```

**Both values are defined from one fixed viewpoint: the customer's obligation to the utility.** This matters because debit and credit in double-entry bookkeeping are relative to whichever account you are looking at — a charge is a debit to receivables and a credit to revenue, simultaneously. CIS is deliberately not double-entry (§2.2), so there is only one viewpoint here and it must be pinned, or every reader will silently pick their own. If this ledger is ever exported to the City's ERP, the mapping to GL debits and credits happens there.

Note `ADJUSTMENT_CREDIT` as the entry type rather than `CREDIT`: the direction enum already uses `CREDIT`, and the same word meaning two things on one row ("a goodwill adjustment" vs "reduces the balance") is the kind of ambiguity that produces sign errors. It also pairs symmetrically with `ADJUSTMENT_DEBIT`.

Direction is a column (§3.3a), not inferred from the type at read time. The expected pairing is still asserted, as a constant in `@utility-cis/shared` and as a DB constraint:

```ts
export const ENTRY_DIRECTION: Record<Exclude<LedgerEntryType, "REVERSAL">, LedgerDirection> = {
  BILL_CHARGE:       "DEBIT",
  FEE:               "DEBIT",
  ADJUSTMENT_DEBIT:  "DEBIT",
  PAYMENT:           "CREDIT",
  ADJUSTMENT_CREDIT: "CREDIT",
  WRITE_OFF:         "CREDIT",
};
// REVERSAL is excluded by construction: its direction is the opposite of
// the entry it reverses, so there is no fixed mapping to assert.
```

### 4.2 `LedgerEntry`

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utilityId | UUID | Tenant scope |
| accountId | UUID FK | The receivable is the account's |
| type | LedgerEntryType | What sort of event this is |
| direction | LedgerDirection | DEBIT increases what is owed, CREDIT reduces it (§3.3a) |
| amount | Decimal(14,2) | **Positive magnitude.** Direction carries the arithmetic |
| openAmount | Decimal(14,2) | Unconsumed remainder, `0 <= openAmount <= amount` |
| dueDate | Date? | Debits only. Drives aging and days-past-due |
| effectiveDate | Date | Accounting date; may differ from `postedAt` (backdated entries) |
| postedAt | Timestamptz | When it hit the ledger |
| reasonId | UUID FK? | `LedgerReasonDef`. **Required** for FEE / ADJUSTMENT_DEBIT / CREDIT / WRITE_OFF |
| billId | UUID FK? | BILL_CHARGE only |
| assessedOnId | UUID FK? | FEE only — the debit that went unpaid |
| reversesId | UUID FK? | REVERSAL only — the entry being negated |
| tender | PaymentTender? | PAYMENT only |
| externalRef | VarChar(100)? | SaaSLogic transaction id, cheque number, lockbox batch |
| memo | Text? | Free text, in addition to the reason |
| createdBy | UUID? | `CisUser`; null for system-generated |

**Constraints**

- `UNIQUE (utility_id, bill_id) WHERE type = 'BILL_CHARGE'` — structural idempotency; posting the same Bill twice is refused rather than double-charging.
- `CHECK (amount > 0)` — a zero-amount entry is never meaningful, and a negative one is a direction error. This is also the constraint that stops a $0 late fee being posted; the *policy* question of a minimum fee amount belongs on `DelinquencyRule` (§10 slice 6), not here.
- `CHECK (open_amount >= 0 AND open_amount <= amount)`
- `CHECK` direction matches type, per the `ENTRY_DIRECTION` map in §4.1, **for every type except `REVERSAL`**, which instead requires `reverses_id IS NOT NULL`. Not an exemption from a rule it ought to follow — a reversal's direction is genuinely a property of its target, so there is no fixed pairing to assert.
- `CHECK (reason_id IS NOT NULL)` for `FEE` / `ADJUSTMENT_DEBIT` / `ADJUSTMENT_CREDIT` / `WRITE_OFF`.

**Indexes**

- `(utility_id, account_id, posted_at DESC)` — statement and account ledger view.
- `(utility_id, due_date) WHERE open_amount > 0 AND due_date IS NOT NULL` — partial index; aging and allocation walk only open debits.
- `(utility_id, bill_id)`, `(assessed_on_id)`, `(reverses_id)`.

Decimal(14,2), not the (14,4) the rate engine uses: rating needs sub-cent precision, a receivable is money in cents.

### 4.3 `LedgerApplication`

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utilityId | UUID | Tenant scope |
| creditId | UUID FK | The payment/credit being consumed |
| debitId | UUID FK | The charge being paid down |
| amount | Decimal(14,2) | Always positive |
| appliedAt | Timestamptz | |

**Indexes:** `(creditId)`, `(debitId)`.

### 4.4 `LedgerReasonDef`

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utilityId | UUID | Tenant scope |
| code | VarChar(50) | `LATE_FEE`, `NSF_FEE`, `RECONNECT_FEE`, `COURTESY_WAIVER`, `BAD_DEBT` … |
| label | VarChar(255) | What appears on the statement |
| appliesToType | LedgerEntryType | Restricts which entry type may cite it |
| isActive | Boolean | |

**No `requiresApproval` column.** An earlier draft had one "as a hook for the approvals workflow." Dropped for two reasons:

1. Nothing would read it until that workflow exists — a write-only column, the exact asymmetry the cross-layer auditor hunts for.
2. More fundamentally, **approval cannot be a state on a ledger entry.** Posting is final by design: an entry exists, so it has moved the balance. A waiver awaiting approval must *not* reduce what the customer owes. So approval needs a request object outside the ledger that posts an entry once granted — a different design, and the reason it is out of scope rather than a column away.

The precedent for the eventual shape is `ServiceSuspension`: `TenantConfig.requireHoldApproval` plus a `PENDING` status and `approvedBy`, gating an Approve action in the UI. That state lives on the suspension, not on a financial entry.

**Unique:** `(utilityId, code)`. Seeded with defaults per tenant, following `PremiseTypeDef` / `MeasureTypeDef`.

### 4.5 Changes to existing entities

```prisma
// TenantConfig — joins suspensionEnabled / delinquencyEnabled / requireHoldApproval
autoPostBills  Boolean   @default(true)

// Account
autoPostBills  Boolean?  // null = inherit tenant

// Bill
postedAt       DateTime? @db.Timestamptz
```

Resolution: `account.autoPostBills ?? tenantConfig.autoPostBills`.

Nullable-inherit is new to this schema (`paperlessBilling`, `budgetBilling`, `isProtected` are account-level but inherit nothing). The alternative — snapshot the tenant value at account creation — differs in propagation: nullable means flipping the tenant setting moves every account that has not explicitly opted out; a snapshot moves none. Nullable chosen because propagation is the intent.

### 4.6 Rounding

`bill.total` is `Decimal(14,4)`; the ledger is `Decimal(14,2)`. Posting rounds **half-up to 2dp, once per bill**.

Consequence to state plainly: across many bills, `SUM(bill.total)` and `SUM(ledger.amount)` can differ by cents. That is expected, not a bug. Anyone reconciling billing against AR needs to know the ledger is authoritative for money owed and the bill is authoritative for what was calculated.

---

## 5. Invariants

```
debit.openAmount   = debit.amount  − Σ applications where debitId  = debit.id
credit.openAmount  = credit.amount − Σ applications where creditId = credit.id
account.balance    = Σ open debits − Σ open credits
```

`openAmount` means the same thing on both sides: **remaining unconsumed**. On a debit it is unpaid charge; on a credit it is unapplied money — which *is* a customer credit balance. Overpayment needs no special case.

`amount`, `type`, `direction`, `dueDate` and `effectiveDate` are **immutable** once posted. `openAmount` is explicitly *not* history — it is maintained bookkeeping, like `account.balance`. Worth stating because "immutable ledger" and "we update openAmount" otherwise read as a contradiction.

---

## 6. Operations

All of these run in one transaction, wrapped in the existing `audit-wrap`, and update `account.balance` (and `lastDueDate`) before committing. No events, no queues, no second transaction.

### 6.1 `postBill(billId)`

1. Resolve auto-post (§4.5). If disabled and this is an automatic call, stop — the Bill stays unposted.
2. Round `bill.total` half-up to 2dp.
3. Insert `BILL_CHARGE` with `amount = rounded total`, `openAmount = amount`, `dueDate = bill.dueDate`, `effectiveDate = bill.billDate`, `billId`.
4. **Auto-apply open credits** against it — the inverse of §6.3's walk: given the new debit, consume open credits oldest-`postedAt` first, so a credit balance is absorbed by the next bill without a sweep job.
5. Set `bill.postedAt`, recompute `account.balance` and `lastDueDate`.

A Bill whose total is negative (credits exceeding charges) posts as `ADJUSTMENT_CREDIT`, not a debit with a negative amount, so `amount` stays positive everywhere.

When auto-post is on, this runs **inside `generateBillForAccount`'s existing transaction**. When off, it is a separate operator action gated by the *same* permission as bill generation — the `agreements` module key, which is where bill routes currently sit (commit `69a559a`). Deliberately not one of the new AR module keys: if posting required a stronger permission than generating, switching auto-post on would let a user create receivables they are not allowed to create directly.

### 6.2 `recordPayment({ accountId, amount, tender, receivedAt, externalRef })`

Insert `PAYMENT` with `direction = CREDIT`, `openAmount = amount`, then allocate (§6.3). Leftover stays as `openAmount` on the payment — a credit balance.

### 6.3 Allocation

Walk open debits in this order:

1. **Type class:** `FEE`, then `ADJUSTMENT_DEBIT`, then `BILL_CHARGE`
2. **Oldest `dueDate`** within a class, tie-broken by `postedAt`

Which is spec 10's rule — reconnection fees, then late fees, then oldest bills FIFO. The ranking lives in **one constant**. Spec 10 says it should be tenant-configurable; not built, because no second tenant wants a different order. When one does, it moves to `TenantSetting`, which already exists.

Each application consumes what it can; shortfall stays as `openAmount` on the debit. Partial payments need no special case.

### 6.4 `assessFee({ accountId, amount, reasonId, dueDate, assessedOnId })`

Insert `FEE`. `dueDate` defaults to the next bill's due date so it ages on its own clock, and `assessedOnId` records the debit that went unpaid. Fee *generation* (when and how much) is out of scope — this is the entry point it will call.

### 6.5 `adjust` / `waive` / `writeOff`

All insert a credit-direction entry (`ADJUSTMENT_CREDIT` or `WRITE_OFF`) with a required `reasonId`, applied to a nominated debit. Any amount, so partial waivers are free. Waiving more than is owed, or waiving an already-paid charge, leaves an open credit — a refund due.

### 6.6 `reverseEntry(id, reasonId)`

Insert `REVERSAL` with the opposite sign and `reversesId`; delete the original's applications; restore `openAmount` on each affected debit; recompute the balance.

**Dependent fees.** Reversing a bill charge finds fees whose `assessedOnId` points at it and **offers** to reverse them — an explicit operator decision, never an automatic cascade. If we billed wrong, the late fee probably should go; if the corrected amount was also unpaid, it probably should stand. Only a human knows which.

---

## 7. Statement view, aging, reconciliation

### 7.1 Statement — `bill.total` is not "amount due"

`bill.total` is this period's charges. What the customer must see is a statement:

```
Previous balance                    47.32
Payment received  10-02            -47.32
Late fee          10-20              5.00
Current charges                     52.10
                                  -------
Total amount due                    57.10   due 11-08
```

One line comes from `Bill`; the rest is ledger activity since the previous bill. **Computed, not stored** — storing it would duplicate the ledger.

This is why a late fee never becomes a `BillSegment` or a rate component: it has no rate schedule and no agreement, and is assessed off-cycle. It appears on the bill because the statement renders ledger activity, which needs no coupling in either direction.

For a **revised** bill the same view reads correctly with no extra work — original charge, its reversal, corrected charge, and any fee — because it renders history rather than recomputing a total.

### 7.2 Aging

Buckets open debits by `today − dueDate`: current, 1–30, 31–60, 61–90, 90+, summing `openAmount`. Served by the partial index in §4.2. This answers reqs 149–150.

### 7.3 Reconciliation

A query asserting `account.balance` equals the ledger rollup for every account, exposed as an admin endpoint and asserted in tests. The cache is provably correct rather than assumed.

---

## 8. Changes to existing code

| Where | Change |
|---|---|
| `bill.service.ts` | `generateBillForAccount` calls `postBill` in its existing transaction when auto-post resolves true |
| `delinquency.service.ts` | Days-past-due comes from the **oldest open debit's `dueDate`**, not `account.lastDueDate`. Two call sites (`:52` and `:202`) |
| `Account.lastDueDate` | **Kept**, written as a display cache alongside `balance` |
| `portal-api.ts` | `/portal/api/dashboard` and `/portal/api/accounts/:id` gain amount due, open charges, payment history. The portal exposes **no balance at all** today |
| Account detail UI | AR tab: ledger, aging summary, record-payment, adjust/waive actions |
| Billing UI | Unposted-bills list for a cycle, with a Post action, when auto-post is off |
| `seed.js` | **Must create seeded balances through the ledger.** It currently sets `balance` and `lastDueDate` directly, which would fail reconciliation on a fresh seed |
| `modules/constants.ts` | New module keys `payments` (record/reverse payments) and `ar_adjustments` (credits, waivers, write-offs), using the existing VIEW/CREATE/EDIT/DELETE vocabulary. Split because taking a payment and forgiving one are different authority |

**RLS:** new tables carry `utility_id` and the standard tenant policy. Note the caveat from module 19 — the policies do not currently enforce, because the application role is a superuser and owns the tables.

---

## 9. Testing

- **Unit (allocation):** exact payment, partial, overpayment to credit, fee-before-bill priority, FIFO within class, zero and negative guards.
- **Integration:** post bill moves balance; payment writes applications and reduces balance; double-post refused by the unique index; reversal restores prior state exactly; open credit auto-applied by the next charge; auto-post off leaves the bill unposted; unposted bill deletable, posted bill not.
- **Property:** after a random sequence of charges, payments, waivers and reversals, the §5 invariants and reconciliation hold. This is the test that actually guards the design.
- **Golden:** Bozeman SFR bill → posted → paid → balance zero, extending the existing tariff golden tests.

---

## 10. Proposed slicing

Too large for one implementation plan. **Slice 1 is the first plan's scope**; each later slice gets its own plan, as the Rate Model v2 slices did.

1. **Ledger foundation** — schema, enums, `postBill`, balance + `lastDueDate` cache, `postedAt`, auto-post config, reconciliation query and property test.
2. **Payments** — `recordPayment`, allocation, open-credit auto-apply, `reverseEntry` (NSF).
3. **Fees and adjustments** — `LedgerReasonDef` + seeds, `assessFee`, waive/write-off/adjust, the two new RBAC modules.
4. **Visibility** — statement view, aging query, account AR tab, portal amount due.
5. **Delinquency rewire** — days-past-due from the oldest open debit.
6. **Late-fee generation** — a fee amount on `DelinquencyRule`, and a `LATE_FEE` action type that calls `assessFee` (§6.4). Listed as a non-goal above because it is separable, but sequenced here deliberately: until fees exist in anger, three designed behaviours have no real exercise — the fee-before-bill allocation priority (§6.3), `assessedOnId`, and dependent-fee reversal (§6.6). It is also small.

---

## 11. Open items

1. **Module 10 needs rewriting again** to reflect §3.9 — it currently claims the ledger, the `Payment` entity and allocation, which move here.
2. **`docs/bozeman/12-corrections-and-reversals.md:459`** still says the accounting layer is SaaSLogic's. Under the 2026-10-09 decision that should be the City's ERP, matching the pattern `14-special-assessments.md:701` already uses.
3. **Fee amount on `DelinquencyRule`** — the blocker for late-fee generation.
4. **Refunds — the credit lifecycle has no terminal state.** An open credit can be consumed by a future debit (the normal path, §6.1) or refunded. Refunding needs something for the credit to be applied *against*, and no current type fits — the expected shape is a `REFUND` entry with `direction = DEBIT`, meaning "paid back to the customer." So this is not purely additive: the enum will need a migration, which §3.3 accepts as the honest cost of a fixed enum. Worth knowing before the first account closes with a credit balance, since account closure already exists.
5. **Backdated entries.** `effectiveDate` is separate from `postedAt` so a correction can land in a prior period, but nothing closes a period. If period close is ever needed, it constrains `effectiveDate` and belongs with it.
