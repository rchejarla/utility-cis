# Billing

**Module:** 09 — Billing
**Status:** Partially shipped — `BillSegment`, `BillSegmentLine` and `Bill` are live (Rate Model v2 slices 5a–5b.2), AR posting is live (module 23 slice 1), bill generation to a stored PDF is live (bill production slice 1), and the batch billing run is live **as API and worker with no UI** (slice 5c). Bill delivery is outstanding.
**Entities:** BillSegment (shipped), BillSegmentLine (shipped), Bill (shipped), BillDocument (shipped), BillMessage (shipped), BillingRun (shipped), BillingRunItem (shipped)

## Overview

The Billing module is the core revenue engine of the CIS. It executes billing cycles — gathering validated meter reads, applying rate schedules, calculating charges, and producing the customer-facing bill.

**Key architectural principle (revised 2026-10-09):** CIS calculates what is owed and why, and owns the bill and the receivable. SaaSLogic is a payment rail only — it is told an amount and reports whether it was collected. See module 21.

This supersedes the earlier boundary, under which SaaSLogic owned the invoice, the payment ledger and the financial records, and CIS handed it a machine-readable charge breakdown. Rate Model v2 built native rating in CIS, so that division no longer reflects the system.

Primary users: billing administrators, finance staff, utility managers.

## Entities

### BillSegment / BillSegmentLine / Bill (shipped)

What actually shipped replaces the `BillingRecord` design below. The charge calculation per agreement is a **`BillSegment`** with one **`BillSegmentLine`** per fired rate component; an account-level **`Bill`** aggregates the segments for a period into the customer-facing document. See `docs/specs/07b-rate-model-v2-design.md` for the rating model and `docs/superpowers/specs/2026-05-08-rate-model-v2-slice-5b.md` for the aggregation design.

**A service period is read to read (2026-10-15).** A segment's period is
resolved from the meter reads, not from the cycle's calendar: it ends on
the **newest unbilled read** on or before the scheduling bound — that
read *is* the end of the interval — and starts the **day after the last
read already billed**, so consecutive periods abut with no gap and no
overlap. With nothing billed yet it starts at the service agreement's own
start date. `resolveServicePeriod` in `bill-segment.service.ts` is the
only place this is decided, and `POST /service-agreements/:id/bill-segments`
with an empty body is the ordinary way to use it;
`GET /service-agreements/:id/next-service-period` previews it so the UI
can show the interval instead of asking someone to type one. Explicit
dates are still accepted, for corrections, and passing only one of them
is refused rather than half-resolved.

**A `Bill`'s period is the span of its segments**, for the same reason.
The cycle window selects which segments to bill; what the bill is *for*
is the interval they cover.

Why this replaced deriving the period from `billDayOfMonth`: with manual
reading, two accounts on one cycle are never read on the same day, so a
nominal 1/1–1/31 period described neither of them — and a reader one day
late left one window with **no** read, producing a zero-usage bill, and
the next window with **two**, billing both intervals at once and pushing
the customer into a tier they never entered. The usage was never lost
(`billed_at` only marks reads inside the period) but it was misdated,
which is worse in a dispute. Two refusals exist rather than a guess:
`NO_READ_IN_WINDOW` (400) when there is nothing to bill — estimation is
the answer to that and is not built — and `READ_PREDATES_BILLED_PERIOD`
(409) for a backdated read, which needs a rebill rather than a new
segment.

`computeBillPeriod` remains the **scheduling** window — which accounts are
due and which reads to expect — and that is what a billing run's
`window_start` / `window_end` now are.

Tier-threshold proration for intervals that are not ~30 days (Req 138)
shipped on 2026-10-15, but it is **opt-in**: a `tiered` pricing scales its
thresholds only if it declares `standard_days`, and no tariff in the data
declares one yet. So today a 44-day interval is still priced against a full
period's allowance until the schedule says what a standard period is. See
`docs/specs/07b-rate-model-v2-design.md`.

Differences worth noting against the superseded design:

- Line items are **rows** (`BillSegmentLine`), not a `charge_breakdown` JSONB blob, so a line can be traced to the exact `RateSchedule` version and `RateComponent` that produced it.
- Amounts are `DECIMAL(14,4)`, not `DECIMAL(10,2)` — rating needs sub-cent precision before rounding.
- There is no `saaslogic_invoice_id` on the charge record. CIS owns the bill; see module 21.
- No status enum yet. A `Bill` existing means it was issued. `DRAFT`/`VOID` arrive when generation and delivery need them.
- Proration, bill holds and final-bill handling are **not** yet implemented. The fields below describe the intended eventual shape.
- **Correction/reprint versioning is not implemented and is not pending on generation.** Reprinting a bill produces byte-identical output from the same presentation, so it creates no version. Versioning belongs with corrected issuance — a rebill or adjustment that changes what is owed — which is where `version` and `replaces_id` should be designed. See `BillDocument` below.

### BillingRecord (superseded — retained for its field-level intent)

> Superseded by `BillSegment` + `Bill`. Kept here because the proration, hold, final-bill and versioning fields have not been built yet and this remains the reference for what they should cover.

