# 28 — Legacy CIS Overlay

**Status:** proposed, 2026-10-31. Nothing in this spec is built.

**Audience:** whoever builds the overlay offer — import, shadow-rating,
exception handling and the apptor-workflow templates. Read
[07b — Rate Model v2](07b-rate-model-v2-design.md),
[22 — Import Infrastructure](22-import-infrastructure.md) and the
Integrations section of `CLAUDE.md` first.

**Why now:** the full CIS sells through RFPs with 12–24 month cycles and
needs a live reference. The overlay sells to utilities that are *not*
replacing their CIS this year, runs on what is already built (the rate
engine, apptor-connect, apptor-workflow), and leaves each customer with
its tariffs proven in our engine and its data flowing through our
importer. When its CIS contract ends, conversion is a cut-over, not a
project. This is the "land" step; the full CIS is "convert".

---

## The offer

A utility keeps its existing CIS (Tyler, Harris products, CUSI and
similar) as the system of record. Each billing cycle it sends us an
export. We:

1. **Shadow-rate every bill.** Recompute it with Rate Model v2 from the
   utility's own reads and tariffs, and compare with what its CIS
   calculated.
2. **Raise exceptions before bills go out.** Mismatches, unusual reads,
   and revenue leakage (active accounts with zero usage, wrong rate
   class, missing fees), each triaged by an AI step and decided by a
   person.
3. **Explain any bill** line by line, from the recomputed charges, for
   staff first and later for the portal.

The measure the pilot sells on: **dollars found and billing errors
caught per cycle.**

## What exists today

| Piece | Where | State |
|---|---|---|
| Rating | `packages/api/src/lib/rate-engine` — `rate(ctx: RatingContext): RatingResult` | Built; pure function over snapshots, returns `lines`, `totals` and a per-component `trace` |
| Loaders that build `RatingContext` from tenant rows | `packages/api/src/lib/rate-engine-loaders` | Built (account, premise, meter, items, index, linked-commodity, WQA, tenant) |
| Bills, segments, lines | module 09 | Built (`Bill`, `BillSegment`, `BillSegmentLine`) |
| Bulk import framework | module 22 | **Design only** — meter-read import exists, the shared primitive does not |
| Outbound and file transport | apptor-connect `files` and `proxy` planes; `sftp` and `rest` connectors exist | Built |
| Workflow engine with AI and human steps | apptor-workflow (`/v1/runs`, `/runs/{id}/signals/{name}`, `kind: human`, cron scheduling) | Built; human delivery is **email magic link only**; the browser renderer for hosted forms is planned |

## Scope

**In:** overlay tenants; a file-based export contract; import of legacy
customers, premises, meters, accounts, service agreements, reads and
pre-bill registers; mapping legacy charge codes to rate components;
shadow-rating and variance; exception records; three workflow
templates; staff-facing bill explanations.

**Out, each later or its own spec:** writing corrections back into the
legacy CIS; customer-facing portal and SMS for overlay tenants; payments
for overlay tenants (module 21 applies once they convert, or as a
separate add-on); real-time API adapters; an on-premise agent; rate
scenario modelling (the scenario runner is its own spec, and overlay
tenants are its first users).

## 1. Overlay tenants

- **OVL-T-1 (Must).** A tenant carries an operating mode, `FULL` or
  `OVERLAY`. Overlay tenants use the normal tables (customers,
  premises, meters, accounts, agreements, reads, rate schedules), so the
  existing loaders and `rate()` work unchanged.
- **OVL-T-2 (Must).** In `OVERLAY` mode the legacy CIS is the system of
  record. Billing runs, AR posting, payments, delinquency actions and
  customer notifications are refused for the tenant, server-side, with a
  message naming the mode. The UI hides them.
- **OVL-T-3 (Must).** Mirrored entities are written only by the overlay
  import. Staff may view them and add notes, not edit them, because the
  next import would silently overwrite an edit.
- **OVL-T-4 (Should).** Switching `OVERLAY` → `FULL` is the conversion:
  a platform action, audited, run after a final import. It re-enables
  the refused functions; it does not move data, because the data is
  already in place.

## 2. Export contract (data in)

- **OVL-IN-1 (Must).** v1 is file-based. The utility's CIS produces a
  scheduled export, which apptor-connect's `sftp` connector picks up —
  from an SFTP location the utility already uses for its payment-vendor
  files, or one we provision. No install inside the utility's network.
- **OVL-IN-2 (Must).** One export set per billing cycle, with: accounts
  and customers, premises, meters, service agreements with rate codes,
  reads for the period, and the **pre-bill register** — the proof or
  edit report the CIS produces before bills print, with each bill's
  lines and charge codes. The pre-bill register is what makes catching
  errors before mailing possible; a post-bill export still allows
  revenue-assurance findings, but late.
