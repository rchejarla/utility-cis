# Read Routes

**Module:** 30 — Read Routes
**Status:** Phase 2 — schema, route and stop maintenance, the shared row predicate, route provenance on imported reads, skips and their healing, per-route progress, the printed sheet and server-side entry are all built and tested. The HTTP surface and the three screens land with the UI work. Route provenance on *ingest* stays provisional until a real vendor export is mapped (see **Open items**).
**Entities:** ReadRoute, ReadRouteStop, ReadSkip (plus `MeterRead.route_id`)
**Design:** `docs/superpowers/specs/2026-11-08-read-routes-and-reading-system-design.md` — this spec is that document rewritten as what is true.

## Overview

A meter reading is the only input billing cannot compute for itself, and
until this module existed the system could receive one but had no idea
where it came from or in what order anybody collected it. A **read route**
is the unit of work a reading week is actually worked in: an ordered list
of the places a reader visits, tied to the billing cycle whose accounts
those reads will bill.

The same column serves two capabilities that are the same capability seen
from two sides.

- **Being a reading system.** A utility too small to own one needs the
  route, the walking order, the printed sheet and the entry screen. We own
  all four: `origin = LOCAL`.
- **Ingesting from a reading system.** Bozeman's reads are authoritative in
  a system we do not own (Reqs 75, 76). The vendor knows the route; the
  read arrives carrying its code, and that code becomes a row so there is
  something to count, filter and report short against: `origin =
  EXTERNAL`.

`origin` is what keeps the two from contaminating each other. A vendor's
import cannot write reads onto an itinerary maintained here, and nothing
here can hand-sequence a route whose order the vendor decides.

Two things a route is **not**. It is not a second billing cycle — the cycle
decides when an account bills, the route decides when it is read, and
nothing about route membership changes a bill. And it is not where service
lives: premises, agreements and meters already describe service, and a
route is an itinerary over them.

Primary users: the one or two people who read meters at this size of
utility, and the clerk who types the day's sheet in afterwards.

## Entities

### ReadRoute

An ordered list of places a meter reader visits.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope (RLS enforced, FORCEd) |
| code | VARCHAR(50) | `W-04`. Unique per tenant (`read_route_utility_id_code_key`) |
| name | VARCHAR(255) | `North Willson` |
| billing_cycle_id | UUID | **Required** FK → BillingCycle. A route with no cycle has no day its reads are due |
| origin | VARCHAR(20) | `LOCAL` \| `EXTERNAL`, by CHECK `read_route_origin_known` |
| active | BOOLEAN | Default true |
| created_at / updated_at | TIMESTAMPTZ | |

**Keys.** `(utility_id, billing_cycle_id) -> billing_cycle (utility_id, id)`
`ON DELETE RESTRICT`, so a route cannot name another tenant's cycle. A
second unique on `(utility_id, id)` exists only to be the parent of the
tenant-scoped keys below.

**Index:** `(utility_id, billing_cycle_id)`.

### ReadRouteStop

One place on a route, and where in the order it comes.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| read_route_id | UUID | FK → ReadRoute, `ON DELETE CASCADE` |
| premise_id | UUID | FK → Premise, `ON DELETE RESTRICT` |
| sequence | INTEGER | Gapped integers, step 100 |
| created_at | TIMESTAMPTZ | |

**A stop is a premise, not a service point and not an agreement.** A reader
walks to a house and reads whatever is there, so two meters at one address
are one stop. `Premise` is the only durable physical thing in the schema;
`ServicePoint` carries `service_agreement_id`, so it is per-contract and
would renumber the route every time somebody moved out.

**Three uniques, each doing a different job:**

- `read_route_stop_sequence_key` on `(utility_id, read_route_id, sequence)`,
  **DEFERRABLE INITIALLY IMMEDIATE**, for the bulk resequence rule 2
  describes. It behaves exactly as an immediate constraint until a
  transaction asks otherwise.
- `read_route_stop_premise_key` on `(utility_id, read_route_id, premise_id)`
  — a reader cannot visit one address at two sequence numbers on one route.
- `read_route_stop_one_route_per_premise_key` on `(utility_id, premise_id)`
  — a premise belongs to **at most one route anywhere**. A second route
  claiming it would invite the double visit ordering exists to prevent.

**Stops are current state, not effective-dated.** A new house is inserted
at a sequence and that is the route from then on. History lives in the
reads, which carry their own route and date.

### ReadSkip

