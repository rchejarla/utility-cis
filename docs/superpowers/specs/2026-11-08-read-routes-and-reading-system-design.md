# Read routes and the reading-system capability — design

**Date:** 2026-11-08
**Becomes:** `docs/specs/30-read-routes.md`
**Status:** design, nothing built
**Settles:** Req 78 ("read cycle scheduling and read route grouping"), which today
maps to a one-line claim in spec 08 line 429 — `BillingCycle +
ServiceAgreement.read_sequence (Phase 1)` — that is not true of the code.

---

## 1. Intent

A meter reading is the only input billing cannot compute for itself, and today
this system can receive one but has no idea where it came from or in what order
anybody collected it. Two capabilities follow from that gap, and they are the
same capability seen from two sides.

**Ingesting from a reading system.** Bozeman's reads are authoritative in a
system we do not own (Reqs 75, 76). What arrives is a file or an API payload of
numbers. Those numbers were collected in a route order by somebody walking a
street, and the vendor knows the route. We throw that away, so we cannot answer
"route W-04 came in short by six stops" — the most ordinary question in a
utility's reading week.

**Being a reading system.** A utility too small to own a reading system needs
one. That is not a Bozeman feature; it is what makes this product sellable to a
town that keeps its routes in a spreadsheet today. For that utility we own the
route, the order, the printed sheet and the entry screen.

The connective tissue is the route, which is why one nullable `route_id` on
`meter_read` serves both: ingesting, the route travels in with the read; reading,
it is the route the read came off. One column, two modes.

The modes are not symmetric, and §5.4 is where that bites: when we own the route
we also own its membership, and when a vendor owns it we can only infer
membership from what has arrived. That is one branch, in one place, for one
honest reason.

### Why now

Three things already shipped that only make sense with this in place:

- `GET /api/v1/meter-reads/progress` (`reading-progress.service.ts`) answers "how
  far along is this cycle's reading" — a cycle-wide number. A reading week is
  worked route by route, so the screen that exists cannot be worked from.
- `BillingCycle.readDayOfMonth` is required and documented as "the day meter
  reads are expected to be complete by". The deadline exists; the unit of work it
  applies to does not.
- `ServiceAgreement.read_sequence` is **write-only**. It is settable through the
  importer, the API, the agreement page, and carried through transfer, and
  nothing in the codebase orders or groups by it. It is the stub of this feature,
  pointed at the wrong entity.

---

## 2. Goals, non-goals, anti-goals

### Goals

1. A read arriving from anywhere can say which route it came from.
2. A utility can define routes as ordered lists of stops and maintain them.
3. A reader can be handed a printed sheet in route order.
4. Somebody can type a day's sheet in, in the sheet's order, with the keyboard
   only, and have a wild number stop them at the row rather than at the bill.
5. A stop that produced no number records **why**, in a form billing's existing
   estimation design (spec 08 rule 3, Req 96) can consume.
6. Reading progress is answerable per route, not only per cycle.
7. Req 78 has a real mapping.

### Non-goals

- **Handhelds, mobile, offline.** Rao's call: "assume clipboard for now." No
  service worker, no sync, no conflict resolution. This is the single largest
  piece of scope removed, and it is removed on purpose — a utility that later
  wants devices gets a second phase, not a redesign, because the sheet and the
  entry screen are already the same ordered worklist.
- **Building estimation.** Spec 08 rule 3 already specifies it (trailing
  three-month average, capped at two consecutive cycles) and Req 96 is scheduled
  for Phase 3. This work produces the *reason* a read is missing, which is
  estimation's input. It does not produce the estimate.
- **Reader assignment and crew management.** One or two people in a truck. The
  printed sheet has a blank reader line. Assignment arrives with the field
  client, where it first means something — §6.2.
- **Route optimisation.** A route's order comes from geography and the utility
  already knows it. We do not compute, suggest, or improve it.
- **Serving a third party's handheld.** "CIS as a reading system" was settled
  with Rao as meaning CIS does the field work for a small utility, not that CIS
  exposes a worklist for someone else's device to consume.

### Anti-goals — this has failed even if it ships

- **A route becomes a second billing cycle.** If route membership starts deciding
  *when* an account bills, there are now two answers to that question and they
  will disagree. The cycle decides billing. The route decides reading.
