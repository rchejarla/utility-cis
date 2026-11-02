# 29 — Rate Modeling

**Module:** 29 — Rate Modeling (the rate engine as an independent offer)
**Status:** proposed, 2026-11-02. Nothing in this spec is built.
**Entities:** `ModelStudy`, `ModelSubject`, `ModelScenario`, `ModelResult`, `ModelStudyViewer` (all new)
**Depends on:** the Rate Model v2 engine (built), module 22's import framework (built), spec 26 for electric demand and TOU (proposed, nothing built)

## The offer

Sell the rate engine on its own, to people who are not yet CIS
customers.

Two buyers, and they are the same buyer at different distances:
**rate-study consultants**, who price tariffs for utilities they do not
operate, and **utilities running a legacy CIS**, who need to justify a
rate change to a council and currently do it in a spreadsheet. Each is a
future CIS buyer, which is what makes the offer worth more than its
licence fee: a consultant who has configured a utility's tariffs here
has already done the hardest part of onboarding it, and a utility that
trusts our arithmetic on its own rates has already answered the question
that stalls every CIS sale.

This is the same land-and-expand shape as the legacy CIS overlay
(spec 28) and aimed at an overlapping market. The two should share
everything they can — see **Relationship to spec 28**.

And the introduction is built in: the studied utility logs in read-only
to review its own study (§7), which puts its people inside the product,
looking at their own rates, before anybody has pitched them a CIS. The
overlay gets a utility's *data* into the product; this gets its
*people* in, one step earlier.

## Why the architecture already fits

Worth stating first, because it decides the whole design and it was not
planned for:

**`rate(ctx)` is a pure function.** `lib/rate-engine/rate.ts` takes a
`RatingContext` and returns `{ lines, totals, trace }`. No Prisma, no
`await`, no persistence. Everything database-bound lives around it — the
loaders that build the context, and `bill-segment.service.ts` that
writes the result.

**And it consumes snapshots, not rows.** `BaseContext` is
`{ sa, account, premise, period, assignments }`, where each snapshot is
plain data — `ServiceAgreementSnapshot` is six string fields,
`PremiseSnapshot` carries `eruCount`, `hasStormwaterInfra` and an index
signature. Nothing in the engine's input is a Prisma model, and nothing
it touches is fetched.

So the engine can already rate something that exists nowhere in the
database. What this module builds is a different set of edges on it: a
way to describe subjects without a CIS, a way to run tariffs over them
in bulk, and a way to compare two runs.

**`ComponentTrace` is the product, not a diagnostic.** A rate study
ends with somebody defending a number to a council. The engine already
emits, per component, what it evaluated and why — and that is the
difference between this and a spreadsheet, where the formula is the only
explanation and nobody re-derives it two years later.

## Goals

1. **Rate without saving.** A call that takes a subject and a tariff and
   returns lines, totals and trace, touching no `bill`, `bill_segment`
   or `ledger_entry` row.
2. **Load usage without a CIS.** A consultant arrives with a
   spreadsheet of account numbers and consumption and no entities at
   all. That has to be enough.
3. **Run a scenario over a population** and report the result per
   subject and in aggregate.
4. **Compare two scenarios** — current tariff against proposed — and
   report the delta per subject, by service class, and in total.
5. **Show the work.** Every modelled bill is explainable down to the
   component, because that is what the deliverable is made of.
6. **Water, sewer, stormwater and solid waste at launch.** Electric
   demand and time-of-use come later, and are spec 26's to build.

## Non-goals

- **No billing.** A model produces no bill, no receivable, no
  notification and no document. It is arithmetic with an audit trail.
- **No customer data.** A modelling subject is an account label, a
  service class and some quantities. No names, no addresses, no contact
  details — see **Anti-goals**.
- **No interval data at launch.** Hourly and sub-hourly load shapes are
  what electric demand needs and spec 26 is where they are designed.
- **No tariff authoring UI beyond what exists.** Rate Model v2's
  component editor is the tariff surface; this module adds subjects,
  scenarios and comparison, not a second way to write a rate.