A meter the reader could not read, and why.

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | PK |
| utility_id | UUID | Tenant scope |
| meter_id | UUID | FK → Meter, `ON DELETE CASCADE` |
| read_route_id | UUID | Nullable FK → ReadRoute, `ON DELETE SET NULL`. Null when the skip did not come off a route |
| read_date | DATE | |
| skip_reason | VARCHAR(50) | `LOCKED_GATE`, `DOG`, `BURIED`, `UNREADABLE`, `OBSTRUCTED`, `APPEARS_VACANT`, `NO_METER_FOUND`, by CHECK `read_skip_reason_known` |
| notes | TEXT | Nullable |
| reader_id | UUID | Nullable |
| resolved_at | TIMESTAMPTZ | Nullable: set when a read for that meter lands in the same window |
| created_at | TIMESTAMPTZ | |

**Partial unique index** `read_skip_one_open_per_meter_day` on
`(utility_id, meter_id, read_date) WHERE resolved_at IS NULL` — one open
skip per meter per day, so a sheet submitted twice writes once. Prisma
cannot express it; it lives in the migration.

**Index:** `(utility_id, read_route_id, read_date)` — a route's day, for
the report.

**Why it keys on a meter while a stop keys on a premise.** The grains
differ on purpose: a stop says *where to go*, a skip says *what was not
read*. A skip is the absence of a read, so it keys like a read —
`meter_read` carries `meter_id` and no `premise_id` either, and both
consumers (billing's `NO_READ_IN_WINDOW` refusal and Req 96's estimation)
work per meter. Two consequences, both load-bearing:

- **One locked gate writes several rows.** Nobody got through the gate, so
  every meter at that address is unread. That is a display problem, solved
  by grouping on `Meter.premise_id` in the query; ungrouped, one gate reads
  as three problems.
- **Resolution is per row**, which is what happens when somebody gets the
  front meter but not the one round the back.

**There is deliberately no `register_id`.** An access skip fails every
register at once. The per-register case is spec 08's Phase 2.5 path
(`{ registerId, skipReason }` with `OUT_OF_SERVICE | INACCESSIBLE |
DEFECTIVE`, recorded as a `MeterEvent`) — that one is a device fact and
belongs there. The two vocabularies deliberately do not merge.

**Why not a `meter_read` of zero, and why not a `MeterEvent`.**
`meter_read.consumption` is NOT NULL and a CHECK binds `reading` to
`prior_reading`, so "no number" is not representable there — and the
dishonest way, zero, bills zero and then double next period, which the
billing-run design explicitly refuses. `meter_event` holds device facts
(`LEAK`, `TAMPER`, `BATTERY_LOW`); a locked gate says nothing about the
meter, and putting it there would make a dashboard count a dog as a meter
fault.

### MeterRead.route_id

Nullable UUID, composite FK to `read_route` `ON DELETE SET NULL`, index
`(utility_id, route_id)`. **No unique constraint** — the hypertable
requires `read_datetime` in every one.

NULL means "we do not know", which is every row written before this shipped
and every read from a vendor who sends no route. **There is no backfill.**

**One writer: the `meter_read` import handler** — which both doors go
through. A file row names a route by `routeCode` and the handler resolves
it (rule 4); a route-entry row carries a resolved `routeId` in its staged
`raw_data` and the handler takes it as given, checking only that it is this
tenant's. `createMeterRead` — the single-read API behind
`POST /api/v1/meter-reads` — does **not** accept a route, so a read taken
that way still says NULL. The design intended it to; see open item 5. See
spec 08's `MeterRead` table for the rest of the column.

## Which meters are a row at a stop

The sheet's rows, the entry screen's rows and per-route `expected` are
**one predicate**, in one place — `services/read-route/readable-rows.ts`,
`readableRowsForPremises(utilityId, premiseIds, onDate)`. Three callers,
none of which re-derives it. If they each asked the question themselves
they would eventually disagree, and the place that shows is in front of the
person holding the paper: the sheet has 41 lines and the screen says 40 to
go.

A row is a meter reached from the stop's premise through
`ServicePointMeter → ServicePoint (premise_id)` with the assignment open at
the read date, where `meter_type` is `MANUAL` or `AMR` and `status` is
`ACTIVE` — **one row per active register**, or one row with a null register
for a meter that has none.

Each clause earns its place:

- **`MANUAL` or `AMR`, never `AMI`.** An AMI meter needs no visit, and a
  sheet listing them is how a reader learns to ignore the sheet. AMR is
  drive-by and does belong on a route.
