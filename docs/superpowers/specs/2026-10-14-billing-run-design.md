# Billing Run — Design

**Status:** design, nothing built.
**Prompted by:** Rao, 2026-10-14 — "i don't think bills will be manully created through a button click."

---

## 1. The problem

A bill can only come into being one way today: a staff member opens an
account, clicks **Generate Bill** in its Bills tab, and picks a date.
`bills-tab.tsx:64` is the only caller of `POST /api/v1/accounts/:id/bills`,
which is the only route that creates a `Bill`. Verified by grep, not
assumed.

That is a test harness wearing a workflow's clothes. A utility with
12,000 accounts on a monthly cycle does not click 12,000 times, and the
button teaches the wrong mental model to anyone whose only experience of
billing is this screen.

What the requirements actually ask for:

- **Cycle billing.** `BillingCycle` already carries `billDayOfMonth` and
  `frequency`, and the billing-cycles page says in prose that "the
  billing run processes them as a batch". There is no run behind that
  sentence.
- **Req 134**, Phase 3: "final bill generation at account closure
  **independent of billing cycle**" — the one legitimately per-account
  case, triggered by closure rather than by browsing to a tab.

So there are two ways a bill should be born, and the button is neither.

### 1.1 What already exists, and is not being rebuilt

Both halves of the work are built and tested; the run orchestrates them.

- `createBillSegmentForServiceAgreement(utilityId, actor…, saId, {periodStart, periodEnd})`
  rates **one service agreement for one period**: loads rate-schedule
  assignments, refuses when none overlap (`NO_ACTIVE_ASSIGNMENTS`) or any
  assigned schedule is unpublished (`SCHEDULE_NOT_PUBLISHED`), runs the
  engine, writes `BillSegmentLine` rows, and marks that period's unbilled
  `MeterRead` rows `billedAt`.
- `generateBillForAccount(…, accountId, { asOfDate })` derives the cycle
  period, refuses a bill overlapping an existing one
  (`BILL_ALREADY_EXISTS_FOR_PERIOD`), aggregates the account's unbilled
  segments in that period, and writes an **unposted** `Bill`.
- `POST /api/v1/bills/:id/post` raises the `BILL_CHARGE` receivable.
- `ImportBatch` / `ImportRow` plus `src/workers/import-worker.ts` are a
  working precedent for a long batch with per-item outcomes: one job per
  batch, per-row status, `cancelRequested`, `lastProgressAt`,
  `attempts: 1` with errors-only retry, and a `reclaimZombieBatches`
  sweep on boot.

---

## 2. Goals and non-goals

### 2.1 Goals

- Bill every eligible account on a cycle for a period, in one initiated
  operation.
- Produce a **reviewable** result: what billed, what did not, and why,
  per account, without reading logs.
- Survive a crash mid-run, and resume without re-billing what already
  billed.
- Be refusable twice: the same cycle and period cannot be run twice into
  two sets of bills.
- Separate calculating from owing. A run produces bills; posting them is
  a second, deliberate act over the run.

### 2.2 Non-goals (deferred, each named with its blocker)

- **Unattended scheduling.** `billDayOfMonth` makes a cron trivial and
  the queue registry already supports repeatable jobs, but an unattended
  run that posts receivables with nobody looking is a money event with no
  reviewer. Scheduling arrives after someone has watched a few runs and
  the exception list is boring. Nothing here prevents it: the run is a
  row and a job, which is what a scheduler would create anyway.
- **Final bill at closure (Req 134).** A different trigger (account
  closure), a different period (part of one), and a different eligibility
  rule. It reuses the same two services, not the run.
- **Print/mail vendor export and delivery (Req 131/132).** `BillDocument`
  carries no delivery columns; unchanged by this.
- **Rate validation against adopted rates (Req 140).** The run will
  surface `SCHEDULE_NOT_PUBLISHED` as an exception because the segment
  service already refuses it. A validation pass over billed charges is
  its own feature.