- **A skipped stop silently becomes a zero.** A zero read bills zero and then
  double next period. `2026-10-14-billing-run-design.md` already refuses this and
  names estimates as the answer. Nothing here may produce a `consumption = 0` row
  to stand in for an absence.
- **Route membership becomes the place service lives.** Premises, agreements and
  meters already describe service. A route is an itinerary over them, and if it
  starts being authoritative about anything else it has become a shadow data
  model.

---

## 3. Constraints

- **Vendor credentials never land here** (CLAUDE.md). A reading-system
  integration is an apptor-connect connector: `proxy` when we pull, `events` when
  they push, `files` for SFTP drops. The tenant setting names *which integration*,
  never a URL, key, bucket or region.
- **Prisma `migrate dev` is forbidden** against this schema. Keys between two
  tenant-scoped tables are composite `(utility_id, fk) -> parent (utility_id,
  id)` and live in SQL, as do partial indexes and CHECKs.
- **`meter_read` is a TimescaleDB hypertable** partitioned on `read_datetime`,
  with a composite PK `[id, readDatetime]`. Adding a column is fine; a unique
  constraint that omits the partition column is not.
- **RLS**: every new table is tenant-scoped, FORCEs RLS, has a policy, and is
  declared in `schema-invariants.integration.test.ts`.
- **`meter_read.consumption` is NOT NULL** and a CHECK keeps `reading` and
  `prior_reading` together. A read with no number is not representable, which is
  what forces §5.3.
- **Reads freeze once billed** (`billed_at`, `READ_FROZEN`). Anything this work
  writes against a billed read must respect that.

---

## 4. What the field work looks like

Established with Rao, and shown as mockups he approved
(`.superpowers/brainstorm/463-1794162288/content/route-sheet-and-entry.html`).

A route is a physical sequence of stops — 1 Main, then 3 Main, then round the
back of 5. The order comes from geography, so it is stable year to year, and the
reader does not choose it. A route is read on a schedule tied to billing: the
accounts on it bill together.

The reader takes a printed sheet, works down it in order, writes a number at each
stop, and codes the ones they could not do — locked gate, dog, buried under snow,
dial unreadable, obstructed, appears vacant, no meter found. Those codes matter
as much as the numbers, because they are what somebody has to chase before the
bill runs.

That afternoon somebody types the sheet in, in the sheet's order. The screen is
the sheet, plus the two things paper cannot do: it knows each meter's own history
so a wild number stops at the row, and it knows which stops are still blank.

**Mine, not Rao's, and strikeable:** the specific code list, the meter-size
column, the "typical range" shown beside the entry field, four pages of 48 stops,
and the rule that a route posts as a whole rather than row by row.

**Already struck:** the mockup's sheet header reads *"read window 11–15 Jan
2026"*. There is no five-day read window anywhere in this system and I invented
it. See §5.11 — the header carries the cycle's read day instead.

---

## 5. The parts that are decided

### 5.1 A route is an ordered list of premises

**`ReadRoute`** — *an ordered list of places a meter reader visits.*

| Field | Type | Notes |
|---|---|---|
| `utility_id` | uuid | FK to `utility` |
| `code` | varchar(50) | `W-04`. Unique per tenant. |
| `name` | varchar(255) | `North Willson` |
| `billing_cycle_id` | uuid | **Required.** A route with no cycle has no day its reads are due. |
| `origin` | varchar(20) | `LOCAL` \| `EXTERNAL`, by CHECK. See §5.4. |
| `active` | boolean | |

**`ReadRouteStop`** — *one place on a route, and where in the order it comes.*

| Field | Type | Notes |
|---|---|---|
| `utility_id` | uuid | |
| `read_route_id` | uuid | |
| `premise_id` | uuid | |
| `sequence` | int | Unique per `(utility_id, read_route_id)` |

**The stop is a premise, not a service point and not an agreement.** A reader
walks to a house and reads whatever is there; two meters at one address are one
stop. `Premise` is the only durable physical thing in the schema — it carries
`geo_lat`/`geo_lng`, and `Meter.premise_id` points at it directly. `ServicePoint`
carries `service_agreement_id`, so it is per-contract and dies when the contract
does; sequencing on it would renumber the route every time somebody moves out.
That is also why `ServiceAgreement.read_sequence` was wrong: an agreement is a
contract, not a place.