- **`ACTIVE` only.** `DEFECTIVE` and `PENDING_INSTALL` are not stops.
- **Through `ServicePoint`, not `Meter.premise_id`.** Both columns exist,
  but only the service-point path guarantees an agreement resolves. A meter
  found by its own premise column with no open assignment would print, then
  fail at submit with `METER_NOT_ASSIGNED` — and because the route posts as
  a whole, that one row fails the sheet.
- **Per register.** Multi-register is already built: `createMeterRead`
  rejects a single-reading payload when a meter has two or more active
  registers. One row per meter could not express it. **So the sheet is not
  one line per address**, which is the thing most likely to surprise.

A meter reassigned on the day it left its old service point is open at both
on that day. The winner is the latest `addedDate` across **all** of that
meter's open assignments, with no premise filter — the same rule
`resolveServiceAgreementId` applies, so a stop's answer does not depend on
what else was in the call.

## API Endpoints

All under the existing `meter_reads` module: **no new RBAC module**, because
the people who read meters and the people who manage reads are the same two
people at this size of utility.

The services behind every one of these are built and tested; the route file
itself lands with the UI work (Task 9 step 4 of the plan was skipped, and
the gap was found when the screens went to call them). So the table is the
settled contract rather than a description of running code — the one place
in this spec where that is true.

| Method | Path | Permission |
|--------|------|------------|
| GET | `/api/v1/read-routes` | VIEW |
| POST | `/api/v1/read-routes` | EDIT |
| GET | `/api/v1/read-routes/:id` | VIEW |
| PATCH | `/api/v1/read-routes/:id` | EDIT |
| GET | `/api/v1/read-routes/:id/stops` | VIEW |
| POST | `/api/v1/read-routes/:id/stops` | EDIT |
| DELETE | `/api/v1/read-routes/:id/stops/:stopId` | EDIT |
| GET | `/api/v1/read-routes/:id/unsequenced` | VIEW |
| GET | `/api/v1/read-routes/:id/sheet` | VIEW — streams a PDF |
| GET | `/api/v1/read-routes/:id/progress` | VIEW |
| POST | `/api/v1/read-routes/:id/entry` | CREATE — opens or re-opens the day's sheet |
| PATCH | `/api/v1/read-routes/:id/entry/:batchId/rows` | CREATE |
| POST | `/api/v1/read-routes/:id/entry/:batchId/submit` | CREATE |
| POST | `/api/v1/read-routes/:id/entry/reopen` | CREATE — body `{ readDate }` |

`reopen` takes a **read date, not a batch id**:
`reopenEntryForCorrections` finds the batch from `(routeId, readDate)`
itself, and a caller that had to know the batch id would have to open the
entry to learn it.

**There is no resequence endpoint.** `SEQUENCE_FULL` tells a caller to
resequence the route and nothing offers a way to; see open item 6.

The `meter_read` **import kind** accepts `routeCode` (rule 4). The
single-read API does not — open item 5.

### Error codes

| Code | HTTP | Means |
|------|------|-------|
| `ROUTE_CODE_TAKEN` | 409 | A route with that code already exists for this tenant |
| `CYCLE_NOT_FOUND` | 404 | The billing cycle is missing or another tenant's |
| `ROUTE_NOT_FOUND` | 404 | |
| `ROUTE_IS_EXTERNAL` | 400 | Its stops, sheet and entry are the vendor's business, not ours |
| `ROUTE_IS_LOCAL` | 409 | An import may not write reads onto an itinerary maintained here |
| `PREMISE_ALREADY_ON_ROUTE` | 409 | On this route, or on another one |
| `PREMISE_NOT_FOUND` / `PREMISE_NOT_ACTIVE` | 404 / 400 | A demolished or pending address is not a stop |
| `SEQUENCE_FULL` | 409 | No integer fits between two neighbours; resequence the route |
| `STOP_NOT_FOUND` | 404 | |
| `METER_ALREADY_READ` | 409 | A skip says no number exists, and one does |
| `METER_NOT_ASSIGNED` | 400 | The meter has no agreement on that date |
| `METER_NOT_FOUND` | 404 | |
| `READ_SKIP_CYCLE_UNSUPPORTED` | 501 | A non-monthly cycle has no read window yet |
| `ENTRY_NOT_FOUND` | 404 | No entry was opened for that route and day |
| `ENTRY_CLOSED` | 409 | The sheet has been submitted; correct it instead |
| `ENTRY_ROW_NOT_FOUND` | 404 | That meter is not a row of this sheet |
| `ENTRY_ROW_AMBIGUOUS` | 400 | A row is a reading or a code for why there is none, not both |
| `INVALID_READING` | 400 | A reading is a number, zero or more |
| `READ_BILLED` | 400 | The meter already has a billed read in the period |
| `ENTRY_NOTHING_TO_CORRECT` | 409 | The sheet posted cleanly, so there is nothing to reopen |