- **Proration of tier thresholds for partial periods (Req 138).** Lives
  in the rate engine, below this.
- **Re-rating an account whose segments already exist.** The run skips
  accounts already billed for the period rather than recalculating them;
  correction is rebill's job, which is still blocked (see the gap doc).

---

## 3. Decisions and rationale

Each of these is a decision I can be argued out of; the objection that
killed the alternative is recorded so the argument does not have to be
had twice.

### 3.1 A `BillingRun` row, not a fire-and-forget endpoint

**The simpler alternative:** `POST /api/v1/billing-cycles/:id/bill` loops
accounts synchronously and returns a summary. No new tables.

**Why it fails today, not later:** 12,000 accounts, each rating N service
agreements through the engine, is minutes of work. An HTTP request that
long dies to a proxy timeout with the work half done and no record of how
far it got — and the operator's only recourse is to run it again, which
the per-account overlap guard turns into 12,000 409s rather than a
resume. The thing that makes a run usable is precisely the record of what
happened to each account.

**Cost paid:** two tables and a worker. Both already have a shape to copy
(`ImportBatch`/`ImportRow`), so the cost is mostly data model, not
machinery.

### 3.2 One job per run, per-account transactions — not one transaction

A single transaction over the whole run holds locks for minutes and makes
one account's bad rate assignment roll back 11,999 good bills. The import
worker settled this already: per-item isolation, per-item status. A run
is therefore *not* atomic, and that is deliberate — a partially completed
run with 40 exceptions is the normal, useful outcome.

### 3.3 The run calculates; posting is a second act over the run

**The alternative:** post each bill as it is created, so the run ends with
receivables and nothing further to do.

**Why not:** posting is when money becomes owed, and a run is exactly when
a bad rate change shows up as 12,000 wrong charges. Reversing 12,000
posted charges is a far worse afternoon than discarding 12,000 unposted
bills. §3.7 of the AR ledger design already made posting a distinct act
for the same reason.

**So:** `POST /api/v1/billing-runs/:id/post` posts every bill the run
produced, as its own operation with its own record. The review step
between them is the point. A tenant that wants one click can have
`postOnComplete` **when they ask** — not before, and it is a column, not
a redesign.

### 3.4 Eligibility is stated, not implied

An account is billed by a run when, as of the period:

- it belongs to the cycle (`Account.billingCycleId`),
- its status is one that bills — `ACTIVE`, and explicitly **not**
  `FINAL_BILLED` (Req 22's status set), and
- it has at least one service agreement whose dates overlap the period.

Everything else is an exception with a reason, never a silent skip. An
account that is simply not due is not an exception; it is not in the run.

### 3.5 Idempotency: unique on (utility, cycle, period)

`@@unique([utilityId, billingCycleId, periodEnd])` on `BillingRun`. A
second attempt at the same cycle-period is a 409 naming the existing run,
not a second set of bills. This is the run-level guard; the per-account
`BILL_ALREADY_EXISTS_FOR_PERIOD` guard stays as the row-level one, and is
what makes a resume safe.

### 3.6 Resume by status filter, not by cursor

Copied from `processBatch`: items carry status, and a resumed run
processes only `PENDING`. A `BILLED` item is skipped because it is not in
the filter, so re-enqueueing a half-finished run cannot double-bill.
Zombie reclaim on worker boot, as the import worker does it.

### 3.7 Not a shared "job run" abstraction

`BillingRun` and `ImportBatch` share a shape, not a schema. Factoring out
a generic batch-runner to serve two consumers with different fields,
different item identity and different failure vocabulary buys indirection
and costs clarity. Copy the pattern; do not abstract it. (Project
checklist, step 5: the second consumer has arrived, the third has not.)

---

## 4. Data model

```prisma
model BillingRun {
  id              String           @id @default(uuid()) @db.Uuid
  utilityId       String           @map("utility_id") @db.Uuid
  billingCycleId  String           @map("billing_cycle_id") @db.Uuid
  periodStart     DateTime         @map("period_start") @db.Date
  periodEnd       DateTime         @map("period_end") @db.Date
  billDate        DateTime         @map("bill_date") @db.Date
  dueDate         DateTime         @map("due_date") @db.Date
  status          BillingRunStatus @default(PENDING)
  accountCount    Int              @default(0) @map("account_count")
  billedCount     Int              @default(0) @map("billed_count")
  exceptionCount  Int              @default(0) @map("exception_count")
  postedAt        DateTime?        @map("posted_at") @db.Timestamptz
  postedBy        String?          @map("posted_by") @db.Uuid
  cancelRequested Boolean          @default(false) @map("cancel_requested")
  lastProgressAt  DateTime?        @map("last_progress_at") @db.Timestamptz
  createdBy       String           @map("created_by") @db.Uuid
  createdAt       DateTime         @default(now()) @map("created_at") @db.Timestamptz

  cycle BillingCycle     @relation(fields: [billingCycleId], references: [id])
  items BillingRunItem[]

  @@unique([utilityId, billingCycleId, periodEnd])
  @@index([utilityId, createdAt])
  @@map("billing_run")
}

model BillingRunItem {
  id           String               @id @default(uuid()) @db.Uuid
  utilityId    String               @map("utility_id") @db.Uuid
  billingRunId String               @map("billing_run_id") @db.Uuid
  accountId    String               @map("account_id") @db.Uuid
  status       BillingRunItemStatus @default(PENDING)
  billId       String?              @map("bill_id") @db.Uuid
  segmentCount Int                  @default(0) @map("segment_count")
  total        Decimal?             @db.Decimal(14, 4)
  errorCode    String?              @map("error_code") @db.VarChar(64)
  errorMessage String?              @map("error_message") @db.Text
  processedAt  DateTime?            @map("processed_at") @db.Timestamptz

  run BillingRun @relation(fields: [billingRunId], references: [id], onDelete: Cascade)

  @@unique([billingRunId, accountId])
  @@index([billingRunId, status])
  @@map("billing_run_item")
}

enum BillingRunStatus { PENDING RUNNING COMPLETE PARTIAL FAILED CANCELLED }
enum BillingRunItemStatus { PENDING BILLED SKIPPED FAILED }
```

Notes on the choices:

- **`billDate` and `dueDate` on the run, not derived per account.** Every
  bill in one run carries the same dates, which is what makes a run a
  thing a customer-service rep can talk about ("the October run"). Today
  `generateBillForAccount` derives them per account from the cycle; the
  run passes them in so one bad clock cannot split a run across two days.
- **`total` on the item** so the run's own page can show money without
  joining every bill. A snapshot, like `LedgerEntry.amount` — §3.2 of the
  ledger design makes the same call for the same reason.
- **`SKIPPED` vs `FAILED`.** Skipped is "nothing to bill" (no overlapping
  agreement, no unbilled segments, already billed for this period).
  Failed is "should have billed and could not" (`SCHEDULE_NOT_PUBLISHED`,
  `NO_ACTIVE_ASSIGNMENTS`, an engine error). The distinction is the whole
  value of the exception list: one is noise, the other is a work queue.
- **RLS** on both tables, matching every other entity.

---

## 5. Operation

```
POST /api/v1/billing-runs           { billingCycleId, periodEnd? }  → 201 run (PENDING)
GET  /api/v1/billing-runs           list, newest first
GET  /api/v1/billing-runs/:id       run + counts
GET  /api/v1/billing-runs/:id/items ?status=FAILED — the exception list
POST /api/v1/billing-runs/:id/post  post every bill the run produced
POST /api/v1/billing-runs/:id/cancel sets cancelRequested
```

Permissions: creating and posting a run is `accounts:EDIT` — the same
authority that creates and posts a bill today. Reading is
`accounts:VIEW`.

**Enqueue, then work.** The POST writes the run and its `PENDING` items
inside one transaction (eligibility is a query, so this is fast and
bounded), then enqueues one job on a new `billingRuns` queue. The worker:

1. Flips the run `RUNNING`, stamps `lastProgressAt`.
2. For each `PENDING` item, in its own transaction:
   - rate every overlapping service agreement via
     `createBillSegmentForServiceAgreement` (skipping agreements that
     already have a segment for the period),
   - aggregate via `generateBillForAccount`,
   - record `BILLED` + `billId` + `total`, or `SKIPPED`/`FAILED` with the
     code and message the service threw.
3. Checks `cancelRequested` between items; a cancelled run keeps what it
   billed and leaves the rest `PENDING`.
4. Ends `COMPLETE` (no failures), `PARTIAL` (some), or `FAILED` (nothing
   billed).

`attempts: 1`, as with imports: a queue-level retry would restart a run
whose early items are already billed, and the resume path is the
intentional one.

---

## 6. Invariants

1. A bill created by a run has exactly one `BillingRunItem` naming it.
2. No account has two bills covering one period — enforced per account by
   the existing overlap guard, and per run by the unique key.
3. A `BILLED` item is never reprocessed, so a resumed or re-enqueued run
   cannot double-bill.
4. `billedCount + exceptionCount ≤ accountCount`, with the remainder
   being work not yet done.
5. Posting a run posts only bills that run produced, and only unposted
   ones; a bill posted by hand in between is left alone.
6. A run never deletes or recalculates an existing bill.

---

## 7. What this does to the button

Once the run exists, per-account generation stops being the path and
becomes the exception, which is what Req 134 describes. Two honest
options then, and it is a product decision rather than a technical one:

- **Demote it** to "Final bill" on account closure — the Req 134 trigger
  — and remove the as-of-date picker, which exists only because the
  button had to stand in for a cycle.
- **Delete it**, and accept that a one-off correction needs a one-account
  run.

Not before, though: it is currently the only way anything creates a bill,
so deleting it first would leave a system that can post and print bills
it cannot produce.

---

## 8. Testing

- **Integration, one container:** a cycle with three accounts — one
  normal, one with an unpublished rate schedule, one with no overlapping
  agreement — produces 1 `BILLED`, 1 `FAILED` naming
  `SCHEDULE_NOT_PUBLISHED`, 1 `SKIPPED`, and a `PARTIAL` run.
- **Idempotency:** a second run for the same cycle-period is a 409 naming
  the first.
- **Resume:** mark half the items `BILLED`, re-enqueue, assert no second
  bill for those accounts and that the rest complete.
- **Cancel:** `cancelRequested` mid-run leaves billed items billed and
  the remainder `PENDING`, with the run `CANCELLED`.
- **Posting:** the run's bills gain `BILL_CHARGE` entries; a bill posted
  by hand beforehand is not posted twice and does not fail the operation.
- **Tenant isolation:** another utility's accounts are never in a run,
  and its runs are invisible.

---

## 9. Risks

- **The engine's cost per agreement is unmeasured at this scale.** Every
  claim about duration here is judgement, not measurement: the largest
  thing anyone has rated in this codebase is a handful of agreements in a
  test. The first real run should be a single cycle with timing recorded,
  before anyone promises a nightly window.
- **`MeterRead.billedAt` is written by segment creation**, so a failed
  aggregation after successful rating leaves reads marked billed against
  segments that exist but have no bill. That is already true of the
  button; a run makes it true 12,000 times. The per-item transaction
  boundary needs to cover rating *and* aggregation, which is why step 2
  above is one transaction per account rather than one per agreement.
- **Review is only as good as the exception list.** If `SKIPPED` swamps
  `FAILED`, operators will stop reading it. That is why the two statuses
  are distinct from the start rather than one `errorCount`.
