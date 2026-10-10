# Accounts Receivable

**Module:** 23 — Accounts Receivable
**Status:** Phase 3 — slices 1 (ledger and posting), 2 (payments, allocation, reversal), 3 (fees, adjustments, reason codes) and 4a (the account AR tab) shipped; 4b and slices 5–6 outstanding. Twelve API endpoints, and the account AR tab is the first user interface.
**Entities:** `LedgerEntry`, `LedgerApplication`, `LedgerReasonDef`, plus columns on existing entities (`Bill.postedAt`, `Account.balance`, `Account.lastDueDate`, `Account.autoPostBills`, `TenantConfig.autoPostBills`).

## Authority

**The design document is the authority, not this file:**
[`docs/superpowers/specs/2026-10-09-ar-ledger-design.md`](../superpowers/specs/2026-10-09-ar-ledger-design.md).

It carries the decisions and their rationale — one entry per `Bill` rather than per segment (§3.1), signed amounts rather than a direction column (§3.3a), the fixed type enum with extensibility in the *reason* (§3.3, §3.4), `Account.balance` kept as a transactionally-written cache (§3.6), and why AR is its own module rather than part of Payments and Collections (§3.9). This file exists so that CLAUDE.md's "update the relevant functional spec" rule has a target for module 23, and so a reader looking for module 23 in `docs/specs/` finds something. It is deliberately a pointer plus an inventory, not a second copy.

## Why this is its own module

The test is dependency direction (design §3.9). The ledger's consumers are Billing (09, posts a charge), Delinquency (11, reads arrears), the Customer Portal (15, shows amount due), Payments and Collections (10, records payments and waivers), SaaSLogic payment collection (21, registers an amount due) and Reporting (17, aging). The ledger depends on none of them. Module 10 is correspondingly reduced to what it is about: taking payments at the counter and by lockbox, payment plans, the collections workflow and write-off approval — all of which call AR.

## Entities

| Entity | Table | Status | Notes |
|---|---|---|---|
| `LedgerEntry` | `ledger_entry` | Shipped (slice 1) | One financial event against an account. **Signed:** positive increases what the customer owes. `amount` is a snapshot, frozen at posting; `openAmount` is the unconsumed remainder, same sign, never larger in magnitude. |
| `LedgerApplication` | `ledger_application` | Shipped (slice 2) | Which credit paid down which debit, and by how much. `amount` is always positive; the parents' signs make it subtract from a debit and add to a credit. Written by allocation, and deleted by `reverseEntry` when it gives back what an entry consumed. |
| `LedgerReasonDef` | `ledger_reason_def` | Shipped (slice 3) | Why a fee or adjustment was raised, in the utility's own words. Tenant-configurable, following the `*TypeDef` convention; 12 defaults seeded per tenant. `appliesToType` restricts which entry type may cite it, enforced by `resolveReason` — the single gate every writing service goes through. No `requiresApproval` column, deliberately: approval cannot be a state on a ledger entry, because posting is final and a waiver awaiting approval must not already have moved the balance. |

### Columns added to existing entities

| Column | Type | Notes |
|---|---|---|
| `Bill.postedAt` | TIMESTAMPTZ? | Null until the bill posts. A cache of a derivable fact, written in the posting transaction, so the operator screen can filter unposted bills without an anti-join. |
| `Account.balance` | DECIMAL(14,2) | Pre-existing column, now actually written: `SUM(ledger_entry.open_amount)` for the account, recomputed inside the posting transaction. Never written by a background job, which is why it cannot drift. |
| `Account.lastDueDate` | DATE? | The **oldest open debit's** due date, null when nothing is open. See module 11 — the name predates this meaning and a rename is a slice 5 item. |
| `Account.autoPostBills` | BOOLEAN? | Per-account override. Null means inherit the tenant setting, so flipping the tenant value moves every account that has not explicitly opted out. |
| `TenantConfig.autoPostBills` | BOOLEAN NOT NULL DEFAULT true | Tenant default. No `tenant_config` row means an unconfigured tenant, which takes the column default: auto-post on. |

The `tenant_isolation` RLS policies on the three new tables are inert as things stand, because the application role is a SUPERUSER and superusers bypass RLS. Tenant separation rests on the `utility_id` predicates in application code. Pre-existing condition, recorded in the migration's header comment and in `docs/design/utility-cis-architecture.md` §7.1.