**Stops are current-state, not effective-dated.** A new house is inserted at a
sequence and that is the route from then on. History lives in the reads, which
carry their own route and date. Effective-dating a stop would buy the ability to
reprint a sheet exactly as handed out eighteen months ago, which nobody has
asked for and which costs a date-range join on the hottest query in the feature.

**A stop whose account is on a different cycle still prints.** `Account.billing_cycle_id`
is required and nothing makes it agree with the route's, so the case is real.
The sheet prints **every** stop on the route regardless of cycle, because a stop
filtered off a sheet is a meter nobody visits — the worst available outcome, and
silent. Per-route progress is scoped by stops alone, never by stops ∩ cycle, so
the sheet and the count are the same set. The route page lists stops whose
account cycle differs as a data-quality list; it is not a validation error, and
route maintenance is not coupled to cycle changes. *(My call. The reviewer
flagged that the required `billing_cycle_id` plus "the accounts on it bill
together" implied a rule nobody had written.)*

**Routes are not commodity-scoped, and that is a decision.** The reviewer
pointed out that `Premise.commodity_ids` is an array, and a utility with water
*and* electric reads two route systems on separate schedules — so a nullable
`commodity_id` on the route is cheap now and a migration plus four query
rewrites later. I am still leaving it out: no named utility needs it (Bozeman's
sewer, stormwater and refuse all derive from the water meter, so one route
system covers it), and CLAUDE.md is explicit that future flexibility is not a
justification. **Revisit when** a tenant reads two commodities on separate
schedules — that changes `read_route`'s unique key, stop uniqueness, the sheet's
row set and the progress join together, so it is one coherent change rather
than creeping.

### 5.2 `meter_read.route_id`

Nullable uuid, composite FK to `read_route`. NULL means "we do not know", which
is every row written before this ships and every read from a vendor who does not
send a route. No backfill.

Written by: the importer (§5.4), `POST /api/v1/meter-reads`, and route entry.

### 5.3 A stop that produced no number

**`ReadSkip`** — *a meter the reader could not read, and why.*

| Field | Type | Notes |
|---|---|---|
| `utility_id` | uuid | |
| `meter_id` | uuid | Required |
| `read_route_id` | uuid? | NULL when the skip did not come off a route |
| `read_date` | date | |
| `skip_reason` | varchar(50) | `LOCKED_GATE`, `DOG`, `BURIED`, `UNREADABLE`, `OBSTRUCTED`, `APPEARS_VACANT`, `NO_METER_FOUND`, by CHECK |
| `notes` | text? | |
| `reader_id` | uuid? | |
| `resolved_at` | timestamptz? | See below |

Partial unique index on `(utility_id, meter_id, read_date)` — one skip per meter
per day.

**`resolved_at` is written in the read-create path, not by a sweep.** When a read
is written for a meter that has an open skip inside the same window (§5.11), that
skip is resolved in the same transaction. A nightly sweep would be a new
`scheduler_config` definition, and CLAUDE.md requires anything added from now on
to default to **disabled** — so the column would resolve nothing for any tenant
until somebody turned it on, which is how it becomes the write-only column §5.8
exists to remove. One place writes reads; that is where this belongs. *(My call.
The reviewer noted the original wording named no writer at all.)*

**Why this is not a `meter_read` row.** `consumption` is NOT NULL and a CHECK
binds `reading` to `prior_reading`. There is no honest way to write "no number"
into that table, and the dishonest way — zero — is explicitly refused by the
billing-run design.

**Why this is not a `MeterEvent`.** Spec 08's Phase 2.5 register-skip path does
put skips in `meter_event`, with `NO_SIGNAL` or `METER_DEFECT`. That is right
there and wrong here: a broken register is a fact about the device, and
`meter_event` holds device facts — `LEAK`, `TAMPER`, `BURST_PIPE`,
`BATTERY_LOW`. A locked gate says nothing about the meter. Adding `LOCKED_GATE`
to `MeterEventType` would put an access problem in the device's health record,
where a dashboard counting meter events would then report a dog as a meter fault.
It also costs an enum value Postgres cannot remove.

**`skip_reason`, not `skip_code`, and those seven values** — spec 08 already says
`skipReason` with `OUT_OF_SERVICE | INACCESSIBLE | DEFECTIVE` for registers. Same
word, different vocabulary, because these are access reasons and those are device
reasons. The two sets deliberately do not merge.

**What consumes it.** Nothing in this work. Billing's refusal
(`NO_READ_IN_WINDOW`) stands unchanged — a skip does not make an account
billable. The skip is the record that lets the Outstanding Reads screen say *why*
instead of just *missing*, and it is the input Req 96's estimation will read when
it is built. Writing it now and consuming it later is deliberate: the reason is
only capturable at the moment of the visit, and it is lost if we wait.

### 5.4 A vendor's route code becomes a route row

This is the question that had to be settled before any migration: is `route_id`
a key to something we own, or free text from a vendor? It cannot be both.

**It is always a key.** The importer upserts a `read_route` by `(utility_id,
code)` when it meets a route code it does not know, with `origin = EXTERNAL` and
no stops. An external route is a real row with a real id that reads can point at,
a name, and a cycle; it simply has no itinerary, because the itinerary belongs to
the vendor.

`origin` is what keeps the two modes from contaminating each other: the route
editor refuses to add stops to an `EXTERNAL` route, and the sheet cannot be
printed for one. Without the flag, somebody sequences a vendor's route by hand
and now two systems believe they own the order.

`billing_cycle_id` on an auto-created external route is the cycle of the first
read's account, which is a guess the route page shows as unconfirmed.

**An external route's membership is learned from its reads.** This is the hole
the reviewer found, and it was a real one: §1 sells the ingest half on *"route
W-04 came in short by six stops"*, and a route with no stops has no denominator
to be short against. The answer is not to give external routes stops — that
hands the itinerary to two owners, which is the whole point of `origin`. It is
that for an `EXTERNAL` route, the expected set is **the meters whose most recent
read carried this `route_id`**. The vendor owns the itinerary; we observe it, and
last month's observation is this month's expectation.

So `getReadingProgress` branches exactly once, on `origin`, to produce the
expected meter set — stops for `LOCAL`, prior reads for `EXTERNAL` — and shares
everything downstream. A route in its first ever cycle has no prior reads and so
reports received-only, which is honest: nobody can be short against a list that
has never existed. *(My call.)*

### 5.5 Ingest

- **File.** `packages/api/src/imports/handlers/meter-read.ts` gains an optional
  `routeCode` canonical field (aliases `^route$`, `^routecode$`, `^book$`,
  `^routeid$` — "book" because that is what older systems call it). Unknown code
  → external route per §5.4. The handler already resolves the agreement, computes
  consumption and writes the audit row; this is one field and one upsert.

  **Those aliases are a guess and stay provisional until a real export is in
  hand** (§9). If the vendor's column is named something else, or there is no
  route column at all, the upsert never fires and the ingest half ships inert
  while looking complete. Until a sample is mapped, Req 76 is **not** claimed as
  covered for routes.
- **API, for our own callers.** `POST /api/v1/meter-reads` accepts `routeCode`.
  Same resolution. This is the existing route behind a user's token.

- **API, for an outside reading system.** Rao's call, 2026-11-09: *"I feel still
  we need to expose API to populate `meter_read`."* Req 76 says "secure **APIs**
  or file interfaces", so a file-only answer is a partial one, and the
  alternative is not cheaper — a vendor pushing to apptor-connect's `events`
  plane still needs a drain worker doing exactly what this handler does, plus a
  queue hop. A file import also cannot hand an integrator a per-row error while
  they are still debugging their column mapping.

  **It is exposed as a batch import, not a single-row write.** A reading system
  sends a day or a route, not one read. `POST /api/v1/imports/meter-read`
  creates an `ImportBatch` with `source = API`, runs the rows through the same
  `meter_read` handler the file path uses, and returns the batch id plus per-row
  results. That inherits validation, staging, audit, the agreement resolution,
  consumption computation, per-row rejection reporting and a receipt the caller
  can re-fetch — none of which a bare row write has. `ImportBatchSource` already
  admits `API`, so this was anticipated.

  **The real work is machine authentication, and it does not exist.**
  `middleware/auth.ts` populates exactly one of `request.user` or
  `request.platformActor`, and both are `CisUser` rows. There is no machine
  principal, no API key, no service account. Admitting a vendor without one
  means minting a person's token and handing it over — a shared credential
  carrying a human's permissions, with that human's name on every audit row.
  **This endpoint must not ship before a machine credential exists**, and that
  credential is the design work, not the route.

  Two candidate shapes, and this design does not pick between them:

  1. A per-tenant API credential we issue, stored here as a hash, scoped to one
     module and permission (`meter_reads:CREATE`), revocable, rate-limited, and
     identified in `audit_log` as itself rather than as a person.
  2. OAuth2 client credentials through apptorID, which is available in this
     environment but **is not currently integrated** — CLAUDE.md states auth is
     NextAuth.js with JWT.

  **This does not contravene CLAUDE.md's credential rule, and the direction is
  why.** That rule forbids *this codebase holding a vendor's secret*. A
  credential **we issue to them, to call us**, is the opposite direction: ours to
  mint, rotate and revoke, and only its hash is stored. Outbound calls to a
  vendor's API are unchanged and still go through apptor-connect's `proxy`
  plane, which holds their secret and never hands it out.

- **Pull or push through apptor-connect.** Still the right rail for a vendor who
  prefers it, and for SFTP drops: `proxy` when we pull, `events` when they push,
  `files` for a drop. Out of scope to build here. Offering an API does not
  replace this — it means a utility's own IT can post a file's worth of reads
  without a connector being onboarded first.

### 5.6 Printing the sheet

Server-rendered PDF, streamed to the browser, **not persisted**. A route sheet is
scrap paper — it is reprintable from the stops any time, and the reads are the
record. Bill PDFs persist because a bill is a financial document; this is not.
That also keeps it clear of the storage-integration question entirely.

### 5.7 Entry

One screen per `(route, read date)`. Rows in `sequence` order, in the row set of
§5.12. `Enter` saves the row and moves down. A skip reason moves past a stop
without a number.

**Nothing posts to `meter_read` until the route is submitted.** A half-typed
sheet is not a reading event, and a billing run that caught one mid-entry would
bill some of a route and skip the rest.

**A saved row is staged server-side, in the existing import staging tables.**
The reviewer was right that "`Enter` commits the row" and "nothing posts until
submit" cannot both be true without saying where the row lives in between, and
that client-only state loses forty stops when somebody closes the tab. It is
also right that this problem is already solved in the tree: `ImportBatch` +
`ImportRow` stage `raw_data` as `PENDING` and commit as a whole, and
`ImportBatchSource` already admits `API`, so a batch that came from no file is a
modelled thing. Entry opens one batch per `(route, read date)`, writes an
`ImportRow` per keystroke-committed row, and submit runs the existing commit
path through the `meter_read` handler — which already resolves agreements,
computes consumption, writes audit rows, and reports per-row rejections.

This is **not** the route-run table §6 refused. That was a new per-route-per-day
entity with its own lifecycle and screens; this is a draft store that exists for
every import kind already, carrying no opinion about routes. It also means a
clerk resumes tomorrow, two clerks can split a route, and a rejected row reports
itself the same way a file's would. *(My call. The builder must confirm the
framework admits a batch opened without an uploaded file; if it does not, the
fallback is a draft table of three columns, not a run.)*