One record per service agreement per billing cycle execution.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| service_agreement_id | UUID | FK → ServiceAgreement |
| billing_cycle_id | UUID | FK → BillingCycle |
| billing_period_start | DATE | Start of billed period |
| billing_period_end | DATE | End of billed period |
| read_id_start | UUID | FK → MeterRead (opening read) |
| read_id_end | UUID | FK → MeterRead (closing read) |
| consumption | DECIMAL(12,4) | Billed consumption units |
| rate_schedule_id | UUID | FK → RateSchedule (version used) |
| charge_breakdown | JSONB | Itemized line items (see structure below) |
| total_amount | DECIMAL(10,2) | Sum of all charges |
| is_prorated | BOOLEAN | True if partial billing period |
| prorate_days | INTEGER | Nullable: actual days in period |
| prorate_full_days | INTEGER | Nullable: full cycle days for proration |
| status | ENUM | PENDING, SUBMITTED, ACCEPTED, REJECTED, HELD, REPRINTED |
| hold_reason | VARCHAR(500) | Nullable: why bill is on hold |
| saaslogic_invoice_id | UUID | Nullable: populated after SaaSLogic accepts |
| is_final_bill | BOOLEAN | True if associated with account closure |
| version | INTEGER | Default 1; increments on reprint/correction |
| replaces_id | UUID | Nullable self-reference: for reprints/corrections |
| created_at | TIMESTAMPTZ | |
| submitted_at | TIMESTAMPTZ | When sent to SaaSLogic |
| updated_at | TIMESTAMPTZ | |

**charge_breakdown JSONB structure:**
```json
{
  "lines": [
    { "type": "BASE_CHARGE",    "description": "Monthly base charge",        "amount": 8.50 },
    { "type": "CONSUMPTION",    "description": "2,450 gal @ $0.0033/gal",    "amount": 8.09 },
    { "type": "TIER_2",         "description": "450 gal @ $0.0047/gal",      "amount": 2.12 },
    { "type": "SURCHARGE",      "description": "State regulatory surcharge",  "amount": 0.75 },
    { "type": "TAX",            "description": "City franchise fee (2%)",     "amount": 0.39 },
    { "type": "WQA_CREDIT",     "description": "Winter usage adjustment",     "amount": -1.20 }
  ],
  "subtotal": 18.65,
  "taxes": 0.39,
  "total": 19.04
}
```

**Indexes:** `[utility_id, billing_cycle_id, status]`, `[utility_id, service_agreement_id, billing_period_end DESC]`

---

### BillDocument (shipped — bill production slice 1)

The generated artifact for one `Bill`. Holds a **pointer, never bytes and never a URL**: the object lives in the tenant's own store (S3, Azure Blob or GCS), reached through apptor-connect's files plane, which also holds the credential. A capability link is minted per access and discarded, so bytes always stream through our API and authorization stays with our RBAC.

One row per bill per document type, keyed by `UNIQUE (bill_id, document_type)`. Generating again replaces it in place.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS) |
| bill_id | UUID | FK → Bill, `ON DELETE RESTRICT` |
| document_type | VARCHAR(20) | `PDF` today. Not an enum: `PRINT_EXPORT` and `EMAIL_HTML` are undesigned, and Postgres cannot remove an enum value once added |
| storage_integration | VARCHAR(100) | apptor-connect integration name, from `TenantConfig.settings.billDocuments` |
| storage_connection | VARCHAR(100) | Nullable named connection |
| object_key | VARCHAR(500) | Exactly `bills/{utility_id}/{bill_id}.pdf` — derived, never supplied |
| byte_size | INTEGER | Nullable until the upload completes |
| sha256 | CHAR(64) | Nullable until the upload completes |
| template_key | VARCHAR(100) | `default-bill-v1` |
| generated_at | TIMESTAMPTZ | Moves on a forced Regenerate |
| is_paperless | BOOLEAN | Copy of `Account.paperless_billing` at generation time |

**Why `byte_size` and `sha256` are nullable.** The row is *claimed* before the upload runs, so the unique constraint decides which of two concurrent generations proceeds and the loser never uploads. A row with no size and no hash means "claimed, not yet stored"; a claim whose upload fails is deleted.

**Deliberately absent:** no `version`, no `replaces_id`, no `storage_url`, and no delivery columns. Reprinting creates no version — a Regenerate produces byte-identical output from the same presentation, so there is no second version whose content differs, and nothing yet *delivers* a bill, so there is no sent copy to preserve. Versioning belongs with corrected issuance (rebill/adjustment), not with reprinting; delivery columns belong with the delivery feature that will write them.

**Auditing.** The claim is not audited — a claim is not a document. One audit row is written when the bytes land: `bill_document.created` on a first store, `bill_document.revised` on a forced Regenerate, carrying the replaced hash in its before-state. A failed upload leaves no audit trail.

---

### BillMessage (shipped — bill production slice 1, Bozeman #137)

Configurable text printed on bills, targeted by account type and/or commodity over a date window.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS) |
| label | VARCHAR(255) | Operator-facing name, also the tiebreak in display order |
| body | TEXT | The text printed on the bill |
| account_type_def_id | UUID | Nullable FK → AccountTypeDef; null = all |
| commodity_id | UUID | Nullable FK → Commodity; null = all |
| priority | INTEGER | Default 100; ascending, then `label` ascending |
| active_from | DATE | Window start |
| active_to | DATE | Nullable; null = indefinite |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Targeting** is a null-means-all match on each side independently, so an untargeted message prints alongside ones targeted at this bill.

**Selection happens at `bill.bill_date`, never at `now()`**, so reprinting an old bill reproduces the messages it originally carried.

Two departures from the superseded sketch above: account type is an FK to `AccountTypeDef` rather than an enum, because account types are tenant-configurable; and there is no `is_active` flag, because `active_from`/`active_to` already say when a message applies and a second switch would let the two disagree.

### BillingRun / BillingRunItem (shipped — slice 5c)

One initiated pass over a cycle, account by account. Design:
`docs/superpowers/specs/2026-10-14-billing-run-design.md`; service
`billing-run.service.ts`, worker `billing-run-worker.ts`, migration
`20261015110000_billing_run`.

**A run is a row, not a long request.** Twelve thousand accounts each
rating several agreements is minutes of work, and an HTTP request that long
dies to a proxy with the work half done and no record of how far it got —
after which re-running it turns the per-account overlap guard into twelve
thousand 409s rather than a resume. `billing_run` and `billing_run_item`
are shaped after `import_batch` / `import_row` and **copied rather than
abstracted**: the two share a shape, not a reason, and an "async batch job"
base class would make a change to imports a change to billing.