### Constraints that differ from the design spec

Both CHECKs deferred from slice 1 landed in slice 3, and neither is what §4.2 literally asks for. Each departure was established by trying the specified version against the live schema:

- **`ledger_entry_reason_required`** is `reason_id IS NOT NULL OR bill_id IS NOT NULL`, not `reason_id IS NOT NULL`. The stricter version cannot be added — `ERROR: check constraint ... is violated by some row` — because `postBill` writes an `ADJUSTMENT_CREDIT` with no reason for a bill that nets negative. Requiring one there would couple posting a negative bill to the tenant having reason seeds; a credit that names its bill explains itself.
- **`ledger_entry_assessed_on_only_fee`** is the converse of what §4.2's field table implies. "FEE only — the debit that went unpaid" cannot mean every fee names one, because a tap fee is assessed on nothing and the common case would be unwritable.

## Invariants (design §5)

```
debit.openAmount  = debit.amount  − Σ applications on that debit    (shrinks toward 0)
credit.openAmount = credit.amount + Σ applications on that credit   (grows toward 0)
account.balance   = SUM(openAmount) over the account's entries
```

`amount`, `type`, `dueDate` and `effectiveDate` are immutable once posted. `openAmount` is maintained bookkeeping, not history. A negative total balance *is* a customer credit balance; overpayment needs no special case.

## API — shipped in slice 1

| Method | Path | Gate | Notes |
|---|---|---|---|
| POST | `/api/v1/bills/:id/post` | `accounts:EDIT` | Posts an issued Bill. 201 with the entry and the new balance; 409 `BILL_ALREADY_POSTED` on a second attempt; 404 for an unknown or other-tenant bill; 422 `BILL_MISSING_DUE_DATE` for a debit with no due date. Body takes an optional `effectiveDate` (YYYY-MM-DD), defaulting to the bill's `billDate`. |
| GET | `/api/v1/accounts/:id/unposted-bills` | `accounts:VIEW` | Bills with no `postedAt`, for the operator screen used when auto-post is off. |
| POST | `/api/v1/accounts/:id/payments` | `payments:CREATE` | Records money received. Body takes a **positive** `amount` (at most 2dp), a `tender` (CARD / ACH / CASH / CHECK / LOCKBOX), and optional `receivedAt`, `externalRef`, `memo`. 201 with the signed amount, the applications made, whatever stayed unapplied, and the new balance. 400 on a zero or negative amount; 404 for an unknown or other-tenant account. |
| POST | `/api/v1/ledger-entries/:id/reverse` | `payments:EDIT` | Reverses any posted entry. Optional `reasonId` and `memo`. 201 with the reversal, what was restored, and any dependent fees — reported, never reversed. 409 `ENTRY_ALREADY_REVERSED` or `CANNOT_REVERSE_REVERSAL`; 404 for an unknown or other-tenant entry. |
| GET | `/api/v1/ar/reasons` | `ar_adjustments:VIEW` | The tenant's reason codes, filterable by `appliesToType` and optionally including retired ones. |
| POST | `/api/v1/ar/reasons/seed-defaults` | `ar_adjustments:CREATE` | Puts the 12 default reason codes on this tenant, skipping any it has. Idempotent. Without it a tenant not created by the dev seeder has no reason codes, and every fee, adjustment, waiver and write-off fails on `REASON_NOT_FOUND`. |
| POST | `/api/v1/accounts/:id/fees` | `ar_adjustments:CREATE` | Raises an off-cycle charge. Positive `amount`, required `reasonId`, optional `dueDate` (default +30 days), `assessedOnId`, `effectiveDate`, `memo`. 422 `REASON_TYPE_MISMATCH` if the reason is not a FEE reason. |
| POST | `/api/v1/accounts/:id/adjustments` | `ar_adjustments:CREATE` | A charge raised by hand. Same shape without `assessedOnId`. |
| POST | `/api/v1/accounts/:id/waivers` | `ar_adjustments:EDIT` | Forgives part or all of one nominated charge. Requires `debitId`. The excess stays open as a refund due and does not spill onto other charges. |
| POST | `/api/v1/accounts/:id/write-offs` | `ar_adjustments:EDIT` | Same mechanics, recorded as bad debt rather than a concession. |
| GET | `/api/v1/accounts/:id/ledger` | `accounts:VIEW` | The account's entries for display: the reason label, the bill number, the tender, and reversal links resolved in BOTH directions so a reader is not left pairing rows by amount. Returns the cached `balance` and an account-wide `openCount` alongside; capped at 500 rows, with `openOnly` and `limit`. On `accounts:VIEW` rather than a writing module, because a CSR who may not take a payment still needs to see what is owed. |
| GET | `/api/v1/ar/reconciliation` | `accounts:VIEW` | Proof, not assertion: every account whose cached `balance` differs from `SUM(open_amount)`. `{ ok: true, drift: [] }` when the cache is correct. |