## Anti-goals

Things that would make this a failure even if it worked:

- **Becoming a cut-down CIS.** If a modelling tenant accumulates
  customers, premises, meters and agreements, we have sold a worse
  version of the real product and taught the market that the cheap tier
  is enough.
- **A second rate engine.** If modelling ever needs behaviour the
  billing engine does not have, the answer is to add it to the engine,
  not to fork it. Two engines that disagree is the one outcome worse
  than no modelling product at all — the entire pitch is that the
  numbers are the same ones that would bill.
- **Holding a utility's customer list for a study that needs none of
  it.** The data a consultant must hand over is the cost of the
  offer; keeping it small is a feature, and a breach of a file we did
  not need would cost more than the module earns.

## 1. The modelling tenant

- **MOD-T-1 (Must).** A modelling customer is a tenant with
  `operatingMode = MODEL`, a third value beside `FULL` and `OVERLAY`
  (spec 28, OVL-T-1). Everything OVERLAY refuses, MODEL refuses too —
  billing runs, AR posting, payments, delinquency, customer
  notifications — and MODEL additionally refuses the mirrored-entity
  writes, because a modelling tenant has no customers, premises, meters
  or agreements at all.

  *Why a mode and not a module set:* a tenant with the billing modules
  disabled would still answer `MODULE_DISABLED` to a billing route,
  which is true and unhelpful — and nothing would stop an operator
  enabling them. The mode is the statement that this tenant does not
  bill anybody, enforced in the authorization pass and in
  `tenantsForScheduler` for the same two reasons overlay needed both.

- **MOD-T-2 (Must).** A new preset role, **Rate Consultant**: full
  authority over studies, subjects, scenarios and tariffs; no authority
  anywhere else, because there is nowhere else. It sits beside the six
  existing presets (`role-presets.ts`) rather than replacing Utility
  Admin, since a utility modelling its own rates has both kinds of
  person.

- **MOD-T-3 (Must).** A modelling tenant gets its **own nav section**.
  The sidebar is built from `navSections` and gated per item by module
  and permission (`nav-visibility.ts`), so a MODEL tenant would
  otherwise show Operations, Billing and Collections as empty headings.
  A **Modeling** section — Studies, Subjects, Scenarios, Tariffs —
  replaces them, and the operations sections are hidden by mode rather
  than by permission.

  *Rao's call, 2026-11-02: a rate consultant gets a different set of
  menus, not the CIS menus with most of them greyed out.*

- **MOD-T-4 (Should).** `MODEL → FULL` and `MODEL → OVERLAY` are
  conversions, by the same audited platform action as OVL-T-4. The
  tariffs a consultant configured are the asset that carries over; the
  subjects do not, because by then there are real accounts.

- **MOD-T-5 (Must).** A modelling tenant keeps the **audit log** (Rao,
  2026-11-02). It has no customers, so most of what the log exists for
  is absent — but a study is a document somebody defends, and "who
  changed this tariff, and when, between the two runs" is the question
  an opposing consultant asks. Tariff edits, scenario runs and subject
  imports are all audited; the log is the only reason a dated run can
  be trusted as the thing it claims to be.

## 2. Subjects: usage without a hierarchy

**The question this module turns on: a usage file arrives with account
numbers and consumption, and nothing else exists.**

**A subject is one service, for one period, with the quantities that
period used.** One row per account-month, in the way a rate consultant
would count them: a 12,000-account utility studied over a year is
144,000 subjects. It is the unit a tariff is applied to, which is why it
is not called an account (an account may have water, sewer and
stormwater) and not a bill (a bill is the output, and a study produces
no bills).

*The name is kept rather than changed, and that is a judgement: Rao had
to ask what it meant, which is exactly the test a name should pass
unaided. Every alternative was worse in a different way —
`ModelAccount` is wrong because one account has several, `ModelBill`
names the output, `ModelServicePeriod` is accurate and unreadable, and
`account-month` breaks on quarterly solid waste. So it stays, defined
here at first use and nowhere assumed. It also never reaches an invoice,
since pricing is per seat and per study rather than per subject.*

