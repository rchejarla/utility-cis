# The bill as a statement — Design

**Status: design. Nothing is built.** Amends `docs/specs/09-billing.md` §16
(the fees-and-adjustments group, shipped 2026-10-25/26) and takes over the
statement view that `docs/specs/23-accounts-receivable.md` §7.1 defers to
slice 4b.

---

## Two decisions I need from you

I have taken a position on each so the rest is concrete. Overturn either
while reading; both are marked where they appear.

1. **"Past due" means any debt whose own due date had passed as of the
   bill date** — not just the balance carried from prior bills. (§5)
2. **No "amount due after the due date" line.** Several utilities print
   one; ours would have to predict the ladder's next fee, and a predicted
   figure that is wrong is worse than one that is absent. (§8)

---

## 1. What is wrong today

A real account in the dev database, `0001000-00`, bill `BILL-202610-1`:

- the **AR tab** shows the bill's receivable as **$41.54**
- the **bill** asks for **$489.34**
- the **account** owes **$554.71**

Three numbers, and only two of them answer a question anyone asks. The
$489.34 is this bill's rated charges plus every non-bill ledger entry
whose effective date falls inside `(previous bill date, this bill date]`
— the two late fees and a $412.80 opening balance. It is not the
period's charges and it is not the balance; it is "charges plus whichever
arrears landed in a date window", which has no name.

Three defects, narrower than they first appeared:

1. **The total omits the balance carried forward.** Entries carrying a
   `bill_id` are excluded from the fees window — correctly, since a
   bill's own charge *is* that bill — but nothing puts the unpaid
   remainder of the previous bill back. $489.34 is short by exactly the
   August charge still open. The standard rule is current charges **plus**
   past due; we under-ask.
2. **There is no previous-balance line.** The $412.80 opening balance
   prints under *Fees and adjustments* as though the utility had just
   charged it.
3. **No past-due callout.** The customer cannot tell which part of the
   total was already late — on a bill whose arrears the delinquency
   ladder is simultaneously charging late fees for.

**Why this is now rather than earlier.** Until the fees group shipped, a
bill printed only what the rate engine rated and `bill.total` was the
whole truth. The moment a bill prints arrears it has to account for all
of them, and it does not.

## 2. What the industry does, and what we got wrong

Checked rather than assumed, because the first version of this design
invented something no customer has seen.

**One due date per bill is the standard**, with the past-due portion as a
*line* rather than a dated item. Broward County states the rule plainly:
the "Pay This Amount" line is current charges plus any past due charges.
Cotati's amount-due box carries the total, the due date, and the amount
due after it. Tulsa's sample shows a "Balance Forward" line for unpaid
amounts carried over, together with penalties and late fees. Fort
Lauderdale defines past due as anything unpaid when the billing cycle
closed.

**No bill prints a due date per line.** An earlier draft of this document
proposed exactly that, on the reasoning that an open-item ledger has one
due date per debit and no single-date bill can be true over a mixed set.
The reasoning is correct and the conclusion was wrong: the standard
layout is not dishonest, because the past-due line tells the customer
which part was already late. Nobody reads "balance forward" as newly due.
Oracle CC&B sets one due date at bill completion and its late-payment
process has a step that deliberately overrides it.

**Aging buckets (current/30/60/90) are an internal report, not bill
content.** The utility-billing material puts them in an aging report for
staff. They belong on the AR tab or a collections screen — which is
where spec 23 already parks them — and not on the paper.