#### BillingRun

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS) |
| billing_cycle_id | UUID | FK → BillingCycle, `onDelete: Restrict` |
| window_start / window_end | DATE | The **scheduling** window from `computeBillPeriod`, not the service period |
| bill_date / due_date | DATE | The utility's own dates, identical across the run, so a CSR can talk about "the October run" |
| status | BillingRunStatus | PENDING · RUNNING · COMPLETE · PARTIAL · FAILED · CANCELLED |
| account_count | INTEGER | Accounts selected as due |
| billed_count / exception_count | INTEGER | Maintained by `finalise` from the items |
| posted_at / posted_by | TIMESTAMPTZ / UUID | Nullable; posting is a second act over a finished run |
| cancel_requested | BOOLEAN | Checked between accounts; the run finishes the one it is on |
| last_progress_at | TIMESTAMPTZ | What makes a stalled run distinguishable from a slow one |
| created_by | UUID | Preserved across a resumed run, so the audit trail names the person and not the replica |
| created_at | TIMESTAMPTZ | |

Unique on `(utility_id, billing_cycle_id, window_end)`: a second attempt at
the same window is a 409 naming the first run, not a second set of bills.

#### BillingRunItem

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS) |
| billing_run_id | UUID | FK → BillingRun, `onDelete: Cascade` |
| account_id | UUID | FK → Account, `onDelete: Restrict` |
| status | BillingRunItemStatus | PENDING · BILLED · SKIPPED · FAILED |
| bill_id | UUID | Nullable FK → Bill, `onDelete: SetNull` |
| service_period_start / service_period_end | DATE | What the bill actually covered — per account, read to read |
| segment_count | INTEGER | |
| total | DECIMAL(14,4) | A snapshot, like `LedgerEntry.amount`: the run's page shows money without joining every bill |
| error_code | VARCHAR(64) | |
| error_message | TEXT | |
| processed_at | TIMESTAMPTZ | |

Unique on `(billing_run_id, account_id)`; indexed on
`(billing_run_id, status)`, which is the exception list's query.

**SKIPPED and FAILED are separate statuses because only one of them is
work.** Skipped is "nothing to bill" — `NO_READ_IN_WINDOW`,
`NO_SEGMENTS_TO_BILL`, `BILL_ALREADY_EXISTS_FOR_PERIOD`,
`NO_ACTIVE_ASSIGNMENTS`. Failed is "should have billed and could not".
A single `error_count` would bury the second in the first, and the
exception list is the entire value of a run.

---

## API Endpoints

Billing run, bill document and bill message endpoints are shipped. The rest are planned for Phase 3.

### Billing Runs (shipped — slice 5c)

`accounts:EDIT` to start or post a run, `accounts:VIEW` to read one — the
same authority that creates and posts a single bill, because a run is that
act repeated rather than a new kind of power.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| POST | `/api/v1/billing-runs` | `accounts:EDIT` | Start a run. **202** with the PENDING run and `queued` — the work is minutes long, so the response is the record to watch rather than the result |
| GET | `/api/v1/billing-runs` | `accounts:VIEW` | The 100 most recent runs, newest first |
| GET | `/api/v1/billing-runs/:id` | `accounts:VIEW` | One run's counts and status |
| GET | `/api/v1/billing-runs/:id/items` | `accounts:VIEW` | The item list. `?status=FAILED` is the work queue; `limit` (≤500) / `offset` |
| POST | `/api/v1/billing-runs/:id/post` | `accounts:EDIT` | Post every bill the run produced. **201** with `{ posted, alreadyPosted, failed }` |
| POST | `/api/v1/billing-runs/:id/cancel` | `accounts:EDIT` | Ask a run to stop; it finishes the account it is on |

The body is `{ billingCycleId }` and, optionally, `windowEnd`, `billDate`,
`dueDate`. **`windowEnd` is the scheduling bound, not the service period** —
naming it so is the point, since the first draft of this design conflated
the two. It defaults to the cycle's own window for today; `billDate`
defaults to the window end and `dueDate` to 30 days after it, so the
ordinary call is a cycle id and nothing else.

| Condition | Status |
|-----------|--------|
| `CYCLE_NOT_FOUND`, `RUN_NOT_FOUND` | 404 |
| `INVALID_DATES` — due date before bill date | 400 |
| `CYCLE_INACTIVE` — an inactive cycle has nothing due | 409 |
| `RUN_ALREADY_EXISTS_FOR_WINDOW` — body names the existing run; resume or cancel it | 409 |
| `RUN_NOT_FINISHED` — posting a run that is still PENDING or RUNNING | 409 |

A failed enqueue is logged and swallowed by `enqueueSafely`: the run stays
PENDING and the boot sweep takes it, which is better than a 500 on a run
that exists.