- **MOD-S-1 (Must).** Rating does **not** require a premise, meter,
  account or service agreement to exist. A `ModelSubject` is a flat row
  — label, service class, commodity, period, quantity and unit, plus the
  premise attributes a tariff reads (`eru_count`,
  `has_stormwater_infra`, container counts, `premise_type`) — and it is
  mapped onto the engine's snapshots directly.

  This is possible because the engine consumes snapshots of plain data,
  not rows. `ServiceAgreementSnapshot` is six strings;
  `PremiseSnapshot` has an index signature. A subject satisfies them
  with synthesised ids that point at nothing.

### Relaxing the existing importer, or a new one

**Decision: reuse module 22's framework, add a new kind, write to a new
table. Do not relax the meter-read handler.** *(My call; the reasoning
is below so it can be overturned on its merits.)*

The simpler alternative, stated first as the discipline requires: make
`premiseId`, `meterId` and `serviceAgreementId` optional on the
meter-read path, and let a read exist without a meter.

What that costs, concretely, is the invariants that make the CIS worth
trusting:

- `meter_read.service_agreement_id` and `meter_read.meter_id` are NOT
  NULL with tenant-scoped foreign keys. Relaxing them weakens every
  real tenant's schema so that a modelling tenant can skip them.
- `schema-invariants.integration.test.ts` exists to fail when a
  tenant-scoped key regresses to a single column or goes missing. This
  change would have to be excluded from it, which is the point at which
  a guard stops guarding.
- Every downstream reader — the billing dispatcher, the delinquency
  sweep, `findClosedUnbilledWindows` — would acquire a null case for
  rows that can never reach them. Conditionals spread from the schema
  outward and nobody can later tell which were load-bearing.

And it buys nothing, because **a modelling subject is not a reading**. A
reading is an observation of a device at a time, which is why it needs a
meter; a subject is a hypothesis. Forcing the hypothesis through a table
built for observations means inventing a meter that does not exist, to
satisfy a constraint that exists to stop exactly that.

What **is** reusable is the import framework itself, and all of it:
batches, per-row errors with codes, the mapping stage with
auto-detection, resumability, the zombie sweep, the status page, the
notification. So:

- **MOD-S-2 (Must).** A `model_usage` import kind on the existing
  framework, with `ModelSubject` as its target. One handler file, the
  same wizard, the same `/imports` history. Nothing in the framework
  learns about modelling.
- **MOD-S-3 (Must).** Its canonical fields are the subject's own:
  `subjectLabel`, `serviceClassCode`, `commodityCode`, `periodStart`,
  `periodEnd`, `quantity`, `unitCode`, plus the premise attributes.
  Tenant custom fields ride along as `custom:<key>` as they do
  everywhere else.
- **MOD-S-4 (Should).** A subject may carry **current billed revenue**
  for the period. Without it a study can model the proposed tariff but
  not the change, and "what does this do to the average residential
  bill" is the only question anybody asks. **Optional** (Rao,
  2026-11-02): a consultant cannot always get it from a legacy CIS, and
  a product that refuses the study without it would lose the customers
  least able to run one themselves. Studies that lack it can model the
  proposed tariff but not the change, and the comparison screen says so
  rather than showing a blank column.
- **MOD-S-5 (Must).** Subjects carry no customer identity. The loader
  refuses a mapping onto a name, email, phone or address field, rather
  than accepting and discarding it — a file that was never loaded
  cannot leak.

## 3. The preview call

- **MOD-P-1 (Must).** `POST /api/v1/rate-preview` takes a subject (by
  id, or inline) and a tariff (a published rate schedule, or a draft
  the caller may read) and returns `{ lines, totals, trace }`. It
  writes nothing.

  This is **not** `previewBillingRun`, which answers "which accounts are
  billable and what blocks the rest" and touches no money at all. The
  name is taken; `rate-preview` is the thing being asked for.