`NOT_ENTERED` is not an HTTP code: it is the per-row `errorCode` on a staged
row nobody typed anything against, so submit can say what it left out.

### Audit events

`read_route.created`, `read_route.updated`, `read_route_stop.created`,
`read_route_stop.deleted`, `read_skip.created`. A route created by the
importer is audited with `actorName: "Import"` and a null actor.

## Business Rules

1. **One window, and it is the cycle's.** Every date question in this
   module — which window a skip falls in, which reads a route's progress
   counts, which period a frozen read belongs to — is answered by
   `windowContaining(cycle, day)` over `computeBillPeriod`, the same
   definition the billing run plans against. `BillingCycle.read_day_of_month`
   is a **day, not a span**: the day reads are due complete. There is no
   five-day read window anywhere in this system.

2. **Sequences are gapped integers, step 100.** An append is `max + 100`;
   an insert between `a` and `b` takes `floor((a + b) / 2)`, so placing a
   stop writes one row and leaves every neighbour where it was. When no
   integer fits, the insert is refused with `SEQUENCE_FULL` and the caller
   resequences the route — which is its own operation, not a side effect of
   an insert, **and is not built** (open item 6). Both stop writes lock the
   route row `FOR UPDATE` first, or two concurrent appends pick the same
   sequence.

   The sequence unique is **DEFERRABLE INITIALLY IMMEDIATE** so that the
   resequence, when it is written, can be one statement:
   `UPDATE … SET sequence = sequence + 1 WHERE sequence >= $2` passes
   through duplicates the end state does not contain, and a per-row unique
   refuses that mid-statement. It behaves exactly as an immediate
   constraint until a transaction says `SET CONSTRAINTS … DEFERRED`. The
   trade, known rather than discovered later: a deferrable constraint
   cannot back `ON CONFLICT`, and nothing upserts on this key.
   `read_route_stop_premise_key` stays immediate, because one address twice
   on a route is never a legal intermediate state.

3. **A stop whose account is on a different cycle still prints.**
   `Account.billing_cycle_id` is required and nothing makes it agree with
   the route's, so the case is real. The sheet prints **every** stop on the
   route regardless of cycle, because a stop filtered off a sheet is a meter
   nobody visits — the worst available outcome, and silent. Per-route
   progress is scoped by stops alone, never stops ∩ cycle, so the sheet and
   the count are the same set. The route page lists mismatched stops as a
   data-quality list; it is not a validation error.

4. **A vendor's route code becomes a route row.** The `meter_read` import
   kind carries an optional `routeCode` canonical field (aliases `^route$`,
   `^routecode$`, `^book$`, `^routeid$` — "book" because that is what older
   systems call it). Resolution happens once per distinct code, not per row:
   an existing `EXTERNAL` route is used; an unknown code is created as
   `EXTERNAL` with no stops, its cycle taken from the first read's account
   and shown on the route page as unconfirmed; and a code naming a `LOCAL`
   route **rejects the row** with `ROUTE_IS_LOCAL`, because a vendor file
   writing onto our own itinerary would look like our own route had been
   read. The insert is `ON CONFLICT … DO UPDATE SET code = code` so two rows
   naming the same new code cannot poison the transaction.

5. **An EXTERNAL route's membership is learned from its reads.** The route
   has no stops — the vendor owns the walk — so for per-route progress the
   expected set is **the meters whose most recent read carried this
   `route_id`**. Last month's observation is this month's expectation. A
   route in its first ever cycle has no prior reads and reports
   received-only, which is honest: nobody can be short against a list that
   has never existed. `getReadingProgress` branches exactly once, on
   `origin`, to produce the expected set, and shares everything downstream
   with the cycle-wide path.

6. **A skip is refused when the meter already has a read in the window**
   (`METER_ALREADY_READ`), because a skip asserts that no number exists. The
   check is per meter against that meter's own cycle window, so a meter on
   another cycle is never judged by this route's dates. A meter already
   skipped open on that day is left as it is — not duplicated, not reworded.