Posting is gated on the same permission as generating a bill (`POST /api/v1/accounts/:id/bills`): generation already posts when auto-post is on, so posting must require no more authority than generating. The two reads are account data, not tenant configuration, so they sit on `accounts:VIEW`. The two money-moving routes sit on the `payments` module instead: taking money and reversing it is a different authority from reading or generating against an account, which is the line design §8 draws. Reversal is EDIT rather than CREATE because it changes the standing of an entry that already exists. `ar_adjustments` arrives in slice 3 with the credits, waivers and write-offs it gates.

## Business rules in force (slice 1)

1. **One entry per Bill**, not per segment or line.
2. **Rounding happens once per bill**, half-up, from the rate engine's `Decimal(14,4)` to the ledger's `Decimal(14,2)`. `SUM(bill.total)` and `SUM(ledger.amount)` can therefore differ by cents across many bills; the ledger is authoritative for money owed, the bill for what was calculated.
3. **A bill that nets negative posts as `ADJUSTMENT_CREDIT`**, not as a `BILL_CHARGE` with a negative amount — the type↔sign constraint holds and the entry reads as what it is. It still carries its `billId`; it carries no `dueDate`, because only a debit ages.
4. **A bill whose total rounds to 0.00** is marked posted and writes no entry. `CHECK (amount <> 0)` would reject the entry, and a zero receivable is not a thing that can be paid.
5. **Posting is idempotent.** The bill is claimed with an atomic `UPDATE ... WHERE posted_at IS NULL` under a row lock on the account; a partial unique index on `(utility_id, bill_id) WHERE type = 'BILL_CHARGE'` is the structural backstop.
6. **Posting and the balance update are one transaction.** No event, no queue, no second transaction — an async balance update would reopen the atomicity gap that the EventEmitter audit pipeline had.
7. **Auto-post resolves tenant default, overridden per account**, with `??` so an account override of `false` beats a tenant default of `true`.
8. **A payment is entered positive and stored negative.** The request carries what the operator typed; the service negates it once. A zero or negative amount is refused at the edge, and the database's type/sign CHECK refuses a positive PAYMENT, so a sign error cannot reach the ledger.
9. **Allocation order is fixed** (§6.3): `FEE`, then `ADJUSTMENT_DEBIT`, then `BILL_CHARGE`; oldest `dueDate` within a class, then `postedAt`, then entry id for a total order. One shared constant, `DEBIT_ALLOCATION_ORDER`.
10. **Leftover money stays open on the payment**, which *is* a customer credit balance, and the next charge to post absorbs it oldest-first (§6.1 step 4). Overpayment needs no special case.
11. **A reversal gives back exactly what the original consumed**, per application — a payment spread across two debits restores 30 and 15, not 45 to each — and is then applied against the original so both close. That stops a reversed payment being spent again.
12. **Reversal is refused twice over**: an entry already reversed, and a `REVERSAL` itself. Both re-checked under the account lock, so a reversal committing concurrently is seen rather than doubled.
13. **Three acts, kept distinct** (§3.5). The charge was wrong → `REVERSAL`. The charge was right and is forgiven → `ADJUSTMENT_CREDIT` with a reason. The charge was right and is uncollectable → `WRITE_OFF` with a reason. Collapsing them loses billing accuracy, concessions and bad debt as separately reportable facts, and it is unrecoverable from history. The reason's `appliesToType` is what enforces it: a write-off reason on a waiver is a 422.
14. **Nothing touches `bill.total`.** A waiver reduces the *receivable*; the bill stands as issued. A bill computed wrongly is a rebill, not a waiver.
15. **A waiver applies only to the charge it names.** Waiving $30 of a $10 charge leaves a $20 refund due — not $20 off whatever else is outstanding. The account balance falls by $30 either way, so this is a distinction only the per-entry open amounts record.
16. **Every fee and adjustment cites a reason**, enforced in SQL by `ledger_entry_reason_required`. The one exception is a credit that names the bill it came from, which is self-explaining.
17. **Only a fee may name what it was assessed on**, enforced by `ledger_entry_assessed_on_only_fee`. A fee is *not* required to name one: a tap fee or meter test fee is assessed on nothing.

