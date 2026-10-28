# Payment Plans — Design

**Bozeman #147, #148.** Status: design. Nothing is built.

**Supersedes** the `PaymentPlan (planned)` sketch in
`docs/specs/10-payments-and-collections.md`, which this document amends
rather than contradicts except where stated.

---

## What the industry does, and what follows for us

Checked on 2026-10-28, after a first draft asserted as design truths
several things that turn out to be the jurisdiction's to decide.

**The term of art is "Deferred Payment Agreement."** Not "payment plan"
— that is the wording in Illinois, New York, Arkansas, West Virginia and
Wisconsin rules, and what an operator will call it. Our enum says
`PAYMENT_PLAN` and spec 10's entity is `PaymentPlan`; the label on the
screen should be the one the operator knows, whatever the table is
called.

**The terms are prescribed, and they differ by jurisdiction.**

| Jurisdiction | Down payment | Installments |
|---|---|---|
| Illinois | 25% of past-due, reducible at the utility's discretion | — |
| New York | up to 15% | one tenth of the balance, monthly |
| Arkansas | no more than a quarter, due by close of the 3rd business day | equal, at least 3 months |
| Iowa | — | late charge capped at 1.5% per month |

So the schedule's shape is **tenant policy, not a design constant**.
Nothing here may hardcode a down-payment fraction or a minimum term.

**Montana, with the caveat that matters.** ARM 38.5.1404 allows
installment arrangements any time before termination; 38.5.1415 governs
them and says that on a missed payment the utility *may, but is not
obliged to*, enter a second one; breaking one can justify a deposit.
Those bind **PSC-regulated** utilities — investor-owned ones. A
municipal water and sewer utility is normally outside that jurisdiction
and governed by city ordinance instead. This product must assume
neither, and let both express their own rules.

**Default includes the current bill.** Illinois treats an agreement as
in default when the customer fails to pay the installment **and the
current bill** by the second day after its due date. §7 below defaulted
on missed installments alone, which would let a customer pay every
installment, never pay a new bill, and keep the plan alive while the
arrears shrank and the new debt grew.

**Whether fees accrue during a plan is not settled practice.** One
municipal agreement says late fees are *not accumulated while the plan
is met and are assessed if it terminates*; another warns that fees keep
accruing throughout. Both are in production use, so it is a setting
rather than a fact.

