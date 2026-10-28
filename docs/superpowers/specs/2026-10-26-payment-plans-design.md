# Payment Plans — Design

**Bozeman #147, #148.** Status: design. Nothing is built.

**Supersedes** the `PaymentPlan (planned)` sketch in
`docs/specs/10-payments-and-collections.md`, which this document amends
rather than contradicts except where stated.

---

## Three decisions I need from you

I have taken a position on each so the rest of the document is concrete.
Overturn any of them while reading; they are marked where they appear.

1. **A plan covers the debts that existed when it was agreed, and not
   later bills.** The customer stays current on new bills while paying
   the arrears in installments. (§3)
2. **Defaulting a plan does not re-charge late fees the ladder already
   charged on those bills.** If breaking an agreement should cost
   something, that is its own named fee, not a replay of the ladder.
   (§7)
3. **Agreeing a plan waives nothing.** Late fees already raised are
   carried into the plan's balance like any other debt; waiving one
   stays a deliberate act with a reason on it. (§6)

---

## 1. What this is, and why now

A payment plan is an agreement that an account may pay a balance in
installments instead of on the original due dates, and that collections
leaves those debts alone while the customer keeps to it.

Today it is a single string. `resolutionTypes` contains `PAYMENT_PLAN`,
and `/delinquency/shutoff-eligible` has a button that calls
`resolveAccount(..., "PAYMENT_PLAN")`. That cancels the account's live
delinquency actions and writes the word on the action row. There is no
schedule, no installments, no tracking, and nothing stopping the account
climbing the ladder again next month. `PaymentPlan|payment_plan` has
zero hits outside that enum.

**Why it matters more than it did last week.** Until 2026-10-25 the
ladder decided an account was delinquent and wrote nothing financial, so
a payment plan protected a customer from a notice. It now protects them
from money: late fees post to the ledger and print on the next bill. A
button that claims to grant a plan and does not suppress a charge is now
a billing defect rather than a cosmetic one.

## 2. Goals, non-goals, anti-goals

**Goals**
- Record an agreement: what is covered, what the installments are, and
  what state it is in.
- Suppress the delinquency ladder — fees *and* notices — on the covered
  debts while the plan is kept.
- Detect a broken plan and put those debts back in the ladder's view.
- Let staff see and manage plans, and let a customer see their own
  schedule in the portal.

**Non-goals (not now, not never)**
- Autopay through SaaSLogic. Spec 10 reserves `saaslogic_plan_id` and
  spec 21 is still waiting on vendor answers. A plan here is a CIS-side
  agreement; payments arrive however they already arrive.
- An approval workflow. `approved_by` records who agreed it; routing a
  request for approval is the same deferred capability spec 23 names.

**Anti-goals (would make this wrong even if it worked)**
- **It is not a loan.** No interest, no finance charge, no amortisation.
  Special assessments (spec 16) have those and are a different thing.
- **It is not levelized or budget billing.** Spec 10's
  `plan_type: LEVELIZED` should be struck: smoothed billing from
  estimated annual consumption already exists as `rate_type = BUDGET`
  in spec 07, computed by the rate engine at billing time. It is a way
  of *pricing* a period; a payment plan is a way of *settling arrears*.
  Putting both in one entity would mean a status machine where
  DEFAULTED is meaningful for one member and senseless for the other.
- **It must not become a second place that decides what is owed.** The
  ledger is the system of record. A plan changes *when* money is due
  and whether collections chases it, never the balance.

## 3. What a plan covers — the decision everything hangs on

**Decision 1: a plan names the open debits it covers.** Not the account,
and not "everything from now on".

The delinquency ladder became per-bill on 2026-10-25: each open overdue
debit passes the tiers on its own clock. That makes the natural unit of
suppression a debit, and it answers the question an account-level flag
cannot — what happens to the bill issued next month. Under this model
the customer pays that one normally, and the plan governs the arrears
they agreed about. That is also the ordinary utility arrangement: stay
current, pay the back balance down.

So:

```
payment_plan_debit (utility_id, plan_id, entry_id)
```