**What makes a number wild — I had this wrong.** §5.7 originally claimed it
reused `computeConsumption`'s existing exception detection. That detection does
not exist: `computeConsumption` only reacts to a reading *below* its prior
(`ROLLOVER`, `METER_DEFECT`, `REVERSE_FLOW`), there is no high-usage producer
anywhere in `packages/api/src`, and `ExceptionThreshold` (Req 93) is unbuilt. So
the mockup's `typical 22–34` had nothing behind it.

The hold-the-row behaviour is goal 4 and the main thing the screen buys over
paper, so it stays — computed in the entry service from the meter's own trailing
reads, as a **provisional local rule**, stated as such. It is a second opinion
about what is wild, which §5.7 was right to be wary of; the resolution is not to
pretend otherwise but to name it: **when Req 93's `ExceptionThreshold` lands, the
band comes from there and this rule is deleted.** Pulling Req 93 forward into
this work would be a module, and shipping with only a reversed dial stopping the
row lets a 3× read through silently. *(My call, and the one most worth
overriding if the scope matters more than the behaviour.)*

### 5.8 `ServiceAgreement.read_sequence` is removed

Not deprecated in place. A write-only column named `read_sequence` reads as if
sequencing works — and it is the thing a builder would reach for when asked to
order a route.

Seven sites, not the four I first counted (the reviewer found the last three):
the importer's canonical field (`imports/handlers/service-agreement.ts`), the
validator (`shared/src/validators/service-agreement.ts`), the agreement page
field (`web/app/service-agreements/[id]/page.tsx`), the service itself
(`api/src/services/service-agreement.service.ts`),
`shared/src/lib/custom-fields.ts:561`, the transfer carry-through in
`api/src/services/workflows.service.ts:152`, and
`service-agreement-import.integration.test.ts`. Plus the column. This product
reseeds rather than backfills, so there is no migration of values. Spec 05 and
spec 08 both describe it and both get corrected.

