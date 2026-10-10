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
account.balance        =  SUM(openAmount) WHERE type <> 'DEPOSIT'
account.depositAmount  = -SUM(openAmount) WHERE type =  'DEPOSIT'
```

**The balance line is narrower than it first shipped, and deliberately.** It was `SUM(openAmount)` over every entry until deposits moved into the ledger. A deposit is money the utility *holds*, not money the customer owes — a liability, not a negative receivable — so netting the two produces a figure answering neither question. Worse, `delinquency.service` sweeps `balance > 0` to find arrears: an account owing $169.25 while the utility holds their $500 would read as −$330.75 and never be chased, and deposits are taken from exactly the customers who most need chasing. `depositAmount` is the second cache, held positive because the column carries a `>= 0` CHECK older than the ledger, and reconciliation proves both, reporting a `field` of `balance` or `deposit` so a drift row says which figure is wrong.

**"Open" means open receivable**, for the same reason: a deposit's `openAmount` is non-zero for as long as the utility holds it, so counting by sign alone reported "1 open item" on an account owing nothing. `listLedger`'s `openCount` and its `openOnly` filter read one definition — non-zero `openAmount` and not a `DEPOSIT` — because a header saying three over a filtered list of four is a discrepancy whose obvious resolution is that one of them is wrong.

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
| GET | `/api/v1/bills` | `accounts:VIEW` | The tenant-wide bill list, added in slice 4b. Filters on `accountId`, `billingCycleId`, an inclusive `from`/`to` on `billDate`, and a tri-state `posted`; `search` matches the bill number. Returns the account number, customer name, cycle name and `postedAt` per row, because a list of bill numbers against account uuids cannot serve the lookup it exists for. Same gate as the account-scoped list it generalises. |
| GET | `/api/v1/receipts` | `payments:VIEW` | The tenant-wide receipts list — money that **arrived**, so `PAYMENT` and `DEPOSIT` both, with `type` to narrow to one. Added as `/api/v1/payments` in slice 4b and renamed when deposits joined it, because a path saying `payments` while serving deposits misleads its next reader. Filters on `accountId`, `type`, `tender` and an inclusive `from`/`to` over `effectiveDate` — the day the money was taken, which is what a bank deposit is tied out against, not the day the row was written; `search` matches `externalRef`, the cheque or lockbox reference an operator holds. Amounts come back **positive** (stored negative, because money received is a credit). Carries `totalReceived` for the whole filter rather than the page, plus `subtotals` per kind with every kind spelled out — a missing key and a genuine zero read alike to a person and are not the same fact. Money leaving is not here: a bank slip is one-directional. Reading receipts is `VIEW`; taking money stays `CREATE`. |
| GET | `/api/v1/accounts/:id/ledger` | `accounts:VIEW` | The account's entries for display: the reason label, the bill number, the tender, and reversal links resolved in BOTH directions so a reader is not left pairing rows by amount. Returns the cached `balance` and an account-wide `openCount` alongside; capped at 500 rows, with `openOnly` and `limit`. On `accounts:VIEW` rather than a writing module, because a CSR who may not take a payment still needs to see what is owed. |
| GET | `/api/v1/ar/reconciliation` | `accounts:VIEW` | Proof, not assertion: every account whose cached `balance` differs from `SUM(open_amount) WHERE type <> 'DEPOSIT'`, **or** whose cached `depositAmount` differs from the deposits — two caches, so a drift row carries a `field` of `balance` or `deposit` to say which. A check proving only the first would let the second drift unseen, and the second is the one holding thousands. Returns `{ ok, checked, drift }`. `checked` is the number of accounts examined, and it is what makes an empty `drift` mean anything — a check that could see no accounts returns the same empty list as a clean ledger, so `ok: true` on its own is not evidence. Both statements run inside one `withTenant`, on one connection, so the count cannot reassure about a population the drift query never saw. |

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
| Unposted-bills note | An unposted bill is a calculation, not a debt, so it is context for the balance — it explains a figure lower than the customer expects — and says the bills are "not counted below". It carries no Post action: a tab listing what is owed cannot show an unposted bill among its rows, so posting belongs on Bills, where the bill lives. Links to `/bills?posted=false`. On `accounts:VIEW`, matching the endpoint — the earlier `accounts:EDIT` gate was copied from the Post button and hid the note from the read-only users it most helps |

| Action | Gate |
|---|---|
| Record Payment | `payments:CREATE` |
| Reverse an entry | `payments:EDIT` |
| Raise Fee | `ar_adjustments:CREATE` |
| Raise Charge | `ar_adjustments:CREATE` |
| Waive / Write off a charge | `ar_adjustments:EDIT` |

The reason dropdown was unreadable before any of this mattered: the app declared no `color-scheme`, so Chrome painted the native `<option>` popup light while the options inherited the dark theme's near-white `--text-primary`. Every `<select>` in the app — 38 files' worth — opened looking empty, with the entries present and invisible. The popup is drawn by the browser outside the page, so nothing applied to the `<select>` itself could reach it. Fixed in `globals.css` with `color-scheme: dark` on `:root` and `light` under `[data-theme="light"]`, plus an explicit `select option` colour pair as insurance on platforms that ignore the hint.

An empty reason dropdown distinguishes two facts that the dialog previously conflated: a tenant with no reason codes, and a lookup that failed. Swallowing the error into an empty list made a failed request read as "this utility has no reason codes", which sent anyone diagnosing it looking for missing data when the call had never succeeded. The genuinely-empty case now offers a button that calls `POST /api/v1/ar/reasons/seed-defaults` — the endpoint's first UI; the message used to instruct the operator to POST to it themselves — and the failure case offers a retry instead, since seeding would not fix it.

`AdjustDialog` takes an `AdjustTarget` — id, both amounts, and a label — rather than a whole `LedgerRow`. The bill list is the second caller and the charge arrives there as four fields, so the wider type would have forced it to invent eleven nulls for a shape the dialog does not read.

**Raise Charge** is separate from **Raise Fee** on purpose, and was an orphan endpoint until slice 4b: `POST /api/v1/accounts/:id/adjustments` shipped in slice 3 with no caller. The two stay apart because the ledger keeps them apart — a `FEE` ages on its own due date and is collected *before* bills in the §6.3 order, while an `ADJUSTMENT_DEBIT` is a correction to what was billed and is paid after fees and before bill charges. One button for both would let the operator's choice of words set an allocation order they cannot see, and each cites its own reason type so the dropdown already refuses to mix them.

Waive and Write off appear only on an open charge — a credit cannot be forgiven and a settled charge has nothing left to forgive — and the reason dropdown is filtered per act, so a waiver is never offered a write-off reason. Reverse is offered only where it can succeed: not on an entry already reversed, and not on a `REVERSAL`.

### Settings → Automation: auto-post

`autoPostBills` is exposed as a toggle in its own **Billing** section on `/settings/automation`, not in the Schedulers card, because it is not a background job — it runs inside the bill-generation transaction, which is why a bill and its receivable commit together or not at all. It resolves `account.autoPostBills ?? tenantConfig.autoPostBills ?? true`, so the tenant toggle moves every account that has not explicitly opted out.

It shipped in slice 1 as an orphan field: the service returned it and the patch schema accepted it, but no screen drew a control, so manual posting was reachable only by SQL and the AR tab's unposted-bills strip described a state no tenant could enter. A drift guard now derives the editable key list from `AutomationConfigSchema` and fails if a setting is never rendered.

**The per-account override has no UI yet** — `account.autoPostBills` is not on the account API's read or write surface, so an account cannot yet opt out of a tenant default.

### Billing & AR → Bills

`/bills` on `accounts:VIEW`, rendering `GET /api/v1/bills`. The tenant-wide list, and the answer to a CSR holding a bill number: search by bill number is the primary control, not a refinement.

| Decision | Why |
|---|---|
| Clicking the bill number opens the bill (`BillDetailDialog`), not the account | A bill number is what a caller reads out. Landing on the account page would make the operator find the bill a second time. The account number beside it still links to the account |
| Status column, and the **Post** action, live here | A bill is a calculation until posted; only then is it owed. This is the only screen that can show an unposted bill, so it is the only screen the action can sensibly sit on. Posting stays on `accounts:EDIT` |
| **Still owed** shown beside **Total** | A $64.20 bill with $15 left is not a $15 bill. §4.6 keeps `bill.total` and the ledger authoritative for different things, and a CSR on a call needs the second figure without doing arithmetic. A dash where no charge exists, never $0.00, which reads as settled |
| **Take payment** is labelled against the account | `recordPayment` takes an `accountId` and `recordPaymentSchema` carries no `billId`. §6.3 allocates oldest-first across FEE → ADJUSTMENT_DEBIT → BILL_CHARGE, so money taken here may land on an older fee. A per-bill "pay this bill" button would misstate where it goes |
| **Reverse**, not Void | There is no void and no unpost. §3.5: a wrong charge is reversed, both sides stay on the ledger, and the bill itself is unchanged. Reversal is entry-level, so the list returns the bill's `BILL_CHARGE` entry id. The confirm names the alternative — waive a charge that was correct — so the three acts stay distinct at the point of action |
| **Waive** and **Write off** on the bill's charge | Both take a `debitId`, and the bill's `BILL_CHARGE` entry is one. Scoped to what is still open, not the bill total, and the reason list is filtered per act so a waiver is never offered a write-off reason |
| Actions offered only where they can succeed | Post before posting; payment, reverse, waive and write off only after. Nothing is owed on an unposted bill. No Reverse on a charge already reversed; no Waive or Write off unless the charge is open — a settled charge has nothing left to forgive, a reversed one no longer stands |
| `charge` is `BILL_CHARGE` only | A bill that netted negative posted an `ADJUSTMENT_CREDIT`, and waiver credits can also carry a `billId`, so widening the filter would let an unrelated credit be read as the bill's own charge |
| Columns drop on narrow screens | Below 768px the table keeps Bill #, Customer, Still owed, Status and Actions; Account, Due and Total go, and Period goes below 1200px. Chosen by what a CSR cannot answer a call without — **Still owed survives and Total does not**, because the question on a call is what is outstanding, not what was first charged. Everything hidden stays one tap away in the bill dialog. This table is hand-rolled, so it uses the `col-hide-*` classes; a table on the shared `DataTable` declares the same thing as `hideBelow` on its column |
| `posted` filter is tri-state | Omitted means every bill. A boolean defaulting either way would silently hide half the list. "Not posted" is the posting queue a manual-post tenant works daily |
| Dates rendered from the ISO string, not `new Date()` | `new Date("2026-06-30")` is UTC midnight, which is the 29th west of Greenwich, so a bill would appear dated a day early |

`to` and `from` are inclusive. A plain `lte` is correct only because `bill.billDate` is `@db.Date` and carries no time; if that column becomes a timestamp it must become `lt` the following day, or every range query drops its final day.

### Deposits

A security deposit is a `DEPOSIT` ledger entry, not a bare column. The money moved, so it is recorded where every other movement is — auditable, and refundable one day by the same mechanism as any credit. Spec 04 used to say deposits were "not managed in CIS financials"; that rested on a SaaSLogic boundary module 23 replaced, and spec 04 now carries the correction.

It is a **credit by sign and a liability in meaning**, which is why it is excluded from two places:

| Excluded from | Why |
|---|---|
| **Allocation** (`applyCreditsToDebit`) | A deposit is held until the account closes or the customer earns it back — next month's water bill must not spend it. The credit filter is on sign alone (`openAmount < 0`), so without an explicit `type: { not: "DEPOSIT" }` a deposit would be absorbed oldest-first, silently, on the next posting run |
| **`Account.balance`** | A deposit is money the utility *holds*, not money the customer *owes*. Netting them gives a number that answers neither question — and `delinquency.service` sweeps `balance > 0`, so an account owing $169 against a $500 deposit would read as −$330 and never be chased. Deposits are taken from exactly the customers who need chasing |

`balance` is therefore `SUM(open_amount) WHERE type <> 'DEPOSIT'`, a deliberate narrowing of the §5 invariant. `Account.depositAmount` becomes the second cache — `-SUM(open_amount) WHERE type = 'DEPOSIT'`, held positive because the column has a `>= 0` CHECK older than the ledger — and reconciliation proves both, reporting a `field` of `balance` or `deposit` so a drift row says which figure is wrong.

`depositWaived` and `depositWaivedReason` stay on the account: they record whether a deposit was *required*, which is a decision, not money.

**Where it shows.** The account **Overview** names it *Deposit Held*, read-only. The **AR tab** carries a third balance card, *Deposit held — not counted against what is owed*, shown only when there is one; `GET /accounts/:id/ledger` returns `depositHeld` beside `balance` for it. That card is not decoration: `listLedger` does not filter by type, so the `DEPOSIT` entry appears in the table like any other row, rendered `($500.00)` by the credit convention — directly beneath a header saying $169.25 is due. Without the card the two read as a contradiction, and a reader would reasonably conclude the credit should have cancelled the debt.

**Taking a deposit** goes through `recordDeposit`, which every path that used to write the column now calls inside its own transaction — account creation, move-in and the account importer — so an account and the deposit it was opened with commit together or not at all.

**`depositAmount` is no longer editable.** It is omitted from `updateAccountSchema`, so `PATCH /api/v1/accounts/:id` answers `Unrecognized key(s) in object: 'depositAmount'`, and the account page shows it read-only. Nobody types over `balance` either. A deposit changes by taking one or returning one — acts with a tender, a date and an audit row — and editing the number would leave the column disagreeing with the ledger until a recompute silently overwrote it, with reconciliation reporting the drift in between. `depositWaived` and `depositWaivedReason` remain editable, being decisions rather than money.

**Still outstanding:** nothing *returns* a deposit — that is refunds, and it is now unblocked, because returning a deposit is the same act as refunding any credit. Interest accrual and statutory return rules need account-level state that does not exist yet.

### Billing → Receipts

`/receipts` on `payments:VIEW`, rendering `GET /api/v1/receipts`, titled **Money received**. Answers the question no screen could answer before — *what did we take, and does it agree with the bank* — because every view of money received was scoped to one account, so counting a day's takings meant visiting accounts one at a time.

**Why it is not called Payments.** The test for being on this screen is "did this money arrive", not "was this a payment". A security deposit taken at the counter is in the same till and on the same bank slip as a cheque settling a bill, so a total that omitted deposits would under-report the day — and would look like a complete day's takings while doing it. With $3,000 of deposits in the seeded tenant, the figure was wrong by exactly that and silently. The screen, the route and the endpoint were all renamed together, because a path saying `payments` while serving deposits misleads the next person to read it.

| Decision | Why |
|---|---|
| Opens on **today** | That is the question being asked by anyone who comes here at all |
| **`PAYMENT` and `DEPOSIT` both included**, `type` narrows | Both arrive, both are on the bank slip. Neither is the other: a payment retires a receivable, a deposit creates a liability to hand back |
| **One combined total, with a per-kind split beneath** | The bank slip is one figure; the accounting is two. Both questions get asked of this screen and they want different numbers |
| **A kind that took nothing is stated as `0.00`**, not omitted | "No deposits today" is an answer. A line that disappears at zero cannot be told from a screen that never looked — the same failure as a reconciliation reporting clean because it saw nothing |
| The **Kind** column is never hidden on a narrow screen | A deposit read as a payment is a wrong answer to "have they paid?", and no width saving is worth that. Deposits also carry a tag rather than only a word |
| **Money leaving is deliberately absent** | A bank slip is one-directional. A refund netted into this total would destroy the tie-out rather than enrich it; disbursements want their own screen and their own tie-out against the cheque run |
| `totalReceived` covers the **filter**, not the page | A daily total that stopped at the page boundary would be wrong the moment a day ran past 25 rows, and silently so |
| **A reversed payment stays in the total** | A cheque banked on Monday and returned on Wednesday was in Monday's deposit. Netting it out of Monday would stop the figure agreeing with the bank, which is the total's only job. The row is struck through and badged `reversed`, and the card says so in words, so nobody reads the total as money still held |
| Amounts shown positive | Stored negative because money received is a credit; this list is read by someone counting cash. Negated once, in the service |
| Dates rendered from the ISO string | `new Date("2026-06-30")` is UTC midnight — the 29th west of Greenwich — so a receipt would appear a day early |

**Prerequisite that shipped with it:** a deposit now carries its tender. `recordDeposit` always accepted one, but account creation and move-in passed none, so every deposit arrived blank — and a tie-out groups by tender, which made them unmatchable against the slip they were part of. `createAccountSchema.depositTender` and the move-in payload's `depositTender` close that; both are optional, because "unknown" is sometimes the truth, and both are omitted from `updateAccountSchema` for the same reason the amount is — the tender describes one act of taking money, not a property of the account. The account importer still writes no tender: an imported deposit is historical backfill rather than counter takings, so there is no slip to tie it to.

**Not built, and deliberately:** no `Payment`, `PaymentBatch`, `Deposit` or cash-drawer model. A list with a date range and a total answers the tie-out question without inventing a batch granularity nobody has chosen yet. Add the batch when someone needs to *close* one — per day, per user or per drawer — not before.

### Settings → Ledger Integrity

`/settings/ledger-integrity` on `accounts:VIEW`, rendering `GET /api/v1/ar/reconciliation`.

**It is not reconciliation, and it was wrongly named and wrongly placed when it shipped.** In utility billing that word means tying receipts to a bank deposit, or the AR subledger to a GL control account; this does neither, and the word is already carrying five other meanings in these specs — budget-billing true-up (07, 09), meter-read imports (08), water versus wastewater (09, Bozeman 141) and RAMS container inventory (12). Sitting in a **Billing & AR** menu under that label, it promised a CSR something the product does not have.

What it actually is: an integrity check on a denormalisation. `account.balance` is a cache written inside the posting transaction so delinquency sweeps and list screens need not sum the ledger on every read, and a cache drifts when something writes around it — a manual SQL fix, a bad import, a future code path that skips `recomputeAccountCache`. An admin runs it after a migration or a repair. That is why it now sits in **Settings** beside Retention & Audit rather than in a menu a CSR works.

The endpoint keeps its path. `reconcileBalances` reconciling a cache against its source is accurate engineering English, the route is unambiguous inside `/api/v1/ar/`, and no API path is read by the CSR the old label misled.

**The nav entry and the endpoint are gated differently, on purpose.** The entry is on `settings`; the endpoint stays on `accounts:VIEW`.

The endpoint cannot move. It was once gated on `tenant_profile`, and a tenant with the `accounts` module enabled but not that one lost the endpoint outright to `403 MODULE_DISABLED` — `ledger-routes.integration.test.ts` still carries that regression guard, and gating it on `settings` would reintroduce the same fault for any tenant without the settings module.

The entry cannot stay on `accounts`. Every role but Portal Customer holds `accounts:VIEW` — CSR, Field Technician and Read-Only included — so the entry put an admin diagnostic in front of three roles that can do nothing about drift, and for a Field Technician it was the only Settings entry visible at all. Today `settings` holders are a strict subset of `accounts:VIEW` holders so nothing goes dead; a tenant granting `settings` without `accounts` would meet a 403, which is the lesser fault and the one that affects nobody today.

The healthy result is the usual result, so the page is built around reassurance rather than as a work queue, and it has **three** outcomes, not two:

| Outcome | Rendered as | Why it is separate |
|---|---|---|
| `checked > 0`, no drift | **In balance**, "All N accounts match the ledger" | The count is the evidence. "No drift" without a population is not a claim. The copy says *match the ledger*, not *reconcile* — renaming the page while the body still said "reconcile" would have left the misleading word exactly where a reader looks |
| `checked === 0` | **Inconclusive**, not green | An empty drift list is also what a check that could see no accounts returns. Reported as proving nothing, so a blinded check cannot read as a clean bill of health |
| drift present | **Out of balance**, "N of M accounts do not match the ledger", with stored / ledger / signed difference per account | Linked to the account's AR tab. Signed with an explicit `+`/`−`, not the brackets the AR tab uses for credits, because this is a discrepancy and not a credit |

**Refunds do not exist.** `LedgerEntryType` has seven values and none of them is a refund, and there is no endpoint. "Refund due" is only a *state* — an open credit, from an overpayment or from a waiver exceeding the charge it named (§6.5). Nothing disburses it, so an account can sit in credit indefinitely. Closing this needs a decision rather than code: a `REFUND` debit that consumes open credits would keep the §5 balance identity true — `SUM(open_amount) WHERE type <> 'DEPOSIT'`, since the refund is a receivable-side entry — but money leaving the building also wants a disbursement record, tender, cheque number and issued date, to reconcile against a bank.

Two things are now settled that were not when this was first written. **Returning a deposit is the same act as refunding any other credit**, because a deposit is a `DEPOSIT` credit on the ledger rather than a bare column, so this is one feature and not two. And the migration will need **two files**, as the deposit one did: PostgreSQL will not let a value added to an enum be used in the transaction that adds it, and Prisma runs each migration in one transaction. The constraint edits — `ledger_entry_type_sign` for a `REFUND` debit, and `ledger_entry_tender_only_payment` if a refund is to carry how the money left — belong in the second file with the data.

A refund must also be **capped at the credit actually available**: paying out more than is held would drive a credit's `openAmount` past zero and break the §5 identity, which is a different failure from an overpayment and not a thing the ledger should represent.

**Still outstanding, deferred to slice 4b with reasons:** the statement view (§7.1, needs bill-period boundaries), the aging summary (§7.2, belongs with the dashboard widget that consumes it, and sits under Collections rather than here because collections staff are who use it), the portal amount due, reason-code CRUD (belongs in Configuration beside Account Types, not in a work-queue section), and the per-account auto-post override. Design §8 lists the aging summary as part of the AR tab; it is not in 4a, and that is a known gap rather than an oversight.

**Cross-account gap, found while placing the nav:** every bill and ledger route except reconciliation is account-scoped or single-id — `routes/bills.ts` holds exactly one route, `GET /api/v1/bills/:id` — so there is no tenant-wide list of bills or ledger entries, and `billNumber` is searchable from no endpoint. A CSR holding a bill number cannot find that bill, and with auto-post off, finding unposted bills means visiting accounts one at a time. A **Bills** list with bill-number search and a **Posting Queue** are the next two entries in this section, and both need new endpoints.

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