### Billing Records

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/billing-records` | List records (filterable by cycle, status, account) |
| GET | `/api/v1/billing-records/:id` | Get record detail with full charge_breakdown |
| POST | `/api/v1/billing-records/:id/hold` | Place billing hold with reason |
| POST | `/api/v1/billing-records/:id/release-hold` | Release hold |
| POST | `/api/v1/billing-records/:id/reprint` | Generate corrected bill (creates new version) |

### Bill Documents (shipped)

Addressed by `Bill`, not `BillingRecord`. Bytes stream through the API; a minted apptor-connect link never reaches a client.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| POST | `/api/v1/bills/:id/document` | `accounts:EDIT` | Generate and store the PDF; idempotent — returns the existing pointer if one is stored. `?force=true` replaces it in place |
| GET | `/api/v1/bills/:id/document` | `accounts:VIEW` | Stream the stored PDF as `application/pdf` attachment |
| GET | `/portal/api/bills/:id/document` | `portal_billing:VIEW` | The customer's own copy, scoped through the account's `customer_id` |

**Producing is `EDIT`, reading is `VIEW`**, because producing writes — a row, and an object in the tenant's store — and reading does not. A Regenerate shares the write's authority rather than needing a higher one: output is byte-stable, so replacing a document cannot change what it says, and it cannot change what is owed.

This corrects two earlier choices. Generating was briefly `accounts:VIEW`, which would have let a Read-Only user drive a PDF generation and an object-store write. Regenerating was briefly its own path on `accounts:APPROVE`, inherited from when "reprint" meant issuing a corrected bill — but **no preset role grants `APPROVE` on `accounts`** (only `service_suspensions` uses that permission), so the gate made the endpoint unreachable by every seeded role including System Admin, and the CSR on a call is exactly who needs to reprint a bill. With the authority the same for both, the separate path lost its reason to exist and collapsed back into `?force=true`.

The portal route is a pure read: if no document has been generated it answers 404 rather than generating one on a customer's GET. A bill belonging to another customer answers identically to one that does not exist, so the status cannot be used to confirm which bill ids are real.

Status mapping:

| Condition | Status |
|-----------|--------|
| `ISSUER_INCOMPLETE`, `RECIPIENT_INCOMPLETE`, `NO_CHARGES`, `STORAGE_NOT_CONFIGURED` | 422, body names the `missing` fields |
| `DOCUMENT_TOO_LARGE` — the rendered PDF exceeds `BILL_DOCUMENT_MAX_BYTES` | 422, message names both sizes |
| `NOT_POSTED` — a bill becomes a document once it is posted | 409 |
| `NOT_GENERATED` — no document, or no such bill | 404 |
| apptor-connect rejected the request | 502, body names the integration and never a link |

`DOCUMENT_TOO_LARGE` is checked before the upload rather than left to the
store. The files plane does enforce the `maxBytes` a link was minted with
— verified live, it answers 413 and the oversize body does not land — but
every `ApptorConnectError` maps to 502 `STORAGE_UNAVAILABLE`, which would
name a store that is working perfectly when the cause is this
deployment's own ceiling against this bill's own size.

### Bill Messages (shipped)

Gated on `settings`, not `accounts`: the text printed on bills is tenant configuration, and editing it should not require the authority to read every account.

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| GET | `/api/v1/bill-messages` | `settings:VIEW` | List bill messages |
| POST | `/api/v1/bill-messages` | `settings:EDIT` | Create bill message |
| PATCH | `/api/v1/bill-messages/:id` | `settings:EDIT` | Update message |
| DELETE | `/api/v1/bill-messages/:id` | `settings:DELETE` | Delete message |

## Business Rules

1. **Billing cycle execution prerequisites:** Before a billing cycle run begins, the system validates: (a) all meters in the cycle have a read for the billing period, (b) no reads in the period are in exception-pending state, (c) no active billing hold on the service agreement. Failures are reported per service agreement; the run continues for qualifying agreements.

    **What shipped does this per account instead of up front** (rule 14). Eligibility is one query — cycle, billable status, an agreement overlapping the window — and everything else is discovered while billing that account and recorded against its item with a reason. A pre-flight pass would have to resolve a service period per agreement to know whether a read exists, which is the expensive half of billing; doing it twice to report it earlier buys an operator nothing a SKIPPED item does not already tell them. (b) and (c) are genuinely not checked: exception-pending reads are not excluded, and bill holds do not exist (Req 136).

2. **Rate engine application:** For each service agreement in the cycle, the system identifies the active RateSchedule as of the billing period end date, applies the `rate_config` to consumption, and produces a `charge_breakdown`. Rate type logic:
   - **FLAT:** `base_charge + (consumption × per_unit_rate)`
   - **TIERED:** `base_charge + sum of (units_in_tier × tier_rate)` per tier consumed
   - **TOU:** consumption split by time-of-use period, each rated at period rate
   - **DEMAND:** `base_charge + (consumption × energy_rate) + (peak_demand × demand_charge_per_kw)`, with ratchet applied if applicable
   - **BUDGET:** monthly budget amount; true-up in reconciliation month

3. **Minimum bill enforcement:** If total charges fall below `rate_config.minimum_bill`, the total is raised to the minimum with a MINIMUM_BILL line item.

4. **Proration:** Service agreements that started or ended mid-cycle receive prorated charges. Proration factor = `actual_days / full_cycle_days`. Applied to consumption-based charges; base charge may or may not be prorated based on tenant configuration.

5. **WQA (Wastewater Quality Adjustment):** Wastewater charges are calculated as a configurable percentage of the linked water service agreement's consumption for the period. Winter averaging uses the average of the 3 lowest monthly winter reads to set a WQA cap, protecting customers from high summer irrigation charges being applied to sewer. Irrigation meters are excluded (Bozeman Reqs 69–73).

6. **Bill holds:** A service agreement with `hold_reason` set cannot be submitted to SaaSLogic. Holds must be reviewed and released by authorized staff. Hold reasons are logged in AuditLog.

7. **Bill versioning / corrections (not built):** A *reprint* creates no version — see rule 12. What needs versioning is **corrected issuance**: a rebill or adjustment that changes what is owed, which should create a new record with `version = old.version + 1` and `replaces_id = old.id`, trigger the credit memo / adjustment process for the difference, and retain the original for audit. This arrives with slice 5d, not with generation.

8. **Collection handoff (revised 2026-10-09):** CIS issues the `Bill` and owns the receivable. The only thing sent to SaaSLogic is the amount due for an issued Bill, keyed on the Bill for idempotency, so the customer has something payable. No charge breakdown is sent for pricing — CIS has already priced it. Previously this step POSTed a per-agreement billing instruction and stored a returned `saaslogic_invoice_id`. See modules 10 and 21.

9. **Final bill:** When a service agreement is terminated (status → FINAL), a final bill is generated for the period from the last regular bill to the final read date, prorated appropriately.

10. **Charge validation:** Before submission, total_amount is validated against the adopted rate schedule. Discrepancies above a configurable tolerance threshold trigger an exception requiring supervisor approval (Bozeman Req 140).

11. **Bill messages (shipped):** At generation time, every `BillMessage` whose window contains **`bill.bill_date`** and whose targeting matches the bill's account type and commodities — or which is untargeted — is included, ordered by `priority` then `label`. Resolving at the bill's own date, not `now()`, is what makes a reprint reproduce the messages the bill originally carried.

12. **PDF generation (shipped):** Bills are generated server-side with `@react-pdf/renderer` from a declarative template, against a resolved `BillPresentation` — the template reads the presentation and nothing else, so the machinery carries no tenant conditionals. Output is **byte-stable**: PDF creation and modification timestamps are pinned, so generating the same presentation twice produces identical bytes and a concurrent generation is safe. Bytes go to the tenant's own object store through apptor-connect's files plane and stream back through our API. A bill must be **posted** to become a document, and generation refuses if the tenant's issuer identity is incomplete, the recipient has no name or address, or the bill has no charge lines — each with a 422 naming the account and the field, since "no name or no address" left an operator to guess which. Rounded line amounts are summed to produce the printed group subtotal, so what a customer can add up is what is printed. Delivery — email to paperless customers, print-vendor export for the rest (Bozeman Reqs 130–131) — is **not** built; `BillDocument` carries no delivery columns yet.

13. **Payments on the bill (shipped):** a bill that has been paid against prints a **Payments and credits received** block — each credit applied to its `BILL_CHARGE`, itemised with the effective date and labelled for a customer (`Payment (check)`, `Credit adjustment`, `Deposit applied`), then **Amount due**, and `Total due` becomes `Total billed` so what was raised and what is owed are both on the page. The remittance stub asks for the reduced figure: paying a stub that still demanded the full charge would overpay by exactly the amount already received, and a bill must not ask for a number the account does not owe. A bill with nothing applied prints as before, with `Total due` as its last word.

    **Bounded at `bill_date`, deliberately.** The block comes from `ledger_application` rows whose credit has `effective_date <= bill.bill_date`, ordered by that date with `id` as the tiebreak. The ledger keeps moving after a bill is issued, so reading it at render time would make a reprint of last March's bill state today's balances — destroying the byte-stability that makes `sha256` meaningful and that reprinting leans on instead of version tracking. Payments arriving after the bill date belong on the next bill, which is how balance-forward billing works.

    **Two meanings of "credit", kept apart.** `totals.credits` is what the rate engine computed while pricing the period — `bill_segment.credits` summed — and is now labelled `Credits this period` and suppressed when zero. It was printed unconditionally, so a bill read `Credits $0.00` to a customer who had paid, which is worse than silence. Ledger credits (payments, adjustment credits, waivers, deposits) only ever appear in the settlement block.

    **Not built:** previous balance and balance forward. The block covers this bill's own charge, not the account's position across bills, so a customer with older open charges sees nothing of them here. That belongs with the statement view in module 23 and with #131's City-defined bill formats.

14. **Billing runs (shipped — slice 5c):** a run selects the accounts a cycle has due, bills each one in **its own transaction**, and records what happened per account.

    **Who is in the run:** a query — the account belongs to the cycle, its status bills (`ACTIVE` only; FINAL and CLOSED belong to Req 134), and it has a service agreement overlapping the window. An account that is simply not due is **not in the run at all**; an account that is due and cannot be billed is an item with a reason.

    **Not atomic, deliberately.** One transaction over twelve thousand accounts holds locks for minutes and lets one bad rate assignment roll back eleven thousand good bills. A partially complete run with forty exceptions is the normal, useful outcome — which is what `PARTIAL` means. Rating and aggregation do share one transaction per account, because segment creation marks the period's reads `billed_at`: rating that succeeds under an aggregation that fails would leave reads marked billed against segments with no bill.

    **Resume is the status filter, not a retry.** `attempts: 1` on the queue — an auto-retry would restart a run whose early accounts are already billed. Re-enqueueing bills only what is still PENDING, so a BILLED account cannot be billed twice, and a boot sweep re-enqueues anything a dead replica left `RUNNING`.

    **The run calculates; posting is a second act.** Bills a run creates pass `suppressAutoPost`, overriding the tenant's `autoPostBills`, and `POST /billing-runs/:id/post` raises the receivables once somebody has looked at the exceptions. Without this the run would have raised every receivable as it went and the review step would have happened after the money moved — a run is exactly when a bad rate change becomes twelve thousand wrong charges, and reversing those is far worse than discarding unposted bills. The per-account path keeps auto-posting as each tenant configured it, because there the operator is looking at the one bill they just made. Posting tolerates a bill somebody posted by hand in between rather than failing on it.

    **A known trap, not a bug:** `computeBillPeriod` clamps a window's start to `account.created_at`, so an account created *after* a window's start gets a window that starts after it ends, finds no segments, and is skipped `NO_SEGMENTS_TO_BILL`. Correct for a mid-period enrolment, and a real surprise on a fresh deployment's **first** run, where every account is newer than the window. The run's own window is computed with `created_at` at the epoch so the clamp cannot fire at run level — a run's window belongs to the cycle, not to any one account.

15. **Amounts on the bill:** every printed amount carries a currency symbol and thousands separators. The formatting lives in the template, not in `BillPresentation`, which carries plain 2dp strings — the presentation is the bill's content, and how an amount looks on paper is the template's business. Grouping is applied by hand rather than through `toLocaleString`, because a trimmed ICU on the host would otherwise vary the separator and break byte-stability. The quantity column is deliberately bare: a quantity is not money.

## UI Pages

Bill document actions and the two settings pages are shipped. The billing dashboard and the run views are **not built** — the billing run ships as API and worker only, so there is no screen that can start one or review its exceptions.

### Bill document actions (shipped)

`<BillDocumentActions>` (`packages/web/components/bills/bill-document-actions.tsx`) is offered on the **Bills** list and on an account's **AR tab** — a CSR on a call reaches for whichever screen they are already on.

- **View bill** — opens the PDF in a new tab for the browser's own viewer, generating it first if nothing is stored. On the bills list, the AR tab, and the bill's own dialog. It views rather than saves because a CSR on a call wants to read the bill out; the viewer still offers print and save. The tab is opened synchronously inside the click handler — after the fetch it would be outside the user gesture and a popup blocker would swallow it silently — and a blocked tab falls back to saving the file rather than doing nothing.
- **Regenerate** — `accounts:EDIT`. **Only in the bill's dialog**, not on list rows. Confirms first, and the copy says both things operators otherwise get wrong: it does not recalculate the bill, and the previous copy is not kept.

**The bills row carries one inline action: View bill.** Everything that moves money or overwrites something sits behind a **More** menu — Take payment on account, Regenerate PDF, Waive, Write off, Reverse charge, in that order. Ordering is by how often an item is reached and what it costs to get wrong, so reversal is last and furthest from where the pointer lands.

The row had grown to six buttons, which buried the common acts among the consequential ones and read as a control panel rather than a list of bills. `Post` is the single exception and proves the rule: it appears only *before* posting, when View bill cannot (the API refuses an unposted bill with a 409), so the two are mutually exclusive and the row never shows more than one inline action — and on an unposted bill Post is the only act there is.

Menu items keep the availability rule each had on the row rather than merely moving: Reverse needs a charge not already reversed, Waive and Write off need something still owed, Regenerate needs a posted bill. A user holding none of those permissions gets no trigger at all rather than an empty menu.

**The same row on both screens (2026-10-14).** A bill is listed in two places — the tenant-wide **Bills** page and an account's **Bills tab** — and they described it differently: the tab showed `Bill # · Period · Due · Total · Created` with a `View →` link and no status, no still-owed and none of the acts, because `GET /api/v1/accounts/:id/bills` returned the bill's own columns and nothing else. The tab now carries **Still owed**, **Status** and the full action set; `Created` is gone, since what is owed is the question asked on a call. Account and Customer stay off it — the tab is already inside one account.