7. **A skip heals in the read-create path, not in a sweep.** When a read is
   written for a meter with an open skip in the same window, that skip is
   resolved in the same transaction — from `createMeterRead`, the
   multi-register event path and the import handler. Deliberately **not**
   from `correctMeterRead`, which replaces a read that already resolved
   whatever it was going to. `resolveSkipsForRead` must never throw: it runs
   inside the read's transaction, and healing a skip is a convenience, never
   a precondition for recording a number — so a cycle with no window
   resolves nothing and returns zero.

8. **Nothing posts to `meter_read` until the route is submitted.** A
   half-typed sheet is not a reading event, and a billing run that caught
   one mid-entry would bill some of a route and skip the rest.

9. **A saved row is staged server-side, in the existing import tables.**
   Entry opens one `ImportBatch` per `(route, read date)` —
   `entityKind: "meter_read"`, `source: "API"`, `fileName: null` — with one
   `ImportRow` per readable register, and submit runs the existing commit
   path through the `meter_read` handler. Which route and day a batch is for
   lives in `import_batch.mapping` (`{ kind: "read-route-entry", routeId,
   readDate }`): a batch has no column for either, and adding two to a table
   every import kind shares would be a schema change for the sake of one.
   The clerk can stop and resume tomorrow, two clerks can split a route, and
   a rejected row reports itself exactly as a file's would.

10. **Submit is idempotent on the batch's own status.** One conditional
    `UPDATE` claims a `PENDING` batch; whoever loses that claim, and every
    later call, is handed the stored counts and writes nothing. Without it a
    double-click or a retried request would post a second read per stop and
    double next period's consumption.

11. **A coded row never reaches `processBatch`**, which would reject it for
    having no number. Coded rows are held back as `SKIPPED` and recorded
    through `recordSkips` — for only those meters with **no reading anywhere
    in the batch**. `read_skip` has no register column, so a stop where one
    register was read and another coded is a *read* meter: the reason for the
    unread register stays on its row rather than being invented into a skip.
    Rows nobody typed anything against are `SKIPPED` with `NOT_ENTERED`.

12. **Skips are recorded one meter per call**, though `recordSkips` takes a
    list. It refuses the whole call when any one meter already has a read in
    the window, and a real sheet groups naturally — ten `LOCKED_GATE` codes
    with no notes are one reason — so a single meter read off-route earlier
    in the window would otherwise cost every skip batched with it. One
    refusal has to cost one stop.

13. **Entry refuses a number behind a posted bill.** A meter with a billed
    read in the window is refused at the keyboard with `READ_BILLED`, because
    that is a mistake to catch at the row rather than at submit. Submit checks
    again, per row, because billing can run between the two — and a row
    refused there goes `ERROR` while its neighbours still post.

14. **A refused stop is corrected, not retyped.**
    `reopenEntryForCorrections` puts the batch and its `ERROR` rows back to
    `PENDING` and leaves `IMPORTED` and `SKIPPED` rows exactly as they are.
    That is also what prevents a re-post: `processBatch` selects `PENDING`
    rows and nothing else, which is the same mechanism rule 10 rests on, so
    no second guard was added. It admits only a batch holding at least one
    `ERROR` row — a sheet that posted cleanly has nothing to correct, and
    reopening one could not be told apart from posting it twice.

15. **An entry batch must never be driven through the generic imports
    paths.** Every guard above sits *above* `processBatch`, so the imports
    Retry button or the zombie sweep's re-enqueue would post the readings
    with none of them. `entrySheetOf(batch)` is how those two recognise one.

16. **The sheet is not persisted.** It is scrap paper, reprintable from the
    stops at any time, and the reads that come back are the record. A bill
    PDF is stored because a bill is a financial document; this is not one, so
    there is no storage key, no attachment row, and no storage-integration
    question. A sheet for an `EXTERNAL` route is refused outright
    (`ROUTE_IS_EXTERNAL`): it would print an empty page and imply we knew the
    stops.

    **The header prints a due date, not a span**: the cycle's
    `read_day_of_month` in the month the containing window ends in, since a
    read day precedes a bill day (BR-BC-001). `billDayIn` clamps a day the
    month lacks, so a read day of 31 is the 28th in February. It is null for
    a cycle whose frequency has no window yet, and the stops still print —
    that `computeBillPeriod` only windows MONTHLY is a fact about bills and
    no reason to refuse a sheet. The approved mockup's *"read window 11–15
    Jan"* was struck: there is no five-day read window anywhere in this
    system. A per-route read day, for routes staggered across a reading
    week, would be a different feature.