Primary key `(utility_id, entry_id)` — a debit belongs to at most one
plan. Both foreign keys tenant-scoped composites, in the migration, as
every key between two tenant-scoped tables here is.

The rejected alternative was a `covers_debts_as_of` date on the plan,
with the charging pass skipping debits due on or before it. It needs no
join table, and it is implicit in the wrong way: a back-dated bill
issued later would be swept into an agreement nobody made about it.
Naming the debits is auditable — the customer agreed to a schedule for
*these* bills — and lets `total_balance` be checked against the sum of
what it covers.

**The second rejected alternative is Oracle's, and worth recording
because it is a real system's answer rather than one I invented.** In
CC&B a payment arrangement is **its own service agreement**: the overdue
debt is *moved* onto it, the installment amount becomes that agreement's
recurring charge, it is billed on the regular cycle with the customer's
other services, and missing an installment breaks the arrangement and
sends it for credit review. So the plan does not tag the debts — it
takes them.

It is coherent there and wrong here, for a reason specific to this
ledger. CC&B's model is built for transfers between service agreements,
so moving debt is a first-class operation. Ours has no such operation:
the equivalent is reversing the original debits and raising new ones,
which destroys the per-bill history the ladder keys on — "a tier charges
each bill once" has nothing left to key on once a bill's debit is gone —
and makes the plan's balance authoritative over the ledger's, which §2
rules out. Naming the debits gets the same installment behaviour without
relocating the debt.

(Sources: CC&B URM 4.3.2.4a on payment arrangements; C2M 4.2.2.12 on
billing their charges.)

## 4. The entity

Spec 10's sketch, amended. Fields struck or added are called out; the
rest stands.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| utility_id | UUID | Tenant scope, FK to `utility` |
| account_id | UUID FK | Composite `(utility_id, account_id)` |
| plan_type | ENUM | **INSTALLMENT, DEFERRED only.** LEVELIZED struck — see anti-goals |
| status | ENUM | PENDING, ACTIVE, COMPLETED, DEFAULTED, CANCELLED |
| total_balance | DECIMAL(10,2) | Sum of the covered debits at creation, frozen |
| down_payment | DECIMAL(10,2) | Nullable |
| installment_amount | DECIMAL(10,2) | |
| installment_frequency | ENUM | WEEKLY, BIWEEKLY, MONTHLY |
| installment_count | INTEGER | |
| start_date | DATE | First installment due |
| default_threshold | INTEGER | Consecutive misses before DEFAULTED |
| approved_by | UUID | The staff member who agreed it |
| notes | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

**Struck from the sketch:** `installments_paid`, `next_due_date`,
`end_date`. All three are derivable from `start_date`,
`installment_frequency`, `installment_count`, `installment_amount` and
the payments allocated to the covered debits — and a stored copy of a
derivable figure is a copy that can disagree with the ledger. The
schedule is a formula, not data:

```
installment n is due start_date + (n - 1) * frequency, for n in 1..count
```

which also answers "which installment was missed" without an
installment table. The rejected alternative was
`payment_plan_installment` rows; it earns its keep only when
installments can be individually re-negotiated, which nobody has asked
for.

**`saaslogic_plan_id`** stays in the sketch and out of this slice.

## 5. Suppression — the part that touches live code

Two places, because the ladder has two clocks.

**The charging pass** (`chargeOverdueBills`) already selects chargeable
debits. A debit covered by a plan in `PENDING` or `ACTIVE` is not
chargeable. One predicate in `chargeableDebits`.

**The account-level clock** is the harder half. `evaluateAll` derives
`daysPastDue` from `Account.lastDueDate`, which `recomputeAccountCache`
maintains as the oldest open debit's due date. A covered debit stays
open while it is paid down, so without a change the account keeps
climbing the ladder on debts the utility agreed to wait for — notices,
shut-off eligibility, disconnection.

The clock becomes **the oldest open debit not covered by an active
plan**. If there is none, the account is not delinquent and no tier
fires. A new unpaid bill is uncovered, so it ages and is chased
normally, which is exactly the behaviour the agreement implies.