Sources: [Ill. Admin. Code 83 §280.120](https://www.law.cornell.edu/regulations/illinois/Ill-Admin-Code-tit-83-SS-280.120),
[National Grid NY DPA](https://www.nationalgridus.com/Form/NY-DPA-E-Sign),
[Arkansas](https://state-rules.com/arkansas/car/455-613/),
[Iowa 199—27.3](https://www.legis.iowa.gov/docs/iac/rule/08-07-2024.199.27.3.pdf),
[Montana PSC deposit and shutoff rules](https://www.psc.mt.gov/_docs/Consumers/energy/pdf/Deposit-and-Shutoff-Rules.pdf),
[ARM 38.5.1404](https://regulations.justia.com/states/montana/department-38/chapter-38-5/subchapter-38-5-14/rule-38-5-1404/),
[Walsenburg agreement](https://www.walsenburg.org/media/9101),
[St. Charles MN](https://www.cityofstcharlesmn.gov/?p=2424).

---

## One decision I need from you

The other two from the first draft were mine to assert and are not:
they are tenant policy with a default, and they live in §4a.

1. **A plan covers the debts that existed when it was agreed, and not
   later bills.** The customer stays current on new bills while paying
   the arrears in installments. (§3)

This one stays a decision rather than a setting because it is
structural: it decides what `payment_plan_debit` holds, and therefore
what suppression means. A tenant cannot have it both ways without two
suppression models.

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
| total_balance | DECIMAL(10,2) | Sum of the covered debits' **`open_amount`** at creation, frozen. Not `amount`: a bill charge of $110.75 with $55.37 left owes $55.37, and a plan covering its face value would collect money the customer does not owe |
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

## 4a. Tenant policy, with defaults

Everything the table above left as a free field is constrained by
somebody's rules, and whose rules differ by tenant (§ "What the industry
does"). So the terms live in a tenant setting and the entity records
what was agreed under it.

`UtilityConfig.settings.paymentPlans`, a validated `.strict()` namespace
— the same shape as `issuer` and `billDocuments`, and for the reason the
existing split already encodes: a typed column is for what a scheduler
or a query touches, a settings namespace for what an operator edits and
one code path reads. Nothing filters accounts by down-payment
percentage.

| Setting | Default | Why that default |
|---|---|---|
| `downPaymentPercent` | `25` | The Illinois figure, and the highest any rule found permits — so a tenant under a stricter cap lowers it and none is silently over the line |
| `minInstallments` | `3` | Arkansas' floor |
| `maxInstallments` | `12` | A year. Beyond it the arrears outlive the service period that produced them |
| `frequency` | `MONTHLY` | The billing cycle's own rhythm; a plan that bills off-cycle asks for a payment with no bill beside it |
| `graceDays` | `5` | Days after an instalment's date before it counts as missed. Illinois' test allows until the second day after the due date, which is the shortest found; 5 is the customer-safe side of it, and a tenant under a stricter tariff lowers it |
| `missedInstallmentsBeforeDefault` | `1` | What the agreements found actually say — "default on any instalment". Grace, not a second chance, is what softens it |
| `partialInstallmentCounts` | `false` | Paying $30 of a $65 instalment is not paying the instalment. True for a tenant that credits part payment pro rata |
| `currentBillCountsTowardDefault` | `true` | Illinois' test. False for a tenant whose rules look only at the instalment |
| `suppressFeesWhileKept` | `true` | Charging a late fee on a debt the utility agreed to wait for is the thing a plan is for |
| `assessSuppressedFeesOnDefault` | `false` | See §7 — it reopens "a tier charges each bill once". True is the "deferred, then assessed on termination" pattern some utilities use |
| `allowSecondPlanAfterDefault` | `true` | Montana leaves it to the utility; Iowa *requires* offering one after two consecutive payments under the first. Neither permits a flat refusal in code |

**Defaults are a starting point, not a recommendation.** They are the
most permissive position consistent with the rules found, so a tenant
that does nothing is not accidentally stricter than its regulator
allows — the opposite mistake, being more lenient than allowed, is one a
utility notices.

**What is *not* configurable**: what a plan covers (§3). That decides
the shape of `payment_plan_debit` and therefore what suppression means,
and two answers would mean two suppression models.

### Where it is set: with the rest of collections, not in Settings

**The storage shape must not pick the screen.** A namespace is how these
values are stored; it says nothing about where an operator goes to
change them, and an earlier draft of this section let the one decide the
other. That is an arbitrary split: delinquency rules live under
**Collections** at `/delinquency/rules`, payment-plan terms are the same
kind of thing — how this utility chases money — and an operator
configuring collections should not have to know that one is a table and
the other is JSON.

So: **`/delinquency/plan-terms`**, in the Collections section beside the
rules, sharing their chrome and their permission (`delinquency:EDIT`).
One place answers "how do we chase, and what do we offer instead".

**It reads as four questions, not nine fields.** The settings table
above is the storage; the screen is prose with controls in it, the way
the delinquency rules form reads:

> **What we ask for** — a down payment of `[25]`% of the balance, repaid
> in between `[3]` and `[12]` `[monthly ▾]` instalments.
>
> **When a plan is broken** — after `[1]` missed instalment.
> `[✓]` A customer must also keep paying new bills while the plan runs.
>
> **Late fees** — `[✓]` Do not charge late fees on debts covered by a
> plan. `[ ]` Charge the skipped fees if the plan is broken.
>
> **Afterwards** — `[✓]` A customer may agree a second plan after
> breaking one.

Each checkbox is a sentence an operator can agree or disagree with, not
a flag whose meaning has to be inferred from its name. The two fee
lines are deliberately adjacent and deliberately distinct: one is about
the future, one about what happens to that future if the plan fails.

**A setting nobody can edit is an orphan**, which this codebase has been
bitten by: `autoPostBills` shipped readable and settable with no control
drawn, so manual posting was reachable only by SQL. This screen is part
of slice 1, not a follow-up, and the drift guard that derives editable
keys from the schema should cover this namespace too.

## 4aa. A plan covers debts, of several kinds — and where the money goes

**A covered set is heterogeneous, and the join row is keyed on
`entry_id` for exactly that reason.** From the dev database, one
account's open debits on 2026-10-28:

| Due | Type | What | Open |
|---|---|---|---|
| 2026-07-15 | `ADJUSTMENT_DEBIT` | Opening balance, no bill | 412.80 |
| 2026-09-14 | `BILL_CHARGE` | `BILL-202608-1`, part paid | 55.37 |
| 2026-11-03 | `FEE` | Late fee, for `BILL-202608-1` | 25.00 |
| 2026-11-06 | `FEE` | Late fee, part waived, no bill | 10.00 |
| 2026-11-09 | `BILL_CHARGE` | `BILL-202610-2` | 37.87 |

Several bills, several fees, an adjustment that came from no bill at
all, and one charge already part paid. A plan keyed on bills could not
express this, and a plan summing `amount` rather than `open_amount`
would collect $110.75 for a debt of $55.37.

So the CSR's list of covered debts (§4b) cannot assume a bill number —
two of those five have none. It wants the fallback the AR tab's Bill
column already uses: the bill when there is one, `for <bill>` when the
entry was raised on one, and a dash when neither.

### The allocation problem, which breaks the two-bucket model

**Decision needed.** `applyCreditsToDebit` allocates a credit
oldest-due-first across *every* open debit on the account
(`orderBy: dueDate asc, postedAt asc, id asc`, with a type-class
ranking). It knows nothing about plans.

So: a customer on a plan pays their current bill, $37.87 due
2026-11-09. The allocator applies it to the opening balance due
2026-07-15. The arrears shrink, the current bill stays open, and §7's
"current bill unpaid" test defaults the plan — **of a customer who paid
exactly what they were asked to pay.**

The two-bucket story ("the plan handles the arrears, you stay current")
only holds if money lands in the bucket the payer aimed at. Nothing aims
it today.

My position, to overturn:

- **An ordinary payment settles uncovered debits first**, oldest-due
  among them, and only reaches covered debits once those are clear.
  That makes "stay current" work without the payer declaring anything,
  which matters because most payments arrive through a lockbox or a
  portal and declare nothing.
- **A payment may be marked against the plan**, and then it allocates to
  the covered debits only. This is the CSR taking an instalment over the
  phone, and the portal's "pay my instalment" button.
- **Neither is a new allocator.** Both are the existing one with the
  candidate set filtered, so the oldest-due rule, the type-class
  ranking and the determinism are unchanged.

The rejected alternative is to leave allocation alone and teach §7 to
notice that a current bill was settled indirectly. That is a rule
reasoning about where money *would* have gone, which is the kind of
thing nobody can debug from a ledger.

**This is also where a known gap lands.** Allocation order is tenant
policy in the trade — a city ordinance found on 2026-10-26 applies
receipts to penalty first and principal second — and
`applyCreditsToDebit` has no setting for it. A plan makes a second
demand on the same mechanism, so if it is ever made configurable, the
covered/uncovered split belongs in the same place rather than beside it.

## 4b. What a CSR sees

The terms screen above is set once. These two are used on a phone call,
and the test for both is that nobody has to do arithmetic or hold a
policy in their head.

### Agreeing one

The screen proposes the plan and the operator adjusts it; it does not
present nine empty fields and validate afterwards. Policy becomes a
sentence and a pre-filled schedule:

> **Arrears covered:** 4 debts, **$523.55** — listed, each with the bill
> it came from and the date it fell due, each with a checkbox. Unticking
> one removes it from the plan and from the total.
>
> **Down payment** `$130.89` *(25% — your policy. Lower it if the
> customer cannot manage it.)*
> **Then** `[6 ▾]` monthly payments of **$65.44**, first due
> **2026-11-15**, last **2027-04-15**.

Refusals explain themselves at the control rather than on save: asking
for two instalments says *"your policy is at least 3"*, not "invalid".
The instalment count is a dropdown of the allowed range, so the
unreachable values are never offered.

**The last line is what the customer is actually agreeing to**, so it is
rendered as the schedule, not as a count and a frequency the operator
multiplies out.

### Reading one

On the account, a plan answers four questions in the order they are
asked on a call:

1. **Is there a plan, and is it being kept?** `ACTIVE — on track`, or
   `ACTIVE — 1 payment behind`, or `DEFAULTED 2026-12-20`. The status
   enum alone does not say whether the customer is behind; that is the
   first thing asked and it is derived, not stored.
2. **What is left?** `$327.22 of $523.55`, with the next payment and its
   date.
3. **The schedule** — every instalment with its due date and whether it
   was met, derived from `start_date`, the frequency and what has been
   allocated to the covered debits. Not an `installment` table (§4).
4. **What is covered** — the debts themselves, so a CSR looking at a
   charge on the ledger can see it is in a plan and not chase it. The AR
   tab's Bill column already names what a fee was raised on; a covered
   debit wants the same treatment, reading `in a payment plan`.

**And a warning where it will be read**, not where it is logically tidy:
if the plan is at risk because a *new* bill is unpaid — the §7 test a
customer most easily trips while paying every instalment faithfully —
that belongs on this panel, in those words, rather than being inferable
from two screens.

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

**Agreeing a plan waives nothing, and this one is not a setting.** A
late fee is a debit with its own due date, so it is covered by the plan
like any other debt and paid down with the rest.

The alternative — waive the fees on agreement — makes the plan a
forgiveness mechanism, which is the thing
`delinquency_rule_replace_needs_fee` and the waiver path exist to keep
explicit. Forgiving a charge should have somebody's name and a reason on
it. A utility that routinely waives fees when agreeing a plan is taking
two actions, and the UI can offer them together; what it must not do is
hide one inside the other.

**That is a different question from whether *new* fees accrue while the
plan is kept**, which is `suppressFeesWhileKept` and defaults to
suppressing them (§4a). Charging a late fee on a debt the utility has
agreed to wait for is the thing a plan exists to stop. The two get
confused because both are "fees and plans"; one is about the past and is
a deliberate act, the other is about the future and is policy.

## 7. Breaking a plan

### Late is not broken

**An instalment passes through three states, and an earlier draft of
this section had only the first and the last.** It defaulted a plan the
moment an instalment's date passed unpaid — late by one day was broken —
which contradicted §4b's own panel, where a plan reads `ACTIVE — 1
payment behind`. That is a state the sweep as written could never
produce.

| | |
|---|---|
| **Due** | The instalment's date has arrived. Nothing has happened yet. |
| **Late** | The date has passed and `graceDays` has not. The plan is **still ACTIVE**, the panel says the customer is behind, and a notice goes out saying the plan is at risk. No suppression lifts; no fee is charged on a covered debt. |
| **Missed** | Grace has expired. It now counts against `missedInstallmentsBeforeDefault`. |

So with the defaults — grace 5, threshold 1 — a customer has five days
to put it right, is told within that window, and the plan breaks on the
sixth. A tenant wanting a second chance rather than a longer one raises
the threshold instead, and then "behind" persists past grace.

**Nobody is defaulted silently.** The late notice is the point of the
state existing: a plan agreed in good faith and broken without warning
is the thing a complaint is made of, and the ladder already has the
machinery — a `notification_event_type` per rung — so this is one more
event, not a new mechanism.

**A part payment is not a payment**, by default. $30 against a $65.44
instalment leaves it missed, because a plan is an agreement to pay an
amount on a date. `partialInstallmentCounts` lets a tenant credit it pro
rata instead, which is the lenient reading and is some utilities'
practice.

### The sweep

State-keyed, like the delinquency sweeps — and it **runs as the first
pass of the delinquency worker's tenant job**, not as a cron of its own.

The ladder reads plan state to decide what to suppress, so the plan
state has to be settled before it decides anything: a plan that defaults
on a tick must be chaseable on that tick, and one that completes must
stop suppressing before a fee is charged. A separate schedule would
leave the two racing over the same account with the order depending on
when each happened to fire — a defect that surfaces once a month at
03:00. The worker already sequences its passes for this kind of reason,
and `sweepReconnections` carries the comment explaining its own
position.

**The delinquency sweep itself never looks at payments**, of this kind
or any other. It reads `balance > 0`, `open_amount > 0` and
`due_date < now`; a payment reaches it only through its effect on an
open amount. What it newly reads is plan *membership* — is this debit
covered — and nothing about instalments. Instalments are this sweep's
business alone, and it measures them by what has been allocated to the
covered debits, which is why §4aa's allocation change and this have to
agree.

For each ACTIVE plan it asks **two** questions, and either can break the
plan:

1. **Are the instalments missed?** Count those whose date plus
   `graceDays` has passed, against what has been allocated to the
   covered debits since `start_date`. A shortfall of
   `missedInstallmentsBeforeDefault` or more defaults the plan.
   Instalments that are merely **late** — past their date, inside grace
   — are counted separately and reported, not acted on.
2. **Is a bill outside the plan unpaid past its due date?** When
   `currentBillCountsTowardDefault`, an open uncovered debit past due
   defaults the plan too.

The same pass raises the **late notice** for any instalment that became
late since it last ran, which is what keeps the second state from being
decorative.

**The second question is the one the first draft was missing**, and its
absence was a hole rather than a simplification: a customer could pay
every installment, never pay a new bill, and keep the plan alive — and
with it the suppression — while the arrears shrank and the new debt
grew, untouched by the ladder because the account clock reads "the
oldest open debit not covered by an active plan" and the plan kept
covering the old ones. Illinois' test is the installment **and** the
current bill, which is the same insight written as a rule.

It is a setting rather than a certainty because a tenant whose
ordinance looks only at the installment must be able to say so.

On DEFAULTED the plan stops covering its debits, so they re-enter both
clocks immediately with their real ages — which may be far past the last
tier.

**`assessSuppressedFeesOnDefault`, default false.** The first draft
asserted this as a design decision; it is a policy with a default,
because the "deferred, then assessed on termination" pattern is in
production use — one municipal agreement says in terms that late fees
are not accumulated while the plan is met and *are* assessed if it
terminates.

False is the default for a reason that is ours rather than the
industry's: charging them on default means re-running tiers those bills
already passed, and "a tier charges each bill once" is what makes the
per-bill ladder simple and what stopped two real defects on 2026-10-25.
A tenant that sets it true is choosing to reopen that, and the
implementation owes it an explicit path — the suppressed fees recorded
as deferred when they were skipped, then raised on default — rather than
replaying the ladder over history.

If breaking an agreement should simply cost something, the cleaner
answer is still a nameable plan-default fee with its own reason and its
own rule, so the policy is visible rather than emergent.

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
debits, both suppression points, manual CANCELLED/COMPLETED, the API, a
staff screen, **and the `paymentPlans` settings namespace with its
Configuration screen** (§4a — a setting nobody can edit is an orphan,
and the terms are the tenant's, so the policy ships with the feature
rather than after it). The shut-off queue's existing `PAYMENT_PLAN`
button becomes "agree a plan" and opens that screen instead of writing a
word on an action row. This is the slice that makes the current button
honest, and it is worth shipping alone.

**Slice 2 — keeping track.** The default and completion sweep, the
derived schedule shown to staff, and the portal view of a customer's own
plan.

**Slice 3 — SaaSLogic.** A plan's installments as a vendor payment
schedule, once spec 21's vendor questions are answered.

## 11. Left to the builder

- ~~Where the staff screen lives~~ — decided in §4a and §4b, and the two
  answers are different because the two screens answer different
  questions. The **terms** are collections policy and sit under
  Collections beside the delinquency rules; a **plan** is one account's
  arrears and sits on that account, where a CSR already is when the
  customer phones. What was left open was really one question treated as
  two.
- Whether `down_payment` is a separate recorded payment or simply the
  first installment. Spec 10 implies separate (PENDING → ACTIVE on it).
- The exact wording on the bill, if anything. A covered debt is not
  chased but is still owed, and the bill already prints what is owed.
  Saying "on a payment plan" next to it is a presentation question for
  whoever writes the slice.