## UI

**The account AR tab ships in slice 4a.** `/accounts/[id]` gains an **AR** tab beside Bills showing what the account owes and every entry behind it:

| Shown | Why it is rendered that way |
|---|---|
| Amount due / In credit / Nothing owed | A negative balance is never shown as "Amount due −$20.00"; the words carry the sign and the figure is unsigned |
| Charged and Still owed as separate columns | A $40 charge with $15 outstanding is not a $15 charge. A settled row shows a dash, not $0.00 |
| A credit as `($25.00)` | The accounting convention, rather than a minus sign a reader must notice |
| **reversed** / **reverses an earlier entry** markers | Both sides of a reversal stay on the ledger, so unmarked they read as a double charge |
| Unposted-bills strip | Says the bills are "not yet owed" — an issued bill that is not posted has not moved the balance |

| Action | Gate |
|---|---|
| Post an unposted bill | `accounts:EDIT` |
| Record Payment | `payments:CREATE` |
| Reverse an entry | `payments:EDIT` |
| Raise Fee | `ar_adjustments:CREATE` |
| Waive / Write off a charge | `ar_adjustments:EDIT` |

Waive and Write off appear only on an open charge — a credit cannot be forgiven and a settled charge has nothing left to forgive — and the reason dropdown is filtered per act, so a waiver is never offered a write-off reason. Reverse is offered only where it can succeed: not on an entry already reversed, and not on a `REVERSAL`.

**Still outstanding, deferred to slice 4b with reasons:** the statement view (§7.1, needs bill-period boundaries), the aging summary (§7.2, belongs with the dashboard widget that consumes it), the portal amount due, reason-code CRUD, and sidebar screens for the tenant-wide views — reconciliation, reason codes and aging — none of which has a home in the navigation yet. Design §8 lists the aging summary as part of the AR tab; it is not in 4a, and that is a known gap rather than an oversight.

## Slice roadmap (design §10)

| Slice | Scope | Status |
|---|---|---|
| 1 | Ledger foundation — schema, enums, `postBill`, `balance` + `lastDueDate` cache, `postedAt`, auto-post config, reconciliation query and property test | **Complete** |
| 2 | Payments — `recordPayment`, allocation, open-credit auto-apply (design §6.1 step 4), `reverseEntry` for NSF | **Complete** |
| 3 | Fees and adjustments — `LedgerReasonDef` seeds, `assessFee`, waive / write-off / adjust, the `ar_adjustments` module key, and the two CHECK constraints deferred from slice 1 | **Complete** |
| 4 | Visibility — statement view, aging query, account AR tab, portal amount due. Also CRUD for reason codes: §3.4 says a utility adds its own without a code change, and today it can only take the 12 defaults. | Outstanding |
| 5 | Delinquency rewire — the two reader call sites in `delinquency.service.ts`, and renaming `lastDueDate` to say what it holds | Outstanding |
| 6 | Late-fee generation — a fee amount on `DelinquencyRule` and a `LATE_FEE` action type calling `assessFee` | Outstanding |

Known deferrals, each recorded in the design doc: refunds, which need a new enum value and therefore a migration (§11 item 4); tenant-configurable allocation ordering (§6.3 — one constant until a second tenant wants a different order); approval of a waiver or write-off, which needs a request object outside the ledger because posting is final (§4.4); and fee *generation* — when a late fee is raised and how much it is — which arrives with slice 6 (§6.4).

Closed in slice 2: auto-applying open credits when a debit posts (§6.1 step 4). Closed in slice 3: both CHECK constraints, in modified form.

## Related specs

- [09 — Billing](./09-billing.md) — produces the `Bill` that AR posts.
- [10 — Payments and Collections](./10-payments-and-collections.md) — records payments against this ledger; payment plans and collections workflow.
- [11 — Delinquency](./11-delinquency.md) — reads `balance` and `lastDueDate`.
- [21 — SaaSLogic Billing](./21-saaslogic-billing.md) — registers an amount due and returns payment results.
- [00 — Data Model Overview](./00-data-model-overview.md) — the three entities in the master index.