Deliberately **not** done by changing `Account.lastDueDate`: that column
is AR's and means "the oldest open debit", full stop. Reconciliation and
the aging query read it. Delinquency can ask its own question without
redefining somebody else's column.

## 6. Fees already raised

**Decision 3: agreeing a plan waives nothing.** A late fee is a debit
with its own due date, so it can be covered by the plan like any other
debt, and then it is paid down with the rest.

The alternative — waive the fees on agreement — makes the plan a
forgiveness mechanism, which is the thing
`delinquency_rule_replace_needs_fee` and the waiver path exist to keep
explicit. Forgiving a charge should have somebody's name and a reason
on it. If a utility routinely waives fees when agreeing a plan, that is
two actions in the UI, not one hidden inside the other.

## 7. Breaking a plan

A sweep, state-keyed, like the delinquency sweeps: for each ACTIVE plan,
count the installments due by today, compare against what has been
allocated to the covered debits since `start_date`, and if the shortfall
is `default_threshold` installments or more, set `DEFAULTED`.

On DEFAULTED the plan stops covering its debits, so they re-enter both
clocks immediately with their real ages — which may be far past the last
tier.

**Decision 2: this does not re-charge the tiers those bills already
passed.** "A tier charges each bill once" is what makes the per-bill
ladder simple and what stopped two real defects on 2026-10-25, and a
default should not quietly reopen it. The customer has already paid a
late fee for each of those bills being late; breaking the agreement is a
different wrong. If it should cost something, give it its own reason and
its own rule — a nameable plan-default fee — so the policy is visible
rather than emergent.

What *does* resume immediately is the notice and shut-off ladder, which
is the pressure that matters.

## 8. Lifecycle

```
PENDING  --down payment received, or none required--> ACTIVE
ACTIVE   --covered debits all closed---------------> COMPLETED
ACTIVE   --default_threshold installments short----> DEFAULTED
PENDING|ACTIVE --staff--------------------------> CANCELLED
```

COMPLETED is derivable too: every covered debit at `open_amount = 0`.
The same sweep that detects a default can close a completed plan, and
both are idempotent because both read state.

## 9. Constraints inherited

- Every table carries `utility_id`, every key between two tenant-scoped
  tables is a composite, and every tenant-scoped table has RLS enabled
  and FORCEd with the `tenant_isolation` policy on one-argument
  `current_setting`. `schema-invariants.integration.test.ts` enforces
  all three, and caught the last new table arriving without the policy.
- Money is `Decimal`, never a JS number.
- No business logic keys on a reason code.
- Writes that must not half-happen go in one transaction; an external
  dispatch never goes inside one.
- The portal reads must carry the ownership check in the query —
  `customerId` in the `where`, a miss being a 404 and not a 403.

## 10. Slices

**Slice 1 — the agreement, and suppression.** The entity, the covered
debits, both suppression points, manual CANCELLED/COMPLETED, the API,
and a staff screen. The shut-off queue's existing `PAYMENT_PLAN` button
becomes "agree a plan" and opens that screen instead of writing a word
on an action row. This is the slice that makes the current button
honest, and it is worth shipping alone.

**Slice 2 — keeping track.** The default and completion sweep, the
derived schedule shown to staff, and the portal view of a customer's own
plan.

**Slice 3 — SaaSLogic.** A plan's installments as a vendor payment
schedule, once spec 21's vendor questions are answered.

## 11. Left to the builder

- Where the staff screen lives: a tab on the account, or a Collections
  section page. The account tab is my instinct, since a plan is about
  one account's arrears, but the Collections sidebar section exists.
- Whether `down_payment` is a separate recorded payment or simply the
  first installment. Spec 10 implies separate (PENDING → ACTIVE on it).
- The exact wording on the bill, if anything. A covered debt is not
  chased but is still owed, and the bill already prints what is owed.
  Saying "on a payment plan" next to it is a presentation question for
  whoever writes the slice.