### 5.9 Progress becomes per-route

`reading-progress.service.ts` already computes expected/read/outstanding from the
window and shares `computeBillPeriod` with the planner, and after the 2026-11-08
window fix it mirrors the run exactly. It gains an optional `readRouteId` filter
and a per-row `route` and `skipReason`. No second implementation — the one that
mirrors the run stays the only one.

### 5.10 Permissions

Everything lands in the existing `meter_reads` module. Route maintenance is
`EDIT`, entry is `CREATE`, sheets and progress are `VIEW`. No new RBAC module:
the people who read meters and the people who manage reads are the same
two people at this size of utility.

### 5.11 One window, and it is the cycle's

The reviewer counted three different things called "the window" in the first
draft, one of which I made up. There is one: **the cycle's bill period, from
`computeBillPeriod`** — the same window `reading-progress.service.ts` measures
and the billing run plans against, which after the 2026-11-08 window fix is a
single shared definition in `billing-run/window.ts`. `ReadSkip` resolution
(§5.3) and per-route progress (§5.9) both key off it.

`BillingCycle.read_day_of_month` is a **day, not a span** — the day reads are due
complete. The sheet header prints it as a due date ("reads due 15 Jan"). The
five-day "read window 11–15 Jan" in the approved mockup has no source in this
system and is struck; if a utility later wants routes staggered across a reading
week, that is a per-route read day, and it is not in this work.