17. **A stop that produced no line is reported, never dropped.**
    `buildRouteSheet` returns `stopsWithNothingToRead` alongside the rows —
    stops whose premise has no readable meter, which is what a premise whose
    service ended mid-window looks like. They are kept off the paper (a
    reader sent to an address with nothing to read is worse) but handed to
    whoever serves the sheet, because a stop vanishing without a trace is the
    silent failure rule 3 forbids.

18. **The last reading on a sheet is the one before the sheet's date**, so a
    sheet reprinted after some stops were read still shows what the reader is
    comparing against rather than what they just wrote down. A meter with
    exactly one register also matches reads that named no register, since
    `createMeterRead` allows those.

19. **`listStops` answers `[]` for an EXTERNAL route while
    `listUnsequencedPremises` throws.** The pair differs on purpose: "what
    are its stops" is a fair question whose honest answer is "none here", and
    a screen should show that; offering a tray of premises to add to such a
    route is meaningless. Do not wire the two as parallel.

20. **The tray is premises on no route at all**, not premises missing from
    this route. A reader visits an address once, so a premise belongs on
    exactly one route, and offering one already on another route would invite
    a double visit. Only `ACTIVE` premises are offered, because only those
    can be added.

## UI Pages

### Read Routes list (`/read-routes`)

Routes with their cycle and stop count, filterable by cycle, origin and
active. An `EXTERNAL` route is marked as the vendor's and offers no sheet.

### Read Route detail (`/read-routes/:id`)

Stops in sequence order with their addresses; insert and remove; the tray of
premises on no route; a data-quality list of stops whose account is on
another cycle (rule 3); print the sheet; open entry for a date. No
resequence control, because there is nothing behind one yet (open item 6).

### Route entry (`/read-routes/:id/entry`)

The sheet, plus the two things paper cannot do: it knows each meter's own
history, so a wild number stops at the row, and it knows which stops are
still blank. Keyboard first — one numeric field per row, `Enter` saves and
advances, the skip reason reachable without the mouse. Progress reads
entered-of-total. Submit posts the route as a whole and reports what landed;
a refused row is corrected in place and the sheet resubmitted.

### Reading Progress (`/meter-reads/progress`)

Gains a route filter and, per row, the route code and the skip reason behind
an outstanding read — so the screen can say *why* instead of just
*missing*. See spec 08.

## Open items

Six. The first four are carried forward from the design and unchanged by
building it; the last two are gaps **found while writing this spec**, by
checking each claim against the code rather than against the plan.

1. **The import column aliases are a guess.** No sample export from
   Bozeman's reading system exists (Rao, 2026-11-08: *"your invention is
   fine for now"*). So the mapping is **decided and provisional**, and two
   commitments follow. Req 76 is **not** claimed as covered for route
   provenance until a real export has been mapped. And when one arrives the
   aliases are checked against its real header, and a file whose route
   column matches none of them must be shown to produce no silent
   success — an alias list that quietly matches nothing is indistinguishable
   from a working one, which is the specific failure this guards.

2. **The outlier band is a provisional local rule.** What makes a number
   wild is computed in the entry service from the meter's own trailing
   reads. There is no existing high-usage detection to reuse:
   `computeConsumption` reacts only to a reading *below* its prior
   (`ROLLOVER`, `METER_DEFECT`, `REVERSE_FLOW`), and `ExceptionThreshold`
   (Req 93) is unbuilt. **When Req 93 lands the band comes from there and
   this rule is deleted.** It is marked as such in the code.

3. **The inbound vendor API is gated on a machine credential that does not
   exist.** Rao decided on 2026-11-09 that an API to populate `meter_read`
   must be exposed, and the shape is settled — `POST
   /api/v1/imports/meter-read`, a batch import with `source = API` running
   the same handler the file path uses, returning the batch id and per-row
   results. What is not settled is how a caller authenticates.
   `middleware/auth.ts` populates exactly one of `request.user` or
   `request.platformActor` and both are `CisUser` rows: there is no machine
   principal. **This endpoint must not ship behind a person's token** — it
   would hand a vendor a human's permissions and put that human's name on
   every audit row. Two candidate shapes, undecided: a per-tenant API
   credential we issue and store as a hash, scoped to `meter_reads:CREATE`;
   or OAuth2 client credentials through apptorID, which is available in this
   environment but not currently integrated. Either is ours to mint and
   revoke, so neither contravenes the rule that no vendor credential lands
   in this codebase.