- **MOD-P-2 (Must).** It rates a **draft** schedule. The billing path
  deliberately refuses an unpublished tariff
  (`bill-segment.service`), and modelling is the case that refusal was
  always missing: the entire point is to price something before anyone
  commits to it. The response marks the tariff's state so a draft
  result can never be mistaken for a billed one.

- **MOD-P-3 (Should).** It accepts an inline subject with no stored row,
  so the modelling screen can rate as the user types without
  persisting a subject per keystroke.

## 4. The scenario runner

- **MOD-R-1 (Must).** A `ModelScenario` is a study, a population of
  subjects and a tariff. Running it rates every subject and stores
  `ModelResult` rows — per subject: lines, totals, trace.
- **MOD-R-2 (Must).** Runs are **immutable and dated**. A council paper
  cites a number; the run that produced it has to still exist when
  somebody asks six months later, including the tariff version it used.
- **MOD-R-3 (Must).** A comparison of two scenarios reports the delta
  per subject, grouped by service class, and in aggregate: total
  revenue, mean and median bill, and the count above any threshold —
  "how many households pay more than $10 extra" being the question that
  actually decides a vote.
- **MOD-R-4 (Should).** Runs go through the queue, not the request. A
  study of 40,000 subjects is module 22's async path again, and the
  existing batch/progress/notification machinery already fits.
- **MOD-R-5 (Should).** A scenario records its **assumptions** —
  growth, weather normalisation, a flat consumption change — as data
  rather than as a pre-adjusted file, so a reviewer can see what was
  assumed instead of inferring it from the numbers.

## 5. The modelling screen

- **MOD-U-1 (Must).** A study page: its subjects, its scenarios, and
  the comparison between any two.
- **MOD-U-2 (Must).** A single-subject rater: pick a subject, pick a
  tariff, see the lines and the trace. This is the demo, and it is
  also how a consultant checks a tariff is configured right before
  running it over 40,000 rows.
- **MOD-U-3 (Must).** The trace is **visible, not a developer tool**.
  Component by component: what was evaluated, the quantity, the unit it
  was converted to, the price applied, whether a minimum bound it.
- **MOD-U-4 (Must).** **A PDF report is the deliverable** (Rao,
  2026-11-02). A rate study is defended in a council meeting from a
  paper, so the document is the product and the screen is how it is
  assembled — not the other way round. It carries the comparison, the
  aggregates, the assumptions and a worked example or two with their
  traces, so a reader can follow one bill from quantity to total
  without the application in front of them.

  **Reuse the bill PDF stack**, not a second renderer:
  `bill-generation/generate-bill-pdf.ts` already turns a presentation
  object into a Buffer, with `stabilize-pdf.ts` beside it for
  byte-stable output. A study report is a different presentation
  through the same machinery. A second rendering path would drift in
  fonts, page setup and the logo resolution that
  `resolveLogoDataUri` already handles.

  *Consequence worth naming:* byte-stable output matters more here than
  it does for a bill. A report cited in a council paper may be
  regenerated months later to answer a challenge, and it has to come
  back identical — which `stabilize-pdf.ts` exists for, and which a
  hand-rolled renderer would not give.

## 6. One tenant, several clients' studies

**Decided (Rao, 2026-11-02): a consultant's tenant holds studies for
several utilities.** The alternative — a tenant per client — would have
a consultant logging in once per city, which is the kind of friction
that loses the account.

This is the answer with real consequences, and they are worth stating
before anyone builds slice 1, because `utility_id` is the isolation
boundary everywhere in this codebase.

- **MOD-C-1 (Must).** `ModelStudy` carries the **client** it is for — a
  label, not a `Utility` row, because the studied utility is not a
  tenant here and must not become one. Subjects, scenarios and results
  all hang off the study, so the study is the grouping a consultant
  navigates by.