Two pieces are shared rather than copied, and that is the point:

- `BillStatusPill` (`components/bills/bill-status-pill.tsx`) — the ladder from reversed → paid → posted-with-no-charge → overdue → part paid → outstanding → not posted.
- `BillRowActions` (`components/bills/bill-row-actions.tsx`) — Post, View bill, the More menu and the four dialogs it opens, with the availability rules above travelling with them.

Server-side, `BillSettlement` and `settlementOf` in `bill.service.ts` are the single source of `overdue`, `partPaid` and `charge` for **both** list endpoints. The reason is the bug in §13 of Business Rules: the tempting way to give the tab a status is to compare its money columns in the browser, which is how a bill with a fractional cent in its total came to read "Part paid" with nothing paid. One authority, two surfaces.

`ActionMenu` (`components/ui/action-menu.tsx`) renders through a portal with fixed positioning. Its first host is a table inside a card with `overflow: auto`, which clips an absolutely positioned child — the menu appeared and then vanished behind the card's edge on the last rows. Because the position is measured once on open, any scroll or resize closes it rather than letting it drift off its row.

**One button answers "give me the bill", not two.** Whether a PDF was generated before is a fact about our storage, not something a CSR should have to read off a row before knowing which button to press.

It **fetches before generating**, and that order is what keeps the permission split honest. Downloading is `accounts:VIEW` and generating is `accounts:EDIT`, so a generate-first button would stop a read-only user from fetching a PDF that already exists:

| State | `VIEW` only | `VIEW` + `EDIT` |
|---|---|---|
| PDF exists | GET succeeds | GET succeeds |
| None yet | GET 404 → POST 403, said plainly | GET 404 → POST → GET |

Only a 404 means "not generated yet"; any other failure is reported rather than treated as a cue to write.

Because of that order, **no row needs to carry document state** — and an earlier design that did was both extra API surface (a `document` field on the bills list and a `billDocument` field on ledger rows, each with its own join) and wrong the moment someone generated the PDF in another tab. The ledger row carries `billId` alone, since the document endpoint addresses the bill rather than the entry.

Nothing is offered on an unposted bill — the API answers 409 — so no button promises a PDF that cannot be made.

### Bill status (shipped)

A bill has **no status column, and deliberately won't get one.** Where it stands is derived from its own `BILL_CHARGE` ledger entry, because the ledger already knows whether a charge is settled and a copy on `Bill` could only ever drift from it — the same reason a refund's pool is derived from the credits it discharges rather than written down.

`GET /api/v1/bills?state=` and the Status filter both take:

| State | Meaning | Derived from |
|---|---|---|
| `unposted` | Calculated, not yet owed | no charge on the ledger at all |
| `outstanding` | Anything still owed | charge standing, `open_amount` > 0 |
| `partPaid` | Something was applied, some still owed | charge has `ledger_application` rows **and** `open_amount` > 0 |
| `paid` | Settled | charge standing, `open_amount` = 0 |
| `overdue` | Still owed and late | `bill.due_date` < today **and** outstanding |
| `reversed` | No longer stands | charge has a reversal |

Three decisions inside that are easy to get wrong:

- **Two axes, one control.** `unposted` answers *issuance* — is this calculation a debt yet? — and the rest answer *settlement*. An operator does not hold those apart, and a bill is only ever on one side of the first question, so one dropdown stays answerable. The filter previously offered posted and not posted only, which meant a fully paid bill read "Posted" and the paid fact appeared as a dash in the **Still owed** column.
- **`partPaid` is asked through the applications**, not by comparing `open_amount` to `amount`. Prisma cannot compare two columns in a `where`, and the applications are what actually consumed the charge — so this also catches a waiver that part-settled it.
- **`overdue` overlaps `outstanding` and `partPaid` on purpose.** A bill can be late and part paid at once, and collections asks for "late" without caring which. Filter values are not a partition.

Only `BILL_CHARGE` answers for the bill. Widening the type would let an unrelated credit — a waiver carries a `bill_id` too — speak for the charge.

The row's status pill reads the same way, in the order Reversed → Paid → Overdue → Part paid → Outstanding → Not posted, so the most consequential fact wins: a reversed charge is owed by nobody, which makes "Paid" a lie. Overdue is compared as date strings rather than `Date` objects, because `new Date("2026-06-30")` is UTC midnight and therefore the 29th west of Greenwich — a bill would read as late a day early across the Americas.

### Bill Production — `/settings/bill-production` (shipped)

Issuer identity and bill storage, on `settings`. One page rather than sections on two existing tabs, because these fields answer a single question — why a bill will not produce — and the API's 422 sends the operator to "Settings" to answer it. The five `REQUIRED_ISSUER_FIELDS` are marked required from the imported constant, and a banner above the form names the ones still blank rather than leaving the operator to discover them through a failed generation.

Bill storage deliberately does **not** sit beside the SaaSLogic endpoint. SaaSLogic is a payment rail; the bill store is reached through apptor-connect. "Both name an integration" is all they share.

### Bill Messages — `/settings/bill-messages` (shipped)

CRUD over `/api/v1/bill-messages` on `settings`: label, body, account type, service, priority and the active window. The date window is the only switch — there is no active/inactive flag, because a message with both can contradict itself and then nobody can say what a bill will carry. Deleting one warns that bills already produced keep the text they were printed with, since a stored PDF is not Regenerateed.

### Billing Dashboard (`/billing`)

- Summary cards: accounts ready to bill, bills on hold, pending SaaSLogic submission, this cycle's total revenue
- Aging dashboard widget linking to Accounts Receivable (Module 23) (Bozeman Reqs 149–150)
- "Run Billing Cycle" action: select cycle, preview impacted accounts, confirm

### Billing Run Detail (`/billing/runs/:runId`) — not built

**The run itself is shipped and has no screen.** It is reachable by
endpoint only, which means a run can be started by nobody in the building —
the one gap that matters most here, because the design's whole argument is
that an operator reviews the exceptions before the money is posted, and
today there is nowhere to review them.

What it needs, now that the statuses are real:

- Run metadata: cycle, window, bill and due dates, who started it, `last_progress_at` so a stalled run is distinguishable from a slow one
- Counts by item status — **BILLED / SKIPPED / FAILED**, not the superseded PENDING/SUBMITTED/HELD/REJECTED. Failed is the work queue and belongs first; skipped is noise an operator scrolls past, and the two must not share a number
- Per-account rows: account number, service period actually billed, segment count, total, and for an exception its `error_code` and message
- **Post this run** — the review gate, and the one action that moves money. Disabled while the run is PENDING or RUNNING, since the API refuses it with `RUN_NOT_FINISHED`
- Cancel while running
- CSV export of the item list

### Start a run — not built

`POST /api/v1/billing-runs` with a cycle id. The screen it needs is a cycle
picker, a preview of how many accounts are due, and the three dates it
would otherwise default. `RUN_ALREADY_EXISTS_FOR_WINDOW` names the existing
run, so the UI can offer "open that run" rather than an error.

### Billing Record Detail (`/billing-records/:id`)

- Full charge breakdown rendered as itemized table
- Proration details if applicable
- WQA calculation breakdown if applicable
- PDF preview / download button
- Status badge and SaaSLogic invoice link
- Hold management: add/release hold with reason
- Version history: if this is a reprint, shows full chain
- Reprint action (supervisor-only)
- Audit log entries for this record

### Bill Messages (`/billing/messages`)

- Table of active/inactive messages with date ranges and targeting
- Create/edit form: rich text, account type filter, commodity filter, date range
- Preview: shows how message renders on a sample bill

## Phase Roadmap

- **Phase 1 (Complete):** RateSchedule and BillingCycle entities defined. No billing execution.

- **Phase 2 (Complete):** MeterRead CRUD (Module 08). Consumption calculation.

- **Phase 3 — shipped:**
  - Declarative rate engine (`lib/rate-engine`) — predicate / quantity-source / pricing grammar, topological component ordering, minimum-bill floors applied after the main pass
  - WQA (wastewater as a share of water, winter averaging, irrigation exclusion) via `WqaValue` + the WQA loader
  - Tax and surcharge lines as rate components (`kindCode` `tax` / `credit`) — no separate TaxRule entity was needed
  - `BillSegment` + `BillSegmentLine` per agreement per period (slice 5a)
  - Account-level `Bill` aggregating segments (slice 5b.2)
  - Golden tests pinning the Bozeman water / sewer / stormwater / solid-waste tariffs and NorthWestern Energy residential electric
  - AR posting (module 23 slice 1): each issued `Bill` posts one signed `LedgerEntry`; `Account.balance` and `lastDueDate` are recomputed from the ledger in the posting transaction; posting is configurable per tenant (`TenantConfig.autoPostBills`) and per account