- **OVL-IN-3 (Must).** Each legacy CIS gets a **connector pack**: a
  column mapping and a transform per file (JSONata, which
  apptor-workflow already runs) into our import
  shape, versioned and tested against a sample export. The first pack
  is for whichever CIS the first pilot runs.
- **OVL-IN-4 (Must).** Ingestion uses module 22: per-row validation,
  error reports, resumable batches, notification on completion. This
  makes module 22's customer, premise, meter, account and agreement
  handlers a prerequisite (see Dependencies).
- **OVL-IN-5 (Must).** Imports are idempotent by legacy key. Each
  mirrored row stores its legacy identifier; a re-sent file updates in
  place and never duplicates. **Built 2026-11-02.**

  `legacy_key varchar(255)` on `customer`, `premise`, `meter`,
  `account` and `service_agreement`, nullable, with a partial unique
  index per table on `(utility_id, legacy_key) WHERE legacy_key IS NOT
  NULL`. Every handler offers a `legacyKey` column: supply it and a
  re-sent row updates in place, leave it blank and the row is created
  exactly as before, so a one-shot migration is unaffected and only an
  overlay opts into the second shape. A blank cell is **absence, not a
  key** — a CSV carries a cell for every declared column, and the
  partial index covers only rows that have one.

  Three of the five already had a unique business number —
  `account_number`, `meter_number`, `agreement_number` — so matching on
  those would have needed no migration. Rejected: premise and customer
  have no unique business key at all (an address is not unique, which is
  why the import reports `PREMISE_AMBIGUOUS`; `customer.email` is
  nullable and shared by households), so a column was needed for those
  two regardless, and two matching rules are worse than one. A business
  number is also not a stable handle — a connector pack reformats it,
  and a utility renumbers accounts during a billing-system change, which
  is exactly when an overlay runs.

  **What an update touches is deliberately narrow, and what it refuses
  is the point.** Each entity's identity-bearing fields are compared,
  and a difference is `LEGACY_KEY_CONFLICT` rather than a silent
  rewrite: the account and commodity of an agreement (and the premise of
  its service point), the number and customer of an account, the badge,
  premise and commodity of a meter, the type of a customer, the owner of
  a premise. A key whose identity has moved means the legacy system
  re-used an id or the connector pack maps it wrongly, and applying it
  would move a balance between people or an agreement between accounts —
  a billing change nobody asked for that no later cycle would reveal.

  Below the matched row, **children are not reconciled.** An agreement's
  service point, meter install and rate assignment are left as they are,
  because `meter_read.service_agreement_id` is RESTRICT: recreating a
  point would fail on exactly the agreements that have been billed. The
  one exception is a *missing* rate assignment, since filling a gap
  cannot destroy anything; a file naming a **different** schedule than
  the live assignment is reported as `RATE_ASSIGNMENT_CHANGED`, because
  assignments are effective dated and the right answer is a new window,
  not an overwrite. An imported deposit is likewise never re-applied on
  update — it posts a DEPOSIT ledger entry on create, and running that
  each cycle would inflate the balance.

  Reconciling children, and turning these refusals into the variance
  report of §4 instead of row errors, is the next slice.
- **OVL-IN-6 (Should).** A missing or late cycle export raises an
  exception to the tenant's staff (see §5), because silence looks like
  a clean cycle.

## 3. Tariffs and charge codes

- **OVL-R-1 (Must).** The utility's tariffs are configured in Rate
  Model v2 as for a full tenant, with golden-bill tests built from real
  past bills taken from the pre-bill register.
- **OVL-R-2 (Must).** A `LegacyChargeCodeMap` links each legacy charge
  code to the rate component (or components) that should produce it.
  Unmapped codes are reported on import, not ignored.
- **OVL-R-3 (Should).** Setup is AI-assisted: an agent reads the rate
  ordinance or fee schedule PDF and drafts rate components and the
  charge-code map for staff review. Nothing is published without a
  person approving it and the golden-bill tests passing.

## 4. Shadow-rating

- **OVL-S-1 (Must).** For each bill in a pre-bill register, rate the
  same agreements over the same period with `rate()`, and store a
  `ShadowRating`: legacy total, our total, per-line comparison through
  the charge-code map, and the component `trace`.
- **OVL-S-2 (Must).** A variance is a difference above the tenant's
  tolerance (default one cent per line, to absorb rounding). Variances
  are classified: **tariff** (our configuration or theirs disagrees on a
  rate), **quantity** (different usage or units), **missing line**,
  **extra line**.
- **OVL-S-3 (Must).** Shadow-rating never changes a legacy bill. It
  produces findings; people act on them in the legacy CIS.
- **OVL-S-4 (Should).** A cycle summary: bills rated, matched, varied,
  and the dollar total of variances in each direction.

## 5. Exceptions

- **OVL-E-1 (Must).** An `OverlayException` records one finding: type,
  account, bill, amount at stake, evidence (lines, reads, trace), status
  (`open`, `in_review`, `resolved`, `dismissed`), resolver and reason.