4. **The field client builds on these tables, and brings assignment and the
   run with it.** This design supersedes `docs/bozeman/02-mobile-and-
   responsive-ui.md` §4's `MeterReadRoute` block, which keyed membership to
   a uuid array with no sequence column and carried a scheduled-date and
   status lifecycle. `bozeman/02` keeps everything else — the `/field/*`
   segment, the `Field Technician` role, photo, GPS, barcode and signature
   capture, the offline route pack, the bundle budget — and its route view
   reads stops instead of an array. Assignment and the per-day run arrive
   with that client, not before, because that is where they first mean
   something: "what was on your device this morning" is a fact that has to
   be recorded rather than derived.

5. **The single-read API carries no route code, though the design said it
   would.** Design §5.5 names two doors for our own callers — the file
   importer and `POST /api/v1/meter-reads` — and only the first was built.
   `createMeterReadSchema` has no `routeCode` or `routeId` field, so a read
   typed in at `/meter-reads/new`, or posted by one of our own scripts,
   lands with `route_id` NULL even when the person knows the route. Nothing
   that ships is wrong because of it: NULL means "we do not know", which is
   honest, and route entry is how a read off a route is meant to arrive.
   But it is a stated intent that is not true of the code, which is exactly
   the kind of claim this module exists to stop making — see
   `ServiceAgreement.read_sequence` below. The fix is one optional field on
   the create schema, resolved as the importer resolves it, with the
   `ROUTE_IS_LOCAL` question answered the other way round: a person typing
   a read **may** name a local route, because that is the route they
   walked.

6. **`SEQUENCE_FULL` names a recovery nobody can perform.** When no integer
   fits between two stops, `addStop` refuses with 409 `SEQUENCE_FULL` and a
   message telling the caller to resequence the route — and there is no
   resequence service function and no endpoint. The database is ready for
   it (rule 2: the sequence unique is deferrable precisely so the bulk
   `UPDATE` can be one statement) but the operation was never written, so
   the only way out today is removing stops and re-adding them, which
   renumbers the part of the route nobody was trying to change. It takes
   about seven insertions between one pair of stops to exhaust the gap, so
   a real route reaches it eventually rather than soon. It is listed
   because an error message naming an impossible fix is worse than one that
   says nothing.

## What was deliberately not built

**A route-run table** — one row per `(route, date)` with a child row per
stop capturing its outcome. It is the obvious shape and it is what a billing
run looks like one module over. The simple version is what shipped: stops
are the worklist, reads are the output, skips are the absences, and "12 of
48 entered" is a count of reads carrying that `route_id` in the window. The
run table would buy reprinting a sheet exactly as it was handed out,
including stops since removed — which nobody asked for, and which costs a
third table on the hottest path plus an open/submitted/abandoned lifecycle
with its own screens and its own stale-run problem. Add it against a real
dispute, or when the field client arrives (open item 4), which is the same
decision seen at two phases.

**Reading as a separate service.** A route sheet is a join over premise,
meter, register, service point, agreement, account, cycle and last read —
most of this system. A separate service would either mirror that graph
(spec 28 is the standing record of what mirroring costs) or call back on
every screen, and would have to re-implement tenant isolation, which here is
a non-owning Postgres role plus RLS plus AsyncLocalStorage rather than an
application filter that travels. There is one consumer. The extraction seam
exists anyway and was free: entry already posts the same payload an import
does, so if reading ever becomes its own product it posts that payload from
outside instead of inside.

**`ServiceAgreement.read_sequence` is removed**, not deprecated in place. It
was write-only — settable through the importer, the API, the agreement page
and carried through transfer, and nothing in the codebase ordered or grouped
by it. A column named `read_sequence` that does nothing reads as if
sequencing works, and it is exactly what a builder would reach for when
asked to order a route. It was also pointed at the wrong entity: an
agreement is a contract, not a place. Route order lives in
`read_route_stop.sequence`. Specs 05 and 08 both described it and both are
corrected.

## Dev-seed fixture rules

Two facts about the dev seed that any route, fixture or browser test has to
respect. They are rules about fixtures, not limitations of routes.