### 5.12 Which meters are a row at a stop

The sheet's rows and per-route `expected` must be the **same predicate** or the
counts never reconcile. One definition, used by both:

Meters reached from the stop's premise through `ServicePointMeter → ServicePoint
(premise_id)` with the assignment open at the read date, where
`Meter.meter_type` is `MANUAL` or `AMR`, and `Meter.status` is `ACTIVE`. One row
per **active register**, not per meter.

Each clause earns its place:

- **`MANUAL` or `AMR`, never `AMI`.** An AMI meter needs no visit —
  `reading-progress.service.ts` already excludes meters with intervals, and a
  sheet listing them is how a reader learns to ignore the sheet. AMR is drive-by
  and does belong on a route.
- **`ACTIVE` only.** `DEFECTIVE` and `PENDING_INSTALL` are not stops.
- **Through `ServicePoint`, not `Meter.premise_id`.** Both columns exist, and the
  service-point path is the one that guarantees an agreement resolves. Going via
  `Meter.premise_id` prints rows whose `resolveServiceAgreementId` throws
  `METER_NOT_ASSIGNED` at submit — and because the route posts as a whole, one
  such row fails the sheet.
- **Per register.** Multi-register is already built:
  `createMeterRead` rejects a single-reading payload when a meter has two or more
  active registers, and the event path wants every register or an explicit
  per-register skip. One row per meter cannot express that. The approved mockup
  has no multi-register example and so does not contradict this; the printed
  sheet needs a register label on those rows.

*(All my call, from the reviewer's findings. The register point is the one most
likely to surprise: it means the sheet is not simply one line per address.)*

---

## 6. The structure I refused, and why

Per CLAUDE.md's checklist, the pattern this feature invites is a **route run**
table — one row per (route, date), with a child row per stop capturing its
outcome. It is the obvious shape, it is what a "billing run" looks like one
module over, and I am not building it.

**The simple version:** stops are the worklist, reads are the output, skips are
the absences. "12 of 48 entered" is a count of reads with that `route_id` in the
window — the same shape `reading-progress.service.ts` already computes without
any worklist table.

**What the run table would buy:** reprinting a sheet exactly as it was handed
out, including stops since removed from the route.

**Whether that condition holds:** no. Nobody asked for it, the paper itself is
the artefact of record on the day, and the reads carry their own route and date.
The cost is a third table on the hottest path in the feature plus a lifecycle
(open, submitted, abandoned) with its own screens and its own stale-run problem.

**If it ever earns its keep:** when a utility needs to prove which stops were on
a sheet on a given day for a dispute. Add it then, against that case — or when
the field client arrives, which is §6.2.

### 6.1 Should reading be a separate service?

Asked by Rao on 2026-11-08, before any migration existed. The answer is no, and
the reasons are worth keeping because the question will come back.

**The data cannot leave.** A route sheet is a join over premise, meter,
register, service point, agreement, account, billing cycle and last read — most
of this system. A separate reading service would either mirror that graph, and
spec 28 is the standing record of what mirroring costs, or call back on every
screen. It would also have to re-implement tenant isolation, which here is a
non-owning Postgres role plus RLS plus AsyncLocalStorage, not an application
filter that travels.

**CLAUDE.md's checklist says the same.** The conditions that justify a service
boundary — a second consumer, an independent release cadence, a separate team,
isolation from a slow or flaky dependency — none hold. There is one consumer.

**The client is a different matter, and it should leave.** See §6.2.

**The option is already bought, and it was free.** §5.7 sends route entry in
through the same door as an import: staged as `ImportRow`, committed through the
`meter_read` handler. If reading ever becomes its own product, it posts that
same payload from outside instead of inside. The extraction seam is the ingest
contract, which exists because the reviewer pushed on draft persistence — not
because anybody designed for extraction.

**What would change the answer is commercial, not technical:** selling the
reading system to a utility that does not buy CIS. It would then need its own
premise and meter registry and it is a product, not a module. That is the same
question spec 29 asks about the rate engine, and it should be answered the same
way for both or neither.

### 6.2 Reconciling with `bozeman/02`'s `MeterReadRoute`

**There is already a route design in this repo and it is not compatible with
this one.** `docs/bozeman/02-mobile-and-responsive-ui.md` §3.4 (FR-MOB-T3-002)
and §4 declare a `MeterReadRoute` model for field-technician route assignment.
Four substantive conflicts:

| `bozeman/02` §4 | This design | Why this one wins *for now* |
|---|---|---|
| `meterIds String[]` — membership as a uuid array on the route | `read_route_stop` rows, premise-keyed | An array cannot be joined, indexed, or constrained per tenant, and keying on meters means a meter swap edits the route. §5.1. |
| No sequence column; order is array order | `sequence` int, unique per route | Order is the whole point of a route, and array position is not a value you can insert into. §5.1. |
| `scheduledDate` + `status` (`SCHEDULED`/`IN_PROGRESS`/`COMPLETED`/`CANCELLED`) | No run entity | This *is* the route-run table §6 refused, and for the clipboard phase it buys nothing. |
| `technicianId` | No assignment | Rao's clipboard decision: one or two people in a truck. §2 non-goals. |

It also assumes the offline mobile app, which Rao scoped out.

**The reconciliation.** This design supersedes `bozeman/02` §4's
`MeterReadRoute` block, and `bozeman/02` keeps everything else — the `/field/*`
segment, the `Field Technician` role, the photo, GPS, barcode and signature
capture, the offline route pack, the bundle budget.

When the field client is built, it builds on `read_route` and
`read_route_stop` rather than introducing a second route table. **Assignment and
the run arrive with it, not before**, because that is where they first mean
something: a technician syncs a pack at the start of a shift, and "what was on
your device this morning" is a fact that has to be recorded rather than derived.
That is precisely the case §6 named as earning the run table back, so the two
decisions are the same decision seen at two phases.

Practical consequence for `bozeman/02`: its `MeterReadRoute` block is struck and
points here, and its FR-MOB-T3-002 route view reads stops instead of a uuid
array. Its `MeterRead` additions (`captured_photo_id`, `gps_lat`, `gps_lng`) are
untouched by this work and stay with the field client.

---

## 7. Requirement mapping

| Req | Story | Where it lands |
|---|---|---|
| 75 | Meter reading system is the authoritative source | Unchanged (spec 08). This adds route provenance to what arrives. |
| 76 | Integrate via secure APIs or file interfaces | Both doors (§5.5): the file importer, and `POST /api/v1/imports/meter-read` as a batch import for an outside system. The API half is **gated on a machine credential that does not exist** — it must not ship behind a person's token. Transport via apptor-connect stays available. **Route provenance stays provisional** until a real export is mapped (§9). |
| 78 | Read cycle scheduling and read route grouping | **This spec.** Grouping: `read_route` + `read_route_stop`. Scheduling: the route's cycle and that cycle's `read_day_of_month`. Replaces the `ServiceAgreement.read_sequence` claim at spec 08 line 429, which was never true. |
| 96 | Estimation and substitution rules for missing reads | Not built here. `ReadSkip` is its input. |

---

## 8. What is left to the builder

- Migration SQL by hand (`migrate diff`, read line by line): three tables, the
  `route_id` column, composite tenant-scoped FKs, CHECKs on `origin` and
  `skip_reason`, the partial unique index on `read_skip`, RLS policies, and the
  `schema-invariants` declarations.
- Whether `read_route_stop` needs an index beyond `(utility_id, read_route_id,
  sequence)` — depends on whether the entry screen joins from stops to meters or
  the reverse. Measure it.
- The PDF generator. Any server-side renderer already in the tree wins over a new
  dependency.
- Resequencing UX. Inserting at 23 into a 48-stop route cannot renumber 25 rows
  per keystroke. Gapped integers or a fractional key — builder's call, it is
  invisible from outside.
- How a premise with no stop surfaces. A tray of unsequenced premises on the
  route page is the obvious shape and is not specified here.
- `readerId` on an imported read is currently `ctx.actorId` — whoever ran the
  import, not whoever read the meter. The sheet names a reader, so entry could
  record them properly. Worth fixing while in here; not required by anything.

---

## 9. Open for Rao

**One question survived the builder check as genuinely his, and it is answered.**

*Is there a sample export from Bozeman's meter reading system, and does it carry
a route or book column?* **No sample exists** (Rao, 2026-11-08), and the guessed
aliases stand: *"your invention is fine for now."*

So the §5.5 mapping is **decided and provisional**, which is this project's
standing way of handling a gap only a customer can close. Two things follow, and
both are commitments rather than notes:

1. **Req 76 is not claimed as covered for route provenance** until a real export
   has been mapped. The requirement table says so.
2. **When an export arrives, the mapping is verified against it** before that
   claim changes — the aliases are checked against the real header, and a file
   whose route column matches none of them must be shown to produce no silent
   success. An alias list that quietly matches nothing is indistinguishable from
   a working one, which is the specific failure this guards.

Building the local half — routes, stops, the sheet, entry, skips — does not
depend on any of it.

**A second question is now open, and it is also his.**

*Which machine credential does the inbound API use?* Rao decided on 2026-11-09
that an API to populate `meter_read` must be exposed (§5.5). That is settled;
how a caller authenticates is not, and it is the only part of this design that
cannot be settled by a builder, because it commits the product to an auth
direction well beyond meter reads:

1. **A per-tenant API key we issue** — small, self-contained, hash stored here,
   scoped to `meter_reads:CREATE`, revocable, and attributable in `audit_log`.
   It is also a second authentication mechanism to maintain forever.
2. **OAuth2 client credentials through apptorID** — the right long-term shape if
   this product is heading there anyway, and it is available in this
   environment. But it **is not currently integrated** (CLAUDE.md: auth is
   NextAuth.js with JWT), so this endpoint would be the first caller, and it
   would carry the cost of that integration.

**Either way the endpoint does not ship behind a `CisUser` token.** That is not
a preference — it puts a person's name on a vendor's audit rows and gives a
vendor a person's permissions.

The nine-question builder check is otherwise settled in place; each answer is
marked in its own section as my call. The ones most worth a second look, because
they changed what gets built:

- §5.7 — the trailing-history band for wild readings. I had claimed existing
  detection that does not exist. The behaviour stays as a provisional local rule
  that Req 93 deletes.
- §5.7 — entry stages through `ImportBatch`/`ImportRow` rather than holding a
  half-typed sheet in the browser.
- §5.12 — one row per **register**, not per meter, and AMI meters never print.
- §5.4 — an external route's expected set is learned from last cycle's reads.