- **OVL-E-2 (Must).** Types in v1: bill variance (from §4); read
  anomaly (spike, drop, zero on an active account, rollover, estimated
  read streak); revenue leakage (active account billed nothing, rate
  class inconsistent with premise type, recurring fee missing);
  late or missing export.
- **OVL-E-3 (Must).** Every resolution is audited with the actor and
  the before and after status. An AI suggestion is stored separately
  from the human decision and never substitutes for it.

## 6. Workflows (apptor-workflow)

CIS raises exceptions; apptor-workflow decides who looks at them and
collects the decision. CIS starts a run with `POST /v1/runs` and the
workflow reports its outcome back to the CIS API through apptor-connect.

- **OVL-W-1 (Must). High-bill hold.** For a variance or read anomaly
  above a threshold: an agent step classifies the likely cause (leak,
  misread, stuck meter, rollover, vacancy, tariff error) and drafts a
  recommended action; a `kind: human` `input` step asks the billing
  lead to hold, correct or release, by email magic link; the decision
  is written to the exception.
- **OVL-W-2 (Must). Cycle review.** On import completion, a run
  summarises the cycle (§4 summary, open exceptions by type and amount)
  and sends it to the billing manager as a `notify`.
- **OVL-W-3 (Should). Revenue leakage review.** Weekly, by cron:
  leakage exceptions grouped by type, sent for a decision on each
  group.
- **OVL-W-4 (Must).** No workflow changes a bill amount, approves a
  write-off or triggers a shutoff. Agent steps suggest; human steps
  decide.

## 7. Bill explanations

- **OVL-X-1 (Should).** Staff can ask "why is this bill different from
  last month?" on any overlay bill. The answer is generated from the
  shadow-rated lines, the component trace and read history, and cites
  the lines it relies on. If the bill has an open variance, the answer
  says so instead of explaining a number we believe is wrong.
- **OVL-X-2 (Could).** The same explanation in the portal, once overlay
  tenants have one.

## 8. Cross-cutting

- **OVL-X-3 (Must).** Every new table holds `utility_id`, has an RLS
  policy in the fail-loud form and `FORCE ROW LEVEL SECURITY`, and is
  covered by `assertRlsEnforced` (architecture §7.1).
- **OVL-X-4 (Must).** No credential for the legacy SFTP location or the
  workflow server lives in this codebase; both are apptor-connect
  integrations.
- **OVL-X-5 (Must).** Mirrored data is retained only while the overlay
  contract runs, then deleted or converted, per tenant setting.

## Dependencies

| Needed | Status | Why |
|---|---|---|
| Module 22 handlers for customers, premises, meters, accounts, agreements | **Built** (agreements landed 2026-11-01; the other four were already shipped) | Every overlay import goes through it; the same handlers are the CIS migration tool |
| Upsert by legacy key (OVL-IN-5) | **Built** 2026-11-02 | `legacy_key` on all five mirrored tables, partial-unique per tenant; every handler matches on it and updates in place. A row without a key is created exactly as before, so an ordinary migration is unchanged. See below for what an update touches |
| apptor-workflow hosted form renderer | Planned | What a billing lead sees after clicking the email link |
| SMS delivery channel in apptor-workflow and a Twilio-class connector in apptor-connect | Not built | Only for customer-facing alerts, which are out of scope for v1 |

## Suggested slices

| Slice | Delivers | Unblocks |
|---|---|---|
| 1 | Overlay mode and its refusals (OVL-T-*), ~~module 22 handlers~~ (done), upsert by legacy key, the first connector pack, SFTP pickup (OVL-IN-1 – 5) | A pilot's data in CIS, refreshed each cycle |
| 2 | Charge-code map, golden bills from real registers, shadow-rating and variance (OVL-R-1, 2; OVL-S-*) | The first "we found $X" report |
| 3 | Exceptions (OVL-E-*), high-bill hold and cycle review workflows (OVL-W-1, 2, 4) | Findings acted on before bills mail |
| 4 | Revenue leakage review, bill explanations, AI-assisted tariff setup (OVL-W-3, OVL-X-1, OVL-R-3) | Faster onboarding of the next pilot |

## Open questions

1. **Which legacy CIS first?** The first connector pack should be the
   one the first pilot runs. Which systems are most common among the
   Mountain West and Ohio prospects?
2. **Can that CIS export a pre-bill register on a schedule,** or only
   on demand? If only on demand, the utility's billing clerk drops it
   in the SFTP folder as a step in their cycle.
3. **Who hosts the SFTP drop** when the utility does not already have
   one: a managed endpoint we provision per tenant, or one shared
   endpoint with per-tenant folders?
4. **Pricing:** per account per month, matching the full CIS's unit, so
   conversion is a change of tier rather than a new contract?