Sources: [Broward](https://www.broward.org/WaterServices/CustomerService/Documents/How%20to%20read%20your%20utility%20bill.pdf),
[Fort Lauderdale](https://fortlauderdale.gov/government/departments-a-h/finance/utility-billing/how-to-read-your-bill),
[Tulsa](https://www.cityoftulsa.org/media/21276/cot-utility-bill-front-explanation-23.pdf),
[Cotati](https://cotaticity.gov/1589/Understanding-Your-Utility-Bill),
[Nederland CO](https://www.nederlandco.gov/utility-billing/page/tips-reading-your-utility-bill),
[Caselle aging report](https://support.caselle.com/portal/en/kb/articles/usefulness-of-the-aging-report-utility-billing),
[CC&B URM 4.2.2.12](https://docs.oracle.com/cd/E28945_01/4.2%20Manage%20Device%20Measurements%20and%20Bill%20Customers/CC&B%20URM%204.2.2.12.pdf).

## 3. Goals, non-goals, anti-goals

**Goals**
- The bill asks for what the account owes, and the figure reconciles
  against the ledger.
- A customer can see which part was already late, and a CSR reading the
  AR tab can explain the bill's total without arithmetic.
- The bill stops implying a new due date for debts that already had one.

**Non-goals**
- Aging buckets on the bill (§2 — internal report).
- A due date per line (§2 — nobody does this).
- Changing what the rate engine computes. `bill.total` keeps meaning
  exactly what it means now.

**Anti-goals**
- **It must not become a second place that decides what is owed.** The
  ledger is the system of record; the bill reports it.
- **A reprint must not change.** Byte-stable regeneration is the property
  `sha256` exists to protect, and §6 is the part of this design that
  exists to keep it.

## 4. The layout

```
Previous balance                                 110.75
Payments received                                  0.00
Balance forward                                  110.75
Other charges and adjustments                    447.80
   Opening balance                      412.80
   Late payment fee — for bill B-202608   10.00
   Late payment fee — for bill B-202608   25.00
Current charges                                   41.54
                                               --------
Pay this amount by 2026-11-09                    600.09
   of which past due — payable now              523.55
```

One due date. One amount to pay. *Other charges and adjustments* is the
existing fees group, unchanged — it already names the bill each fee was
raised on. *Current charges* is the existing rated group total.

## 5. What "past due" means

**Decision 1: any debt whose own due date had passed as of the bill
date.** On the example that is the August charge (due 2026-09-14) plus
the opening balance (due 2026-09-26) — $523.55. The two late fees, due
2026-10-24 and 2026-11-03, are not yet due and sit inside the total
without being called out.

The rejected alternative was "balance forward only" — anything carried
from a prior bill, $110.75 here. It is simpler and it hides the case
that matters: a $412.80 debt raised mid-period, already overdue on the
bill date, and the largest thing on the page. Fort Lauderdale's
definition — unpaid when the cycle closed — is the one chosen.

## 6. The hard part: these figures are historical

`ledger_entry.open_amount` is **now**, not as-of. The August charge reads
$55.37 today because payments landed on 2026-10-19 and 2026-10-23; on the
bill date it was $110.75. So *previous balance*, *payments received* and
*past due* cannot be read off the current ledger.

They can be reconstructed — the settlement block already does this shape
for one debit, filtering applications by the credit's effective date —
but reconstruction has a flaw that matters more here:

**`reverseEntry` deletes the `ledger_application` rows it undoes.** Once
a payment is reversed, there is no record that the allocation ever
existed, so a reconstruction of a past balance cannot see it. A reprint
of an old bill would then differ from the document the customer
received. That exposure exists today in the settlement block; a statement
layout widens it from one bill's payment list to the whole previous
balance.

**So the figures are snapshotted on the bill when it posts**, not
recomputed at render:

| Column on `bill` | Meaning |
|---|---|
| `previous_balance` | owed as of the previous bill's date |
| `payments_since` | credits applied between the two bill dates |
| `past_due_amount` | of the total, what was already due on the bill date |

Posting is the moment the bill becomes money owed and is already a
transaction that locks the account and recomputes the cache, so it is the
natural place to freeze them. Three consequences, all wanted:

- a reprint is byte-identical regardless of what happened afterwards;
- the render path keeps no historical query at all;
- a bill issued before this change has NULLs, and the presentation omits
  the statement lines rather than inventing them — old bills keep
  printing as they do today.

The rejected alternative — recompute at render from the ledger — needs
no migration and fails the one property the document has to have.

## 7. What changes

- **Migration:** three nullable `DECIMAL(14,2)` columns on `bill`.
  Nullable is the whole mechanism for old bills, so no backfill.
- **`postBill`:** computes and writes the three figures inside the
  existing transaction, from entries effective on or before the bill
  date.
- **`BillPresentation`:** a `statement` block carrying the three figures
  plus `balanceForward`, or null when the bill has no snapshot.
  `totals.total` becomes the amount to pay; `totals.fees` and the fees
  group stay as they are.
- **`default-bill.tsx`:** the rows in §4, above the existing groups.
- **The staff bill popup:** reads the same presentation it already reads
  since 2026-10-26, so it follows for free — which is the point of
  having made it read the presentation.
- **Specs:** 09 §16 and the endpoint table; 23 §7.1 (the statement view
  is no longer deferred).

## 8. Left out, deliberately

**Decision 2: no "amount due after the due date" line.** Cotati and
others print one. Ours would have to predict the next late fee, which
means reading the tenant's delinquency tiers and guessing which will
fire — a figure that is wrong is worse than one that is absent. If a
tenant wants it, it is a tier calculation and belongs with the ladder,
not here.

**Previous balance stays one line**, not itemised. My call: itemising it
turns a bill into a two-period statement, and a customer who wants the
detail has the portal.

## 9. Constraints inherited

- Money is `Decimal`, never a JS number; every printed amount is a 2dp
  string resolved once in the presentation.
- Every figure on the document is bounded at `bill.billDate` — the rule
  the settlement block and the fees window already follow.
- Rounded line amounts sum to the printed subtotal, because the customer
  can add them up.
- No business logic keys on a reason code.

## 10. Slices

**Slice 1 — the snapshot and the total.** The migration, `postBill`
writing the three figures, `statement` on the presentation, the template
rows, and the total becoming current + past due. This is the slice that
makes the bill's total true, and it is worth shipping alone.

**Slice 2 — the past-due callout and wording.** The "payable now" line,
and whatever the tenant wants to say beside it.

**Slice 3 — the aging summary on the AR tab**, which is where the
buckets belong (spec 23 §7.2, still outstanding).