- **A route must not include the tenant's first-created premise.**
  `seed/tou-service.js:138` attaches `TOU-REG-001` and `TOU-REG-002` to
  `premise.findFirst({ orderBy: { createdAt: "asc" } })` — 742 Evergreen
  Terrace in today's seed, but the rule follows premise creation order, not
  that address. Both are `AMR` with four active dials each, so with the two
  register-less meters already there one stop yields **ten rows**. That part
  is correct: a reader at an address with two four-dial meters does read
  eight dials. The hazard is that typing numbers into them through route
  entry writes `meter_read` rows over the TOU reconciliation fixture, whose
  invariant is that one meter's dials sum to its total while the other's
  fall 15 kWh short. A fixture for one feature must not quietly rewrite
  another's.

- **`EM-003` is `AMR`.** The base seed calls it "the multi-register test
  fixture" (`seed.js:814`) while creating it as `AMI` — and AMI is excluded
  from every sheet by design, so the seed's only two-register meter could
  never appear on one. `packages/api/scripts/seed-read-route-scenarios.ts`
  flips it, which makes the seed match its own stated purpose. Six AMI
  meters remain, `WM-003` among them at that same premise, which turns that
  premise into the fixture for the rule the sheet rests on: the AMR meter's
  two registers print, the AMI meter prints nothing.

**The scenario seeder** is `packages/api/scripts/seed-read-route-scenarios.ts`,
run as `cd packages/api && npx tsx --env-file=.env
scripts/seed-read-route-scenarios.ts`. Additive and idempotent, so it runs
against a database somebody is already working in. It builds one `LOCAL`
route of eight stops whose rows cover each shape and refusal above, and one
`EXTERNAL` route with no stops. Every date-bound fact it writes is placed in
the window `windowContaining` puts today in, never on a literal date, so the
fixture keeps meaning what it says whenever it is run.

## Phase Roadmap

- **Phase 2 (Complete):**
  - `read_route`, `read_route_stop`, `read_skip`, and `meter_read.route_id`,
    with tenant-scoped composite keys, both CHECKs, the deferrable sequence
    unique, the two premise uniques, the partial unique on open skips, and
    RLS FORCEd with a `tenant_isolation` policy on all three — declared in
    `schema-invariants.integration.test.ts`
  - Route and stop maintenance, including gapped-integer insertion, the
    unsequenced tray, and `upsertExternalRoute` for a vendor's code
  - `readableRowsForPremises` — the one predicate, shared by three callers
  - `routeCode` on the `meter_read` import kind, with the `LOCAL` refusal
  - `recordSkips` and `resolveSkipsForRead`, healing in the read-create path
  - Per-route reading progress, branching once on `origin`
  - The printed sheet (`@react-pdf/renderer`, no new dependency) and
    `stopsWithNothingToRead`
  - Server-side entry: open, save a row, submit as a whole, reopen for
    corrections — staged in `ImportBatch`/`ImportRow`
  - `ServiceAgreement.read_sequence` removed from seven sites and the column
  - A scenario seeder, and a Playwright journey over the sheet and entry

- **Phase 2 (With the UI work):**
  - The HTTP surface above, and the three screens

- **Phase 3 (Planned):**
  - Estimation consuming `ReadSkip` (Req 96) — this module produces the
    reason; it does not produce the estimate
  - `ExceptionThreshold` (Req 93) replacing the provisional outlier band
  - The inbound vendor API, behind a machine credential (open item 3)
  - The field client, with assignment and the run (open item 4)
  - Outstanding Reads grouped on `Meter.premise_id`, so one locked gate
    reads as one problem

## Bozeman RFP Coverage

| Req | Requirement | Coverage |
|-----|-------------|----------|
| 75 | Meter reading system is the authoritative source | Unchanged (spec 08). This adds route provenance to what arrives |
| 76 | Integrate via secure APIs or file interfaces | File importer: `routeCode` on the `meter_read` kind. API half designed and **gated on a machine credential that does not exist** (open item 3). **Route provenance stays provisional** until a real export is mapped (open item 1) |
| 78 | Read cycle scheduling and read route grouping | **This spec.** Grouping: `read_route` + `read_route_stop`. Scheduling: the route's cycle and that cycle's `read_day_of_month`. Replaces the `ServiceAgreement.read_sequence` claim in specs 05 and 08, which was never true |
| 96 | Estimation and substitution rules for missing reads | Not built here. `ReadSkip` is its input, and the reason is only capturable at the moment of the visit |