- **Phase 3 — shipped (bill production slice 1):**
  - `BillPresentation` resolver turning a `Bill` and its neighbours into the content a PDF is generated from
  - Declarative bill template + byte-stable `@react-pdf/renderer` machinery
  - `BillDocument` pointer rows; bytes in the tenant's own object store via apptor-connect's files plane
  - Issuer identity and bill storage as `TenantConfig.settings` namespaces (`issuer`, `billDocuments`) — no new columns
  - `BillMessage` with account-type and commodity targeting, resolved at `bill_date`
  - Generate, regenerate and download endpoints, staff and portal
  - Generate / download / Regenerate actions on the bills list and the account AR tab
  - Bill Production and Bill Messages settings pages

- **Phase 3 — shipped (slice 5c, API only):**
  - A service period is read to read — `resolveServicePeriod` is the one place a period is decided, and a `Bill`'s period is the span of its segments
  - `BillingCycle.read_day_of_month` — a cycle says when its reads are due, not just its bills; required, and must precede the bill day
  - Tier-threshold proration by the days actually billed (Req 138), opt-in per tariff via `standard_days`
  - `BillingRun` + `BillingRunItem`, the `billing-runs` queue and worker, six endpoints, a boot sweep for runs a dead replica left RUNNING
  - Run-created bills are **not** auto-posted; posting the run is its own act

- **Phase 3 — outstanding:**
  - **The billing run's UI** — start a run, watch it, review the exception list, post it. The API has no caller, which makes the review gate the design is built around unreachable today
  - `Generate Bill` on an account's Bills tab is still the only thing that can create a bill. It should become the Req 134 final-bill action or go, once the run is usable
  - Rebill / corrections (slice 5d) — this is where bill versioning belongs
  - Payments, allocation, waivers, write-offs and the customer statement view, against the ledger (module 23 slices 2–4)
  - Proration for partial periods
  - Bill holds
  - Final bill on account closure
  - Bill delivery: email to paperless customers, print vendor export
  - **The portal bill download — descoped from slice 1 by decision, not forgotten.** The API endpoint is live and tested, but no portal screen can call it: `/portal/bills`, the portal dashboard and `/portal/invoices/[id]` all render `mockCustomerBills`, so there are no real bill ids in the portal UI to download. It needs the portal bill list wired to real `Bill` rows first — Phase 4.2 work, which also needs a `GET /portal/api/bills` that does not exist yet.
  - `BIMONTHLY` / `QUARTERLY` cycle frequencies — `computeBillPeriod` throws `UNSUPPORTED_FREQUENCY` today
  - Tenant-configurable due-date offset — hardcoded at bill date + 30 days

- **Phase 4 (Planned):** Bill viewing in customer portal (Module 15). Multi-account billing views.

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 61 | Consolidated bill with service-level accounting | **Shipped** — `Bill` aggregates one `BillSegment` per agreement; consolidated by CIS, not SaaSLogic |
| 62 | Effective-dated enrollment with proration | Outstanding: proration logic in rate engine |
| 63 | Regulatory fees and surcharges | **Shipped** — rate components; no separate Surcharge entity needed |
| 64 | Configurable taxes and franchise fees | **Shipped** — rate components with `kindCode = tax`; no TaxRule entity needed |
| 69 | Wastewater = % of water usage | **Shipped** — linked-commodity loader + WQA |
| 70 | Caps, mins, maxes for wastewater/WQA | **Shipped** — pricing grammar + `minimum_bill` floors |
| 71 | Configurable WQA calculations | **Shipped** — `WqaValue` with override, WQA loader |
| 72 | Winter averaging for wastewater | **Shipped** — WQA source window |
| 73 | Exclude irrigation from wastewater | **Shipped** — predicate on meter/commodity in the quantity source |
| 74 | Minimum bills regardless of usage | **Shipped** — `minimum_bill` stage applied after main pricing |
| 101–105 | Interval aggregation, partial periods, rebilling, reconciliation | Phase 3: rate engine scope. **Partial periods are now billed as they actually fall** — read to read rather than calendar month |
| 130 | PDF bill generation, historical images | **Shipped** — `BillDocument` + `@react-pdf/renderer`; a stored document is the historical image. Generate, download and regenerate on the bills list and AR tab |
| 131 | Print vendor integration | Outstanding: print export file delivery. `document_type` is a VARCHAR so `PRINT_EXPORT` needs no migration |
| 133 | Bill reprints, corrected bills with versioning | **Partial** — a bill can be printed again on demand, byte-identically. Corrected bills and versioning are outstanding (slice 5d); reprinting deliberately creates no version |
| 134 | Final bill at account closure | Phase 3: FINAL billing trigger |
| 136 | Bill holds | Phase 3: hold_reason on BillingRecord |
| 137 | Configurable bill messages by account type/service | **Shipped** — `BillMessage` targeted by account type and commodity over a date window, resolved at `bill_date`, managed at Settings → Bill Messages |
| 138 | Prorate tier thresholds for partial periods | **Shipped** — a `tiered` pricing declaring `standard_days` has each tier's `to` scaled by the days billed. Opt-in, so a published schedule prices unchanged until it is revised, and no tariff declares it yet |
| 139 | Itemized charges on bills | **Shipped** — `BillSegmentLine` rows, each traceable to the `RateComponent` that produced it |
| 140 | Validate charges against adopted rates | Outstanding: lines already carry `source_schedule_id` / `source_component_id`, so validation has what it needs |
| 141 | Reconciliation: water usage vs wastewater billing | Outstanding: WQA-related |
| 142 | Rebill on read corrections | Outstanding: slice 5d, CORRECTED read → rebill flow |
| 149–150 | Aging dashboard (real-time) | Outstanding: receivables now exist (module 23 slice 1); the dashboard itself is not built |
| 157–164 | Payment processing (PCI, ACH, posting, reversals) | Card handling and settlement delegated to SaaSLogic (module 21); **posting and reversals are CIS's own, via module 23** |