- **MOD-C-2 (Must).** **Tariffs are the problem.** `rate_schedule` is
  keyed `@@unique([utilityId, code, version])`, so two clients' "RES-
  WATER" collide inside one consultant's tenant — and they will, because
  utilities name their residential water tariff the same thing.

  The options, with the cost of each:

  - **Study-scoped schedules.** A nullable `study_id` on
    `rate_schedule`, with the unique key widened to include it. NULL
    means a tenant-wide tariff, which is every schedule in every FULL
    and OVERLAY tenant today, so nothing existing changes. Costs: a
    migration on a table the billing path reads, and a nullable
    dimension that every rate query must either ignore deliberately or
    honour.
  - **Code conventions.** `BZN-RES-WATER` versus `HLN-RES-WATER`, left
    to the consultant. Costs nothing and fails the first time two
    studies are for utilities with the same prefix, or the same utility
    two years apart.
  - **A tenant per client after all**, with the consultant switching.
    Costs the decision above.

  *Recommended: study-scoped schedules.* It is the only one that
  cannot silently produce a wrong number, and the nullable column is
  inert in every tenant that is not modelling. But it touches the
  billing path's most load-bearing table, so it wants deciding before
  slice 1 rather than discovered during slice 4.

- **MOD-C-3 (Should).** A study can be **copied**, tariffs and all, as
  the way a consultant starts the next city from the last one. That is
  the workflow the per-study pricing implies, and it is only possible
  if MOD-C-2 scopes tariffs to studies.

## 7. The client's read-only view

**Decided (Rao, 2026-11-02): the studied utility logs in, read-only, to
see its own study — and that is how the product introduces itself.**

This is the cheapest demo the product will ever have. A utility's
finance director reviewing their own rate study is looking at their own
rates, their own quantities and their own bills, inside the application
we want them to buy. No sandbox, no sample data, no imagination
required. It is the same land-and-expand reasoning as the overlay, one
step earlier: the overlay gets a utility's data into the product, and
this gets a utility's *people* into it.

Which makes one thing a requirement rather than a nicety: **the
read-only view is a shop window, so it has to look like the product.**
A stripped-down viewer that reads as a report attachment wastes the
only chance the offer has to be a demo.

- **MOD-V-1 (Must).** A **Study Viewer** preset role: read a study, its
  scenarios, its comparison and its traces. Nothing else — no tariff
  editing, no subject import, no scenario runs, and no sight of any
  other study.

- **MOD-V-2 (Must).** **A viewer is scoped to studies, and the check
  goes in the query.** The hazard is specific: a consultant's tenant
  holds several clients' studies (§6), and granting a viewer
  `studies:VIEW` would let one utility read another's rate study —
  commercially the worst thing this product could do.

  This is the customer portal's problem exactly, and gets the portal's
  answer. Portal routes carry the ownership check in the query
  (`requireCustomerId` plus `customerId` in the `where`) rather than
  relying on RBAC, *because* a permission that says "may read studies"
  cannot say "may read **this** study". A miss is a **404, not a 403**:
  whether another utility's study exists is not this caller's to learn.

- **MOD-V-3 (Must).** Access is a **join table**
  (`ModelStudyViewer`: study, user), not a column on `cis_user`.

  *Why not mirror `CisUser.customerId`, which is the precedent:* a
  portal user belongs to exactly one customer for life, so a column
  fits. A utility reviewing studies has several over time — this year's
  and last year's — and several people, the finance director and the
  city engineer. A column would mean a second login for the same person
  to see the second study, which is the friction §6 rejected for
  consultants and is no more acceptable here. One person, several
  studies, one login.

- **MOD-V-4 (Must).** A viewer sees **no customer identity**, which is
  already true by construction: MOD-S-5 refuses a mapping onto a name,
  email, phone or address, so a subject carries none. Worth stating
  because it is the question a utility's counsel will ask before
  issuing logins, and the honest answer is that the data was never
  loaded.

- **MOD-V-5 (Should).** The consultant controls when a study becomes
  visible. A study in progress is not a deliverable, and a client
  watching the numbers move while assumptions are still being argued is
  worse for the consultant than no access at all. A published-to-client
  flag, dated and audited, with the same reasoning as a rate schedule's
  `publishedAt`: the dates decide when something applies, publishing
  decides whether it may be seen.

