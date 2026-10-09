# Accounts Receivable

**Module:** 23 — Accounts Receivable
**Status:** Phase 3 — slice 1 (ledger foundation and bill posting) shipped; slices 2–6 outstanding.
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
| `LedgerApplication` | `ledger_application` | Table shipped, empty | Which credit paid down which debit, and by how much. Written from slice 2, when payment allocation lands. |
| `LedgerReasonDef` | `ledger_reason_def` | Table shipped, empty | Why a fee or adjustment was raised, in the utility's own words. Seeded in slice 3. |

### Columns added to existing entities

| Column | Type | Notes |
|---|---|---|
| `Bill.postedAt` | TIMESTAMPTZ? | Null until the bill posts. A cache of a derivable fact, written in the posting transaction, so the operator screen can filter unposted bills without an anti-join. |
| `Account.balance` | DECIMAL(14,2) | Pre-existing column, now actually written: `SUM(ledger_entry.open_amount)` for the account, recomputed inside the posting transaction. Never written by a background job, which is why it cannot drift. |
| `Account.lastDueDate` | DATE? | The **oldest open debit's** due date, null when nothing is open. See module 11 — the name predates this meaning and a rename is a slice 5 item. |
| `Account.autoPostBills` | BOOLEAN? | Per-account override. Null means inherit the tenant setting, so flipping the tenant value moves every account that has not explicitly opted out. |
| `TenantConfig.autoPostBills` | BOOLEAN NOT NULL DEFAULT true | Tenant default. No `tenant_config` row means an unconfigured tenant, which takes the column default: auto-post on. |

The `tenant_isolation` RLS policies on the three new tables are inert as things stand, because the application role is a SUPERUSER and superusers bypass RLS. Tenant separation rests on the `utility_id` predicates in application code. Pre-existing condition, recorded in the migration's header comment.

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
| GET | `/api/v1/ar/reconciliation` | `accounts:VIEW` | Proof, not assertion: every account whose cached `balance` differs from `SUM(open_amount)`. `{ ok: true, drift: [] }` when the cache is correct. |

Posting is gated on the same permission as generating a bill (`POST /api/v1/accounts/:id/bills`): generation already posts when auto-post is on, so posting must require no more authority than generating. The two reads are account data, not tenant configuration, so they sit on `accounts:VIEW`. The new module keys `payments` and `ar_adjustments` (design §8) arrive with slices 2 and 3, when there are operations whose authority differs.

## Business rules in force (slice 1)

1. **One entry per Bill**, not per segment or line.
2. **Rounding happens once per bill**, half-up, from the rate engine's `Decimal(14,4)` to the ledger's `Decimal(14,2)`. `SUM(bill.total)` and `SUM(ledger.amount)` can therefore differ by cents across many bills; the ledger is authoritative for money owed, the bill for what was calculated.
3. **A bill that nets negative posts as `ADJUSTMENT_CREDIT`**, not as a `BILL_CHARGE` with a negative amount — the type↔sign constraint holds and the entry reads as what it is. It still carries its `billId`; it carries no `dueDate`, because only a debit ages.
4. **A bill whose total rounds to 0.00** is marked posted and writes no entry. `CHECK (amount <> 0)` would reject the entry, and a zero receivable is not a thing that can be paid.
5. **Posting is idempotent.** The bill is claimed with an atomic `UPDATE ... WHERE posted_at IS NULL` under a row lock on the account; a partial unique index on `(utility_id, bill_id) WHERE type = 'BILL_CHARGE'` is the structural backstop.
6. **Posting and the balance update are one transaction.** No event, no queue, no second transaction — an async balance update would reopen the atomicity gap that the EventEmitter audit pipeline had.
7. **Auto-post resolves tenant default, overridden per account**, with `??` so an account override of `false` beats a tenant default of `true`.

## UI

Nothing in slice 1 — the surface is the three API routes above. The account AR tab (ledger, aging summary, record-payment, adjust/waive) and the unposted-bills list with a Post action land in slice 4, per design §8.

## Slice roadmap (design §10)

| Slice | Scope | Status |
|---|---|---|
| 1 | Ledger foundation — schema, enums, `postBill`, `balance` + `lastDueDate` cache, `postedAt`, auto-post config, reconciliation query and property test | **Complete** |
| 2 | Payments — `recordPayment`, allocation, open-credit auto-apply (design §6.1 step 4), `reverseEntry` for NSF | Outstanding |
| 3 | Fees and adjustments — `LedgerReasonDef` seeds, `assessFee`, waive / write-off / adjust, the `payments` and `ar_adjustments` module keys | Outstanding |
| 4 | Visibility — statement view, aging query, account AR tab, portal amount due | Outstanding |
| 5 | Delinquency rewire — the two reader call sites in `delinquency.service.ts`, and renaming `lastDueDate` to say what it holds | Outstanding |
| 6 | Late-fee generation — a fee amount on `DelinquencyRule` and a `LATE_FEE` action type calling `assessFee` | Outstanding |

Known deferrals carried out of slice 1, each recorded in the design doc: auto-applying open credits when a debit posts (§6.1 step 4, slice 2); the `assessed_on_id` and `reason_id` CHECK constraints (slice 3, when fees and reasons exist); refunds, which need a new enum value and therefore a migration (§11 item 4).

## Related specs

- [09 — Billing](./09-billing.md) — produces the `Bill` that AR posts.
- [10 — Payments and Collections](./10-payments-and-collections.md) — records payments against this ledger; payment plans and collections workflow.
- [11 — Delinquency](./11-delinquency.md) — reads `balance` and `lastDueDate`.
- [21 — SaaSLogic Billing](./21-saaslogic-billing.md) — registers an amount due and returns payment results.
- [00 — Data Model Overview](./00-data-model-overview.md) — the three entities in the master index.