- **MOD-V-6 (Should).** The viewer's nav is the Modeling section with
  the write items absent — the same mechanism as MOD-T-3, which gates
  per item on module and permission, so a read-only role produces a
  read-only menu without a second nav table.

## Relationship to spec 26 (electric demand and TOU)

Rao noted on 2026-11-02 that **TOU and demand may be built before this
module.** That changes nothing structural and the sequencing is free,
because the dependency is one-way:

- Water, sewer, stormwater and solid waste need **nothing** from spec
  26. They price on a quantity over a period, which the engine does
  today.
- Electric demand needs interval data, demand ratchets, coincident peak
  and a TOU calendar — all of which are spec 26's to design and none of
  which this module should invent. `reservation_charge` is the nearest
  existing kind and is not demand.
- If spec 26 lands first, this module gains electric at launch for the
  cost of extra canonical fields on the usage loader. If it lands
  second, electric modelling arrives with it. Either order works.

**The one thing to hold:** if demand is built first, its components must
be written against the same `rate(ctx)` surface. An electric engine that
lives beside the existing one is the anti-goal above, and the cheapest
moment to prevent it is before spec 26 is implemented, not after.

## Relationship to spec 28 (the legacy CIS overlay)

Same market, adjacent offers, and they should share:

- **The tariff configuration is the shared asset.** An overlay tenant
  configures its tariffs in Rate Model v2 as a full tenant does
  (OVL-R-1), and so does a modelling tenant. A consultant's study
  should be convertible into an overlay pilot's tariff set without
  re-entry.
- **Shadow-rating is a scenario run.** OVL-S-1 rates the legacy
  system's pre-bill register and reports the variance — the same
  operation as comparing two scenarios, with the legacy bill standing
  in for one of them. The variance report should be one implementation.
- **The operating modes are one axis.** `FULL`, `OVERLAY`, `MODEL`, on
  the column shipped on 2026-11-02, with one conversion action.
- **Where they differ:** an overlay tenant mirrors real customers,
  premises, meters and accounts, and its reads are real. A modelling
  tenant has none of those and must not acquire them.

## Open questions

1. **Pricing is undecided** — likely per seat *and* per study (Rao,
   2026-11-02). It stays open because it is commercial rather than
   structural, with one consequence already taken: subject count is not
   a billing unit, so the runner can be sized for honesty rather than
   for metering, and a 144,000-subject study is an ordinary act.
2. **Does a client viewer ever become a buyer's account?** When a
   utility converts — to an overlay pilot or a full tenant — the people
   who reviewed the study already have logins in the *consultant's*
   tenant. Whether those identities move, are re-created, or simply
   lapse is unresolved, and it is the one place the land-and-expand path
   touches identity rather than data.

## Suggested slices

| Slice | Delivers | Unblocks |
|---|---|---|
| 1 | `MODEL` operating mode, Rate Consultant preset role, the Modeling nav section, the audit log (MOD-T-1 – 5), **and the MOD-C-2 tariff-scoping decision** | A tenant that cannot bill anybody and says so |
| 2 | `ModelSubject`, the `model_usage` import kind, the subject list (MOD-S-1 – 5) | A usage file in, with no hierarchy |
| 3 | `POST /rate-preview` and the single-subject rater with its trace (MOD-P-*, MOD-U-2, MOD-U-3) | The demo, and the first thing worth selling |
| 4 | `ModelScenario`, `ModelResult`, the runner, comparison and aggregates (MOD-R-*) | A rate study |
| 5 | The PDF report through the bill PDF stack, assumptions, study copy, and the shared variance report with spec 28 §4 (MOD-U-4, MOD-R-5, MOD-C-3) | A council paper |
| 6 | The client's read-only view: Study Viewer role, per-study access, publish-to-client (MOD-V-*) | The utility sees the product while reviewing its own rates |

Slice 3 is the one to build first if the sequence is ever in doubt: it
is the shortest path to something demonstrable, and it is the part the
rest exists to scale.
