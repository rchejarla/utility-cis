# 26 — Time-of-Use Rates

**Status:** proposed, 2026-10-29 (revised the same day: time zone and
clock basis per calendar, interval timestamp basis, where the calendar
attaches). Nothing in this spec is built.

**Audience:** whoever builds TOU into the rate engine, meter reading and
billing. Read [07b — Rate Model v2](07b-rate-model-v2-design.md) first;
this spec fills the TOU slots that design left open and corrects one of
them.

**Why now:** TOU is the gate to electric utilities (municipal electric,
co-ops, public power) for both the full CIS and the stand-alone rate
engine offer. Water, sewer, stormwater and solid waste rating are built
and tested; electric is not reachable until this ships.

---

## The problem

A TOU tariff prices energy by *when* it was used, not only by how much:
for example, 4–9 pm on summer weekdays costs three times what midnight
does. To bill it, the system must know four things it does not know today:

1. **The calendar** — which hours, on which days, in which season, belong
   to which TOU period (on-peak, mid-peak, off-peak, …), including
   holidays and daylight saving time.
2. **When the energy was used** — either interval data (kWh per 15, 30 or
   60 minutes) or a meter that already splits its total into TOU
   registers.
3. **How to bucket usage** into periods for a service period.
4. **How to price each bucket**, and print it on the bill.

## What exists today

| Piece | State |
|---|---|
| `tou_window` predicate (`evaluators/predicate.ts:47`) | In the grammar; **throws** `UnsupportedInSlice3Error` |
| `tou_window_filter` transform (`grammar-introspection.ts:72`) | Listed, `supported: false` |
| `interval_pricing` pricing type | "Proposed-when-needed" in 07b; not built |
| Seasons | **Hard-coded**: `seasonOf()` in `rate-engine/period.ts` returns summer for May–Oct, judged on the period's *start date* only. Not tenant-configurable. |
| `MeterRead` | TimescaleDB hypertable keyed on `read_datetime`, with `register_id`, `read_type` `AMI`, `read_source` `AMI`. Holds register reads, not interval consumption series. |
| `MeterRegister` | Multiple registers per meter, each with UoM, multiplier and `measure_type_id`. No link to a TOU period. |
| `intervalReadRetentionDays` tenant setting | Exists; nothing reads it (gap analysis §5 item 1) |
| `meter:reads:<id>` loader | **Corrected 2026-11-02:** there is no `intervals` field. The loader moved to `lib/rate-engine-loaders/loaders/meter-loader.ts` and its return type declares none, so slice 2 adds the slot as well as the data — one step earlier than this table claimed. TOU-ENG-2's parenthetical is corrected below |
| `indexed` pricing | **Built.** So a fuel or power-cost adjustment per kWh, driven off `rate_indices`, is already expressible — a real part of an electric tariff that needs no design |
| `peak_demand`, `ratchet`, `power_factor`, `load_factor` | All listed `supported: false` beside `tou_window_filter`. **None has a spec.** Demand and power factor are what make commercial and industrial electric accounts billable, and this spec scopes them out deliberately — see *What electric still needs* |
| Reference tariff | [07c — NorthWestern Energy](07c-northwestern-energy-rate-reference.md) RSGTOUD-1 (residential TOU + demand pilot); shapes only, no extracted prices |

## Scope

**In:** TOU energy charges (per-kWh price by TOU period and season),
from either TOU registers or interval data; configurable seasons;
holiday calendars; the data needed to bill and model them; bill, portal
and modeling presentation.

**Out, each its own spec:** demand charges, on-peak demand and ratchets
(they need the interval data built here, but not the TOU pricing);
critical peak pricing and event days (the calendar must leave room —
TOU-CAL-9); real-time / hourly pricing (`interval_pricing`); net metering
of exported energy by TOU period; gas or water TOU.

Requirements are numbered for traceability. **Must** is required for the
first TOU bill; **Should** is required before selling TOU as a feature.

---

## 1. Seasons

The current hard-coded season is wrong for TOU and too crude for
existing seasonal tariffs, so seasons become configuration first.

- **TOU-SEA-1 (Must).** A tenant defines named seasons as month/day
  ranges that repeat every year, may wrap the year end (Nov 1 – Mar 31),
  and together cover every day of the year exactly once. Overlaps and
  gaps are refused at save time with the dates named.
- **TOU-SEA-2 (Must).** Season sets are effective-dated and published
  like rate schedules; a published set is immutable.
- **TOU-SEA-3 (Must).** The existing `season` predicate reads the
  tenant's configured seasons instead of `seasonOf()`. A migration seeds
  every existing tenant with today's behaviour (summer = May 1 – Oct 31,
  winter otherwise), and every existing golden test (`bozeman-*`) passes
  unchanged.
- **TOU-SEA-4 (Must).** For TOU, the season is decided **per interval**
  (by the interval's local start time), not per service period. A bill
  spanning Oct 15 – Nov 14 rates October usage at summer prices and
  November usage at winter prices.
- **TOU-SEA-5 (Should).** For the non-TOU `season` predicate, the tenant
  chooses how a period spanning two seasons is decided — by start date
  (today's behaviour, the default), by majority of days, or by prorating
  the component across both. Recorded on the season set.
- **TOU-SEA-6 (Must; built 2026-11-03).** Publishing a set must name the
  **published TOU calendars keyed on a different one**, before the
  button is pressed and again in the response.

  A TOU calendar names its season set explicitly and a published one is
  immutable, so it keeps those seasons for ever — that is TOU-CAL-10 and
  it is correct. Non-TOU charges do not: `load-base.ts` takes whichever
  published set is in force for the period. So from the day a new set
  takes effect, one customer's water bill follows the new boundaries
  while their TOU electric bill keeps the old ones. **Both are right by
  their own rules and nothing else in the system compares them**, which
  is what makes this a screen's job rather than a validation rule: it
  cannot be refused, because the state is legitimate. What is not
  legitimate is a tenant not knowing.

  Reported on the editor (`calendarsOnOtherSets`) rather than only on
  the publish response, because a warning that arrives after an
  irreversible step is a post-mortem. Draft calendars are left out —
  they have priced nothing — and so is a calendar keyed on the set being
  published, since reporting agreement would train people to ignore the
  warning.

  The matching refusal is on the other side: a season **code** a
  calendar's hours reference cannot be removed or renamed
  (`SEASON_CODE_IN_USE`), because `tou_slot.season_code` is a string
  with no foreign key, so a rename would leave those hours pricing
  nothing and `resolvePeak` answering "no period covers 17:15" on every
  bill.

## Naming (decided 2026-11-02)

Three tenant-chosen vocabularies meet in a TOU calendar, and in the pure
resolver all three are plain strings. Passing one where another belongs
would compile, run, and classify every interval wrong with nothing
raised — the same failure shape this spec already guards against for
interval timestamp bases (TOU-INT-2a): plausible output, no error. The
database is safe, because each lives in its own table behind its own
foreign key; the code is not. So the names carry what the schema was
carrying.

| Vocabulary | Column | Example values |
|---|---|---|
| Which part of the year | `season_code` | `summer`, `winter`, `shoulder` |
| What kind of day | `day_type_code` | `weekday`, `weekend`, `holiday` |
| What those hours cost | `peak_code` | `on_peak`, `mid_peak`, `off_peak` |

Qualified rather than a bare `code`, which follows the distinction the
schema already draws: thirteen tables carry a bare `code` where the
value is a local identifier its table always contextualises
(`commodity`, `unit_of_measure`, `rate_schedule`), and eight carry a
qualified one where the value **travels** — `cycle_code`, `kind_code`,
`role_code`, `module_key`, `account_number`, `meter_number`,
`agreement_number`. A TOU code travels: compared in the engine, named on
every slot row, filtered on by a tariff component.

**`peak_code`, not `period_code`** (Rao, 2026-11-02). "Period" is
already taken three times in this codebase — the service period, the
billing period, and `BaseContext.period` with its `startDate`/`endDate`
— so a `periodCode` sitting beside `period.startDate` in the resolver
reintroduces exactly the ambiguity the qualification removes. The
values are all `*_peak` anyway, so the name reads as the question it
answers.

The **table** stays `tou_period`, because "TOU period" is the industry
term this spec uses throughout and renaming it would put the schema and
the document in different languages. So one wrinkle is accepted
knowingly: `tou_period.peak_code`. A period and a peak are the same
thing here — the table keeps the domain's word, the column keeps the
one that is unambiguous in code.

`season.code` was renamed to `season_code` by the
`season_code_qualified` migration, an hour after it shipped and before
anything outside this codebase read it.

## 2. TOU calendar

- **TOU-CAL-1 (Must).** A tenant defines a TOU calendar: for each season
  and each day type, an assignment of every hour (to a granularity of 15
  minutes) to exactly one named TOU period. Period names are the
  tenant's (`on_peak`, `mid_peak`, `off_peak`, `super_off_peak`, …), with
  a display label and a display order.
- **TOU-CAL-2 (Must).** Day types are at least *weekday* and *weekend*,
  and *holiday* when the calendar names a holiday set. A tenant may
  define more (e.g. *Saturday*) and say which weekdays each covers.
  **`holiday` is the one reserved code**: the system creates that day
  type when a holiday set is attached and the engine resolves a holiday
  date to it by matching the code. A tenant may not create, rename or
  remove it while a set is named, and every other code is theirs.
  *(Revised 2026-11-04. It was an `is_holiday` boolean on the day type,
  so that nothing matched a literal string while the vocabulary stayed
  open. Reserving one code settles the same question with one mechanism
  instead of three — the flag, a partial unique index and a validator
  rule — and removes the setup step that asked an operator to nominate
  a day type as "the holiday one" before anything could say what the
  holidays were.)*
- **TOU-CAL-3 (Must).** Validation at save: every 15-minute slot of every
  (season, day type) is assigned exactly once; every period referenced
  is defined; every period defined is used somewhere. Errors name the
  season, day type and time range.
- **TOU-CAL-4 (Must).** Holidays: a tenant maintains **holiday sets** of
  explicit dates — `(date, name)` — each set versioned, effective-dated
  and published like a season set, and shared across the tenant's
  calendars. A calendar names at most one; naming none means days are
  classified by their weekday alone, which is a real tariff shape. The
  dates are the days **observed**: if the 4th falls on a Saturday and
  the utility takes the Friday, the Friday is the row.
  *(Revised 2026-11-04. It was rules — fixed date, nth weekday, plus an
  observance rule — which is why the original also promised a
  three-year preview of the resolved dates. See "Dates rather than
  holiday rules" below for why that went the other way, and what it
  costs.)*
- **TOU-CAL-5 (Must).** Calendars are effective-dated, versioned and
  published. Only published calendars can be referenced by a published
  rate schedule. Changing peak hours means publishing a new version with
  an effective date; it never edits a published one.
- **TOU-CAL-6 (Must).** Each calendar states its **time zone** (IANA
  name, e.g. `America/Denver`) and its **clock basis**: `prevailing`
  (local clock time, following daylight saving — the common case) or
  `standard` (standard time all year, so during daylight saving a
  "4–9 pm" peak runs 5–10 pm by the clock). Both default from a tenant
  setting and are part of the published version. The zone belongs to
  the tariff, not to the customer: a utility whose territory spans two
  zones still publishes each calendar in one, and a customer's location
  never changes which hours are on-peak. Interval timestamps are stored
  in UTC and converted with the calendar's zone and basis to classify.
- **TOU-CAL-7 (Must).** Daylight saving time: an interval is classified
  by the local time at which it **starts**. On the spring-forward day the
  missing local hour has no intervals; on the fall-back day the repeated
  local hour is classified twice, once per occurrence, both by the same
  wall-clock rule. Golden tests cover both days.
- **TOU-CAL-8 (Must).** A lookup answers "what period is this local
  date-time, for this calendar version?", exposed in the API and the
  calendar screen, so staff can check "Tuesday July 3, 5:15 pm" before
  publishing.
- **TOU-CAL-9 (Should).** The day-type model allows a dated override
  (one specific date takes a different day type), so critical peak
  pricing can later add event days without a schema change.

### Where the calendar attaches

- **TOU-CAL-10 (Must).** A TOU calendar is part of a **tariff**: it is
  referenced by a rate schedule's components (TOU-ENG-1), never stored on
  an account, premise or customer. An account or premise is on TOU only
  because a service agreement is assigned a TOU rate schedule. An account
  with water, sewer and electric services can have one TOU service and
  two that are not; a move-out leaves no TOU setting on the premise.
- **TOU-CAL-11 (Must).** The calendar a meter is **programmed** with is a
  fact about the device, recorded on the meter (or its register mapping),
  and checked against the rate schedule's calendar (TOU-REG-2). It never
  decides pricing.
- **TOU-CAL-12 (Should).** Where a tariff lets customers choose their peak
  window, the calendar defines the allowed windows and the customer's
  choice is an effective-dated parameter on the service agreement — or
  each window is published as its own rate schedule variant. Either way,
  nothing is attached to the account.
- **TOU-CAL-13 (Should).** Location-scoped behaviour (critical peak event
  days called for one region, TOU-CAL-9) is scoped by a service area that
  premises belong to, not by attaching calendars to premises.

### Data model (built 2026-11-02, holidays revised 2026-11-04)

Eight tables: seven by the `tou_calendar` migration, with the two
holiday tables replaced by the `tou_holiday_sets` migration.

```
tou_calendar          utility_id, name, effective_date, published_at,
                      season_set_id → season_set, tou_holiday_set_id?,
                      time_zone, clock_basis
                      unique (utility_id, name, effective_date)

tou_period            utility_id, tou_calendar_id, peak_code, label, sort_order
                      unique (utility_id, tou_calendar_id, peak_code)

tou_day_type          utility_id, tou_calendar_id, day_type_code, label,
                      sort_order
                      unique (utility_id, tou_calendar_id, day_type_code)

tou_day_type_weekday  utility_id, tou_calendar_id, tou_day_type_id, iso_weekday
                      unique (utility_id, tou_calendar_id, iso_weekday)

tou_slot              utility_id, tou_calendar_id, season_code,
                      tou_day_type_id, tou_period_id, start_minute, end_minute
                      EXCLUDE on (utility, calendar, season_code, day_type,
                                  int4range(start_minute, end_minute))

tou_day_override      utility_id, tou_calendar_id, override_date,
                      tou_day_type_id, reason
                      unique (utility_id, tou_calendar_id, override_date)

tou_holiday_set       utility_id, name, effective_date, published_at
                      unique (utility_id, name, effective_date)

tou_holiday           utility_id, tou_holiday_set_id, holiday_date, name
                      unique (utility_id, tou_holiday_set_id, holiday_date)
```

**`holiday` is a reserved code, and that is the only mechanism.** The
day-type vocabulary stays open — a tenant may price Saturday apart from
Sunday — but exactly one code belongs to the system, so the engine finds
the holiday day type by matching `HOLIDAY_DAY_TYPE_CODE` and nothing
else is needed. Three service refusals keep it honest: a tenant cannot
create one (it arrives with the holiday set), cannot rename the
system's, and cannot remove it while a set is named. Each failure is the
same quiet one — a holiday day type nothing resolves to means every
holiday bills as an ordinary weekday with nothing raised.

There is **no CHECK constraint** for the reservation. A constraint
cannot tell the system's row from a tenant's: both are `tou_day_type`
rows with the same code, so it could only ban the code outright, which
would ban the system's own row. The reservation lives in
`tou-calendar.service.ts`, where the intent is known and the refusal can
say why.

*(Until 2026-11-04 this was an `is_holiday` boolean with a partial
unique index and a validator rule behind it — three mechanisms for one
fact, all of them existing only because nothing was allowed to match a
literal string.)*

**Weekday coverage is a child table, not seven booleans on the day
type.** The relationship is one-to-many (TOU-CAL-2's "say which weekdays
each covers"), and seven columns is the repeated column group this
codebase already decided against on `utility_config` (spec 18) — where
three such groups made adding the fourth cost a migration and seven
files. The child row carries `tou_calendar_id` so the unique index can
span the calendar, which makes "no weekday is claimed by two day types"
a database guarantee; booleans cannot express it at all.

**A span references its period and day type, and names its season.** The
first two are children of the same calendar, so a three-column key pins
them to it and makes TOU-CAL-3's "every period referenced is defined" a
database guarantee. A season is not: it lives in a separately versioned
set, its code travels into the engine anyway, and keying it would mean
carrying `season_set_id` on every span. A span naming a season the set
has not got is refused by `validateCalendar`, and if one ever landed,
rating fails loudly — `resolvePeak` answers "no period covers 17:15",
not a plausible price.

**A calendar names its season set** rather than reading whichever set is
in force. A published calendar is immutable (TOU-CAL-5), so if the
in-force set changed, its spans would reference codes that no longer
exist and the hours they price would resolve to nothing. The tariff's
seasons are part of the tariff (TOU-CAL-10). Non-TOU components keep
using the in-force set, which is the existing `season` predicate's
behaviour and unchanged.

**What the database holds and what code holds.** Half of TOU-CAL-3 is a
row-pair property, so the database holds it: no two spans of one
(season, day type) share a minute, enforced by an exclusion constraint
on a half-open `int4range`, so an adjacent span at the same boundary is
still accepted. The other half — no *gaps* — is a property of the set
and cannot be a constraint, so `validateCalendar` owns it. That is the
same division `validateSeasons` draws for season tiling.

Two things live only in SQL, and `migrate dev` would propose dropping
each: the exclusion constraint on `tou_slot`, and the nullable composite
key from a calendar to its holiday set — Prisma requires every
referencing field of an optional composite relation to be optional, and
`utility_id` is not.

### How the engine reads it (built 2026-11-02)

`lib/rate-engine-loaders/load-tou-calendar.ts` is the only place these
tables are read for rating, so the engine's filter, the calendar
screen's preview and the bill's period footnote cannot disagree about
which version was in force or what it said.

Three rules it fixes:

- **Which version:** the newest *published* one whose effective date is
  on or before the **period's** start — never today's date. That is what
  makes re-rating an old period reproducible: a calendar published since
  then has a later effective date and is not reached.
- **Which seasons:** the set the calendar *names*, for the reason above.
- **Which holidays:** the dates in the named set that fall **inside the
  period**, which is one date-range query and so covers a
  December-to-January period without special-casing the year end. The
  filter matters in the other direction too: a set gets longer every
  year and a bill still covers a month.

It does **not** re-validate. `validateCalendar` runs at save and
publishing freezes the result, so re-checking 96 cells per (season, day
type) on every bill would buy nothing — and the safety net is already
better placed: a calendar with a gap makes `resolvePeak` answer "no
period covers 17:15" at the first interval it cannot classify, which
stops the bill and names the hole.

Failure is a discriminated result, not null or a throw, because the two
ways it fails are two different operator mistakes — "you never published
it" and "the component names a calendar you have not got" — and one
message for both sends somebody to the wrong screen.

Covered by `tou-calendar-loader.integration.test.ts`, which is a **round
trip**: the SMUD tariff is written into the schema and read back, and the
loaded definition must equal the fixture the pure tests classify with.
That proves the schema can hold a tariff nobody designed it around and
that the loader does not reshape it on the way out — two things neither
test proves alone.

### Dates rather than holiday rules (decided 2026-11-04, reversing 2026-11-02)

**A holiday set holds explicit dates.** The first design held rules —
fixed date, nth weekday, plus an observance rule — and this reverses it.

The argument for rules was that a list of dates **expires**: a set
entered in 2026 holds nothing for 2029, and a missed year raises nothing
while every holiday that year bills as an ordinary weekday. That failure
is real and it is why `holidayHorizonProblems` exists — the editor
reports a set whose last date is behind the calendar's effective date,
and publishing refuses it. The horizon is now loud rather than absent,
which is what the rules were buying.

What the rules cost was worse. **A rule is a computation nobody
checked.** "4 July, nearest weekday" does not say that 2026 lands on a
Saturday and moves the holiday to Friday the 3rd — a weekday whose peak
hours disappear. Nobody reading the tariff could see which day their
bill would be cheap, which is why the original TOU-CAL-4 had to promise
a three-year preview: a feature whose entire job was to show what the
data already meant. And the observance itself was a guess about the
tenant's own policy — SMUD keeps a Saturday holiday on the Saturday,
some utilities take the Friday, and `observance: "NEAREST_WEEKDAY"` was
easy to set wrongly and impossible to notice.

With dates, the observance is applied by the person who knows it, at the
moment they type the date, and the date is then the fact: auditable, and
the same on every bill that priced against it.

Three consequences:

- **The three-year preview is gone**, because the rows *are* the answer.
  The holiday-set editor shows each date's weekday beside it, which is
  the one piece of arithmetic worth doing for somebody — "Sat" next to
  4 July is what prompts them to enter the Friday instead.
- **A set is versioned and published** like a season set, so a
  correction is a new version and a published calendar's holidays cannot
  move under bills already issued. That is what makes a date list safe
  to share across calendars.
- **Someone has to enter next year's dates.** The horizon warnings on
  the set's own page and on the calendar's validation are what make that
  a visible chore rather than a silent misprice. `tou_day_override`
  (TOU-CAL-9) remains the mechanism for genuine one-offs.

What this gave up: "fourth Thursday of November" survives a regulator's
question in a way a bare `2027-11-25` does not. The answer is that the
*name* travels with the date — `Thanksgiving Day` on `2027-11-25` — and
a rule that produced the wrong Thursday would have survived the same
question just as well.

## 3. Usage data

Two ways to know when energy was used. Both are required, because the
utilities this targets have both kinds of meter, and the first is far
cheaper to support.

### How usage is stored (decided 2026-11-02)

Settled before slice 1, because it decides how much of the engine slice
1 has to build. **No arrays and no jsonb anywhere** — every quantity is
a row.

**A TOU bucket is a `meter_read` row.** `meter_read` gains a nullable
`tou_period_id` beside `registerId`, and several rows may describe one
period — which is not new, since a multi-register meter already
produces one row per register. For a register meter the period is
derived from the register's mapping (TOU-REG-1), so **a register-based
TOU meter needs no schema change at all: its buckets are already rows.**
For an interval meter the roll-up writes them directly.

*Why not a child table.* `meter_read` already carries `billedAt`,
`isFrozen`, `correctsReadId`, `exceptionCode` and `importBatchId`. A
`meter_read_tou` table would mean teaching freezing, billing,
corrections, exceptions and retention about a second table — five
behaviours re-implemented to hold four numbers. Reusing the row
inherits all of them.

**`reading` and `priorReading` become nullable.** A bucket rolled up
from intervals has consumption with no dial behind it, and a per-TOU-
period dial value does not exist even in principle. The model reads as
"a read row records consumption for a period; for a dial meter it also
records the dial values". Every existing reader sees dial-meter rows
where both are present, so the change is smaller than it looks.

*Rejected: `priorReading = 0, reading = consumption`.* It satisfies the
constraint and is a lie in the shape of data — the kind that surfaces
two years later in a dispute.

**Intervals are one row per interval**, in `meter_read_interval`, with
TimescaleDB's native compression policy rather than a value we pack
ourselves.

*Why not pack them.* A compressed value cannot be appended to, so a
row covering a month must be decompressed, extended and recompressed
on each of ~30 nightly deliveries — 96 + 192 + … + 2,880 ≈ 44,600
values processed to store 2,880, with two overlapping imports silently
losing a night (both read the same prefix, both write back their own).
Per-day rows avoid the amplification, but packing at any grain costs
three things worth more than the bytes: per-interval quality flags,
which TOU-GAP-1 and "a bill containing an estimate says so" both read;
plain SQL for "which services have gaps this period"; and correctness,
since a hand-written codec is one more place to be silently off by one
interval in a spec that already worries about exactly that. Timescale's
compression already packs columns into arrays per chunk, so the
storage win arrives without a codec.

**The consequence that matters most.** Both meter types now produce the
same thing — per-TOU-period quantities as rows — so the engine never
learns which kind it was. TOU-ENG-2's "either TOU register quantities
or the interval series" collapses to "per-TOU-period quantities", and
a whole branch of slice 1's engine work stops needing to exist.
Reconciliation (TOU-REG-1, TOU-INT-5) becomes one rule for both:
the bucket rows' consumption sums to the total register's.

Volume, for the record: four buckets per read per month is ~48 rows per
meter per year, ~576,000 a year at 12,000 meters — against ~420 million
raw intervals from the same meters. Compression is therefore entirely a
`meter_read_interval` question.

### 3a. TOU registers (meters that split the total themselves)

- **TOU-REG-1 (Must).** A `MeterRegister` can be mapped to a TOU period
  (e.g. register 2 = `peak`, register 3 = `off_peak`). A meter's TOU
  registers plus any total register must reconcile: if a total register
  exists, the TOU registers' consumption sums to it within a tenant
  tolerance, or the read is an exception.

  *Built 2026-11-03 (`tou_registers` migration), except the
  reconciliation check, which belongs with the import path and is the
  next step.* Three things worth knowing:

  **A `peak_code`, not a key to `tou_period`.** The spec said
  `tou_period_id`; this reverses it. A `tou_period` row belongs to one
  calendar *version*, so pointing a register at one would bind a fact
  about a **device** to a version of a **tariff** — every republished
  calendar would need every register re-pointed, and TOU-CAL-11 is
  explicit that what a meter is programmed with never decides pricing.
  The integrity a key would buy already exists and is better placed: a
  read carrying a code no component prices does not bill silently,
  because the `tou_period` quantity source raises when its bucket is
  absent, and the mapping itself is checked once per register against
  the meter's programmed calendar — rather than by a foreign key on
  every row of a hypertable that will take tens of millions of rows a
  month at TOU granularity.

  **A register does not report a peak code** (Rao, 2026-11-03). It
  reports a *number* — a dial count. The meter's own clock routes
  consumption into one register or another by its programmed switch
  times, and "register 2 means on-peak" is the **utility's assignment of
  meaning to a dial**, not something the device says. Two things follow.

  First, this is why register meters need the mapping at all while
  interval meters do not: a TOU register meter is read once and every
  register is captured at that single moment, so the read time says
  nothing about when the usage happened — the device already did the
  bucketing. An interval meter gives one value per interval, each with
  its own timestamp, and *we* classify from the calendar. Same stored
  shape, different author of the classification.

  Second, an assignment can be changed, and this one is neither
  versioned nor effective-dated. So **the mapping is not the declaration
  of which periods are answerable** — the *reads* are. A register meter
  read produces a row per register including a zero one, so a period
  with a row answers (zero included) and a period with no row is one the
  meter has no register for, which leaves the key unset and makes rating
  raise. That also makes a re-rate exact, where gating on the current
  mapping asked about today's periods and failed to reproduce a bill
  from before a remap.

  **The contract this puts on the importer:** write a row per TOU
  register on every read event, zero consumption included. Writing only
  the non-zero ones would make an unused period indistinguishable from an
  absent register and stop a bill that should have shown a zero.

  **And which buckets get asked for comes from the tariff**, not the
  registers (`touPeakCodes`): a rate schedule is versioned and
  effective-dated, so asking for what it prices is reproducible where
  asking the registers is not. `meter_register.peak_code` therefore has
  exactly one job — the import-time mapping that stamps a read — and
  that importer is still to be built.

  **`meter_read.reading` and `prior_reading` became nullable**, paired by
  a CHECK. A register-based bucket has a dial reading; an
  interval-derived one is a sum over classified intervals and has none,
  and inventing one would put a number on a bill that matches nothing on
  the device. `consumption` stays NOT NULL.
- **TOU-REG-2 (Must).** Rating a register-based TOU service uses the
  registers' consumption for the period directly; no interval data is
  needed. The meter's own clock decides the periods — the system records
  which calendar the meter is programmed with and flags a mismatch with
  the calendar the rate schedule references.

  *`meter.tou_calendar_id` built 2026-11-03; the mismatch flag is the
  next step.* The column keys a specific **version**, because that is
  what is in the device — firmware holds switch times, not a name. The
  mismatch check compares calendar **names**, so republishing a calendar
  does not flag every TOU meter in the territory; the version is
  recorded for the audit trail of what we believe was loaded.

  **A defect this nearly introduced, now guarded.** `meter:reads` sums
  `MeterRead.consumption` for the period, and a TOU meter may carry a
  total read *and* a row per period for the same month — which
  TOU-REG-1's reconciliation assumes. A naive sum counts the month
  twice, and the symptom is not an error: it is a tiered charge at
  double the usage, on an ordinary-looking bill. So totals and buckets
  are summed separately and the total wins; where there is no total
  read, the buckets are summed, because a TOU meter with no total
  register still has a month's total and a flat or tiered component on
  the same schedule would otherwise bill zero. Pinned by a
  mutation-checked test in `meter-loader.integration.test.ts`.

### 3b. Interval data

- **TOU-INT-1 (Must).** Interval consumption is stored in
  **`meter_read_interval`**, one row per interval per meter (and
  register): interval start (UTC), length (5, 15, 30 or 60 minutes),
  quantity, unit, and a quality flag (`actual`, `estimated`, `missing`,
  `edited`). A TimescaleDB hypertable with a **native compression
  policy** — no packed arrays, for the reasons under *How usage is stored* — under RLS with
  `FORCE`, scoped by `utility_id` like every tenant table.

  Compression has no precedent in this codebase: no migration calls
  `add_compression_policy` and `meter_read` is uncompressed. This is
  the first, and the policy's threshold should sit outside the rebill
  window so a correction never has to decompress a chunk.
- **TOU-INT-2 (Must).** Import by file, through the existing import
  infrastructure ([22](22-import-infrastructure.md)): CSV (meter, start,
  length, quantity, quality) and Green Button Connect / ESPI XML. An
  import is idempotent on (meter, register, interval start); re-sending
  an interval with a different value is a correction, kept with history,
  never a silent overwrite.
- **TOU-INT-2a (Must).** Every interval source declares the time basis
  of its timestamps — UTC, a named zone with daylight saving, or local
  standard time — and whether a timestamp marks the interval's start or
  end. Meters and MDMs differ on both, and getting either wrong shifts
  every interval by an hour or one interval length. An import with no
  declared basis is refused. The fall-back hour must be unambiguous in
  the source (UTC or an offset), or the import is refused for that day.
- **TOU-INT-3 (Should).** Scheduled pull from a meter data management
  system through apptor-connect (`rest` connector), per the integration
  rule in CLAUDE.md — no MDM credential in this codebase.
- **TOU-INT-4 (Must).** Interval length must divide evenly into the
  calendar's 15-minute slots or align to whole slots (5 and 15 minute
  data classify directly; 30 and 60 minute data must start on a slot
  boundary that does not straddle a period change). An interval that
  straddles a period boundary is refused at import with the reason,
  unless the tenant enables proportional splitting.
- **TOU-INT-5 (Must).** Reconciliation: for a meter with both a register
  read and intervals, the sum of intervals between two register reads
  matches the register's consumption within a tenant tolerance (default
  1%), or the period is an exception.
- **TOU-INT-6 (Must).** Retention: `intervalReadRetentionDays` is honoured
  by a scheduled job, never deleting an interval that belongs to a
  service period that has not been billed, or that is inside the
  tenant's rebill window.
- **TOU-INT-7 (Must).** Once a bill has been posted from intervals, those
  intervals are frozen, the same as `MeterRead.billed_at` today. Changing
  one requires the rebill workflow (not yet built — see the Bozeman gap
  analysis, rebill).
- **TOU-INT-8 (Must).** Volume: the store and the rating path handle
  12,000 interval-metered accounts at 15-minute data (≈ 2,900 intervals
  per account per month, ≈ 35 million rows per month) within the
  billing run's existing time budget. Measured, with the result recorded
  in this spec.

### 3c. Missing data

- **TOU-GAP-1 (Must).** If a TOU service's intervals for the period are
  incomplete, the default is a **billing exception** with cause
  `TOU_INTERVALS_INCOMPLETE`, listed by the billing run's pre-run check
  ("what cannot be billed") and in its exceptions by cause. Missing
  energy is never silently priced as off-peak.
- **TOU-GAP-2 (Should).** A tenant may instead choose an estimation
  policy: fill gaps by distributing the register total across missing
  intervals using the customer's own prior profile, or a class load
  profile. Every estimated interval is flagged `estimated`, and a bill
  containing any says so.

## 4. Rate engine

- **TOU-ENG-1 (Must).** A consumption component prices **one** TOU
  period, named by a `tou_period` quantity-source base:

  ```json
  { "predicate": { "season": "summer" },
    "quantitySource": { "base": "tou_period", "peak_code": "peak" },
    "pricing": { "type": "flat", "rate": 0.3765, "unit": "kWh" } }
  ```

  *Built 2026-11-02, and this is the third shape the requirement has
  had.* It first said a period-level `tou_window` **predicate**, which
  cannot be given a correct meaning — a monthly service period always
  overlaps every TOU window. It then said `base: metered` with a
  `tou_window_filter` **transform**, which is also wrong, for a
  different reason: a transform takes a quantity and returns one, and
  on-peak kWh cannot be derived from total kWh. Such a transform would
  have to ignore its own input and read the buckets itself, which is a
  lie about what a transform is.

  A **base** is the honest shape, because the quantity *is* that
  period's usage, read from where it lives. And one component per period
  is how tariffs are written and how bills read — "Summer On-Peak Energy
  $45.18" is a line a customer can check against the rate sheet, where a
  single component carrying three prices would collapse into one line
  nobody could verify. The season predicate needed no new machinery.

  The `tou_window_filter` transform is left raising, pointing at the
  base. It may yet earn its keep for **demand**, where filtering a
  series to the on-peak window and then taking its maximum genuinely is
  a filter — which waits for `peak_demand`, its own spec after slice 2.

  **A bucket is required, not defaulted.** The loader emits one variable
  per period in the calendar, zero included, so an absent bucket raises
  rather than billing zero. Billing zero would charge a TOU customer
  nothing for their most expensive usage, on a bill that read as an
  ordinary quiet month.

  **Consequence for TOU-BIL-2.** The engine suppresses zero-amount lines
  — deliberately, and every other tariff depends on it — so a customer
  who avoided the peak entirely produces no on-peak line, only a trace
  entry reading `zero_amount`. The bill's by-period table therefore
  **cannot be built by looping over the rated lines**: it is built from
  the calendar's periods, with the trace or the buckets supplying the
  zeros. Pinned in `smud-time-of-day-rating.test.ts`, because the
  obvious implementation of TOU-BIL-2 is the one that silently drops a
  period.
- **TOU-ENG-2 (Must).** The engine stays a pure function. Loaders supply
  **per-TOU-period quantities** plus the resolved calendar version(s)
  and holiday dates for the period. It never queries the database.

  *Simplified 2026-11-02.* This used to say "either TOU register
  quantities or the interval series", and the engine would bucket the
  series itself. Storing both meter types' output as `meter_read` rows
  with a `tou_period_id` (see *How usage is stored*) means the engine
  receives one shape and never learns which kind of meter produced it.
  The bucketing moves to the roll-up, which happens once per period
  rather than on every rating pass, and slice 1 loses a branch it would
  otherwise have had to build and test twice.

  *Corrected 2026-11-02:* this requirement previously said the
  `intervals` field was one `meter:reads` "already declares". It does
  not — the loader carries no such field. Slice 2 therefore adds the
  loader slot as well as the store, which is a smaller correction than
  it sounds but would have been discovered mid-slice.
- **TOU-ENG-3 (Must).** Each interval is classified by the calendar
  version and season in effect at its local start time (TOU-SEA-4,
  TOU-CAL-5). A calendar change mid-period applies from its effective
  date, interval by interval.
- **TOU-ENG-4 (Must).** Conservation: the sum of all TOU period
  quantities for a service equals the total metered quantity for the
  period, to the unit's precision. Rating fails rather than drop or
  double-count energy. A property test proves it over random calendars
  and DST days.
- **TOU-ENG-5 (Must).** Pricing per TOU period supports `flat` (one
  price per period and season) and `tiered`. For tiers the schedule
  states whether tier thresholds apply to the **total** quantity (tiers
  first, then each tier's energy is split across periods in proportion)
  or **within each period** separately. Both are seen in real tariffs.
- **TOU-ENG-6 (Must).** Existing features compose with TOU: per-day tier
  proration, minimum bills (`floor`), `percent_of` taxes and riders over
  TOU lines, and `indexed` adders (e.g. a fuel adjustment per kWh across
  all periods).
- **TOU-ENG-7 (Must).** At most one assignment per role applies at any
  instant, and where two windows meet inside a bill period each prices
  only the part of the period inside its own window — the days for a
  register meter, the intervals themselves where intervals exist. This
  states the rule rather than inheriting the engine's current one, which
  open question 5 found to be double-charging: both tariffs fire in
  full. TOU does not adopt that, and the general fix is spec 07's.
- **TOU-ENG-8 (Must).** Bill lines: one line per (TOU period, season,
  price) actually used, carrying quantity, unit and price, labelled with
  the period's display label ("On-peak, summer: 312.4 kWh × $0.2410").
- **TOU-ENG-9 (Must).** Golden tests against at least one real, published
  TOU tariff with extracted prices (the reference utility's, or a public
  municipal electric tariff if NorthWestern's PDFs stay unreadable),
  plus tests for a season boundary inside a period, a holiday, both DST
  days, a calendar version change mid-period, and incomplete intervals.

## 5. Configuration UI

> **Built 2026-11-03**, except where a requirement says otherwise below:
> `/season-sets` and `/tou-calendars` with their editors, and — added
> 2026-11-04 — `/tou-holiday-sets` with its own list and editor. The API
> under `/api/v1/season-sets`, `/api/v1/tou-calendars` and
> `/api/v1/tou-holiday-sets`. All under the
> **`rate_schedules`** module rather than one of their own — a calendar
> is only ever the hours a schedule prices against, and a separate
> module would have to be enabled per tenant, leaving someone with
> `rate_schedules:EDIT` able to build a schedule they cannot publish.
>
> **The child collections are replaced whole** (`PUT …/periods`,
> `…/day-types`, `…/spans`, `…/overrides`, `…/seasons`, `…/holidays`)
> rather than
> edited row by row. Every invariant they carry belongs to the list: the
> spans of a (season, day type) must tile the day exactly once, the
> seven weekdays must be claimed exactly once, a set must cover the year
> exactly once. Row-at-a-time saving makes every intermediate state
> invalid, which reduces validation to advice — and "move Saturday from
> weekday to weekend" is not expressible as two row edits at all,
> because `tou_day_type_weekday_once_per_calendar` makes a weekday one
> day type's property.
>
> **Both editors run the engine's own functions.** `validateCalendar`,
> `resolvePeak`, `resolveDayType`, `validateSeasons` and
> `seasonCoverage` are called server-side over the definition the
> *rating* loader's mapper produces (`toTouCalendarDefinition`, extracted
> for this). So the validation, the spot check, the day preview and the
> year bar cannot say anything a bill would not. A second classifier in
> the browser would eventually bless a calendar the engine reads
> differently, and the wrapped season is exactly where it would start.
>
> **Dev seed:** `seed/tou-calendar.js` creates a published "Residential
> time-of-use" calendar and a published "Observed holidays" set holding
> **two years of observed dates** (2026–27, including 3 July 2026 and 5
> July 2027 — the same holiday moved in both directions), so the screens
> open on something and the spot check can be used. It keys its spans on the
> season set the tenant already has — the `season_sets` migration seeds
> every tenant a published "Default" — rather than creating a second set,
> because a published calendar naming one set while another is in force
> is the divergence TOU-SEA-6 warns about, and a fresh database should
> not open on a warning about a state nobody caused. Nothing prices it
> yet; a TOU rate schedule is not seeded.
>
> **Still to build:** TOU-UI-1d (the published-version diff), TOU-UI-3's
> editor half, TOU-UI-4 and TOU-UI-5.

### The calendar editor

Expanded 2026-11-02, because "a grid painted by period" is two lines
describing the module's largest interaction, and the obvious reading of
it is wrong.

- **TOU-UI-1 (Must).** **Ranges are the input; the grid is the
  verification.** A tariff says "on-peak is 4–9 pm on summer weekdays".
  It does not say ninety-six things. So a (season, day type) is edited
  as a short list of `from – to → period` rows, and the 96-slot grid is
  rendered *from* those rows as the proof that they tile the day.

  Painting cells was the obvious design and is the wrong one. Ninety-six
  slots × three day types × two seasons is 576 targets, a drag-select
  produces an off-by-one-slot peak nobody can see, and — the part that
  decides it — **a painted calendar cannot be read back.** A regulator
  asks "what are your peak hours"; the answer has to be four rows, not a
  bitmap. The grid still earns its place as the thing that shows a gap
  or an overlap at a glance, which a list cannot.

- **TOU-UI-1f (Must).** *Built 2026-11-04.* **Three tabs — Periods, Day
  Types, Hours — and one season at a time.** All of it on one page is a
  wall: two seasons and three day types is six span editors, each a
  strip and a table, under two more cards; three seasons is nine.

  One tab per collection, because that is where the save boundary
  already is — each is its own `PUT` with its own invariants and its own
  refusals. Two collections on one tab would mean two Save buttons
  saving half a tab each, or one button issuing two writes with no way
  to be atomic about them.

  **Not a wizard**, although the page walks a new calendar through the
  same order: it opens on the first tab with nothing in it and offers
  "Next". A separate create flow would be a second screen over the same
  data with its own idea of what makes a calendar valid, and nothing
  here needs an order enforced — every part of a draft is editable, and
  a new calendar already arrives with its periods and day types filled
  in.

  What stays **outside** the tabs: the status, the season set and
  holiday set the calendar names (with links through to those editors),
  the validation verdict and Publish. A tab that hid "2 problems to fix"
  would let somebody believe the hours were finished.

  The Hours tab scopes to one season, chosen by **chips rather than a
  dropdown**, each marked complete or incomplete: publishing needs every
  (season, day type) covered exactly once, and a dropdown can only say
  which season is empty once somebody has opened it and gone looking.
  Each season's name carries the months it covers ("Summer · 1 May –
  31 Oct"), since a season code is the tenant's word and says nothing
  about when it runs — least of all when it wraps the year end.

  Every tab stays mounted and hidden rather than unmounted, and each
  section remounts on **its own** counter after saving, so switching tab
  or season does not discard a half-typed list and neither does saving
  the one next door. A tab or chip holding unsaved edits is marked.

- **TOU-UI-1a (Must).** Validation is **inline and positional**: an
  uncovered or doubly-covered span is highlighted on the grid *and*
  named in words ("Summer, weekday: 21:00–22:00 is assigned to no
  period"). TOU-CAL-3 already requires the message; the grid is what
  makes it findable.

- **TOU-UI-1b (Must).** **Copy between day types and seasons.** Real
  tariffs repeat: Saturday is often weekday-shaped, winter is often
  summer with a shorter peak. Copying then editing is how a calendar is
  actually built, and without it every season is retyped — which is
  where transcription errors come from.

- **TOU-UI-1c (Must).** **The spot check is in the editor, not an API
  corner.** TOU-CAL-8's lookup — "Tuesday 3 July, 5:15 pm" — is a field
  above the grid answering with the period, the day type and *why* ("3
  July 2026 is observed as the Independence Day holiday, so the holiday
  day type applies"). This is the single most valuable control on the
  screen: it is how somebody checks a calendar before publishing, and
  the holiday interaction is the part people get wrong.

- **TOU-UI-1d (Must).** *Read-only is built; the diff is not.* A
  published version is **read-only, with a diff
  against the version it replaced**. "What changed between v1 and v2,
  and from when" is what a regulator and a disputing customer both ask,
  and reconstructing it by opening two screens is how the wrong answer
  gets given. The diff is by span, not by slot: "on-peak shortened from
  16:00–21:00 to 17:00–21:00 on summer weekdays".

- **TOU-UI-1e (Should).** **Preview a date.** Enter a date and see which
  day type and which season resolve for it, with the day's periods laid
  out — the same mechanism as TOU-UI-1c but for a whole day, which is
  how an observed holiday gets sanity-checked against the hours it
  changes.

- **TOU-UI-2 (Must).** *Built 2026-11-04, for dates rather than rules.*
  A holiday-set editor: a list of `(date, name)` rows saved whole, with
  **the weekday shown beside each date** and the set's span and status
  on the list page. The weekday is the one piece of arithmetic worth
  doing for the operator — "Sat" next to 4 July is what prompts them to
  enter the Friday the utility actually takes.
  *(Originally: rules with an observance rule each, and the resolved
  dates for three years shown beside the rule that produced them,
  because a rule nobody can see the output of is a rule nobody will
  trust. With dates, the rows are the output.)*
  The set's page also carries **the horizon** — "every date in this set
  is in the past", or "only N dates are still ahead" — which is what
  makes entering next year's dates a visible chore instead of a silent
  misprice.

- **TOU-UI-2a (Should).** *Built 2026-11-04.* A holiday set is **shared
  across calendars** of the tenant, since a utility's holidays do not
  vary by tariff, with each calendar naming the set it uses. TOU-CAL-4
  says "per calendar"; this relaxes it to "named by the calendar" so
  that adding a holiday does not mean editing three calendars and
  missing one. The set's page lists the calendars naming it, which is
  what a new version has to be carried into.
- **TOU-UI-3 (Must).** The rate schedule editor offers the TOU filter on
  consumption components, picking a published calendar and its periods,
  and refuses to publish a schedule whose periods do not cover every
  period in the calendar (or says which are deliberately unpriced).

  *Server side built 2026-11-03; the editor UI is still to come.*
  `rate_schedule.tou_calendar_id` is what the schedule references —
  **on the schedule, not on each component**, because the components of
  one tariff share one set of peak hours, and per component two of them
  could name different calendars, which has no coherent meaning but
  would save and bill. It keys a specific version: a published schedule
  is immutable and cannot follow a calendar republished with different
  hours, so new hours mean a new schedule version against a new
  calendar version — which is what a regulator expects to see.

  `publishRateSchedule` now refuses four things, each a 409:
  `TOU_CALENDAR_REQUIRED` (prices TOU periods, names no calendar),
  `TOU_CALENDAR_NOT_PUBLISHED` (TOU-CAL-5 — a published schedule cannot
  reference a draft whose hours can still change),
  `TOU_CALENDAR_MISSING`, and `TOU_PRICING_INCOMPLETE` from
  `validateTouPricing`, which checks both directions.

  **The costly direction is the quiet one.** A component pricing a
  period the calendar has not got never bills and raises when rated —
  annoying, visible. A calendar period *no component prices* is energy
  the customer uses and is never charged for, and **nothing raises at
  all**: the bucket is never asked about and the bill looks complete.
  That is why this refuses rather than warns.

  **"Deliberately unpriced" has no mechanism and does not need one.**
  The escape hatch already exists and documents itself: a component
  priced at zero, labelled for what it is. The engine suppresses
  zero-amount lines so it never reaches the bill, but it states the
  intent where a reader of the tariff finds it. The refusal message says
  so.

  Checked at publish rather than at save, because a draft is allowed to
  be half-written — an author adds the calendar and the components in
  whichever order suits them, and publishing is the commitment.
- **TOU-UI-4 (Must).** Meter register screens allow mapping a register
  to a TOU period (TOU-REG-1).
- **TOU-UI-5 (Should).** A test-rating panel: pick a service agreement
  and period, see the bucketed quantities and the lines before
  publishing a schedule.

## 6. Billing run and bills

- **TOU-BIL-1 (Must).** The billing run's pre-run check lists TOU
  services with incomplete intervals, unreconciled registers or a
  calendar mismatch (TOU-REG-2), each with its cause.

  *`tou-readiness.service.ts` built 2026-11-03; wiring it into the
  run's preview is the next step, and incomplete intervals wait for
  slice 2.* It reports five problems, and **four of them are invisible
  on the resulting bill**, which is the whole reason this is a pre-run
  check rather than something rating discovers:

  | Problem | What it does to the bill |
  |---|---|
  | `CALENDAR_MISMATCH` | Bills correctly against hours the meter was not counting by. Every figure reconciles; the split is wrong. |
  | `CALENDAR_UNKNOWN` | Nobody can tell whether there is a mismatch. |
  | `REGISTERS_UNRECONCILED` | Some usage billed twice or not at all. |
  | `PERIOD_NOT_REPORTED` | **Stops** rating — the one visible failure, and better found before a run of thousands than halfway through one. |
  | `NO_TOU_READS` | A TOU tariff with no TOU usage to price. |

  **Reported, not enforced.** The operator approves the preview, and a
  tenant mid-migration may knowingly bill a service whose meter
  programming is not yet recorded.

  **Wired into the run's preview on 2026-11-03, and split in two there
  on an observable test: does a bill come out?** `PERIOD_NOT_REPORTED`
  and `NO_TOU_READS` make the `tou_period` quantity source raise, so
  those accounts genuinely cannot be billed and they join the existing
  `blockers`, counting against `billableCount`. The other three produce
  a bill — a wrong one — so they are a separate `warnings` list.

  Mixing them would make the preview's own headline lie: it reads "N of
  M cannot be billed yet", and three of the five can be. An operator
  would hold a run that should go ahead, or stop trusting the number.
  The warnings block is rendered muted rather than in the warning
  colour, so the block that stops the run stays the one that looks
  urgent, and it says plainly that these are not stopped — because
  running anyway is sometimes right mid-migration.

  **The batched form is what the preview calls**
  (`checkTouReadinessForAgreements`). Per agreement it would be six
  queries times tens of thousands; batched it is five in total, and the
  first answers "no TOU services here" for most cycles and returns. A
  non-TOU utility pays two queries for the whole feature.

  The problem *wording* lives in one place (`describeTouProblem`), so
  the preview and an agreement's own page cannot describe the same
  problem two ways.

  **The mismatch compares calendar *names*, not versions** (TOU-REG-2),
  so republishing a calendar does not flag every TOU meter in the
  territory. The version on the meter is the audit trail of what we
  believe was loaded into the device.

  **Two tolerances, and a read reconciles within *either*** (TOU-REG-1,
  `settings.tou`). A relative tolerance alone fails absurdly at low
  usage — 0.5% of 2 kWh is 0.01, tighter than any dial reads — and an
  absolute one alone fails at high usage, where 1 kWh of slack on 40,000
  hides a real fault. The defaults (1 absolute, 0.5%) are a judgement
  and not a figure from a utility: none was available. They are loose
  enough not to flood a queue on day one, and a tenant who knows their
  meters should tighten them.

  **Every problem a meter has is reported, not the first**, for the
  reason `validateSeasons` and `validateCalendar` do the same: an
  operator fixing one at a time turns one run into four.
- **TOU-BIL-2 (Must).** The bill PDF shows usage and charges by TOU
  period, and names the periods' hours in a footnote ("On-peak: 4–9 pm
  weekdays, Jun–Sep, excluding holidays").
- **TOU-BIL-3 (Should).** The bill shows the share of usage on-peak, and
  the portal shows usage by hour and by TOU period for any billed
  period.
- **TOU-BIL-4 (Should).** Shadow bill: for a customer on TOU, or
  considering it, show what the same usage would have cost on the
  standard rate. Shown to staff, and in the portal when the tenant
  enables it.

## 7. Modeling (the stand-alone rate engine offer)

- **TOU-MOD-1 (Must).** The scenario runner accepts interval usage files
  for a sample or a full population, without creating accounts or
  meters, and rates them under current and proposed TOU and non-TOU
  schedules.
- **TOU-MOD-2 (Must).** Results include revenue by period and class,
  bill impact by customer, the number of customers who gain or lose
  under TOU versus the standard rate, and the on-peak share by class.
- **TOU-MOD-3 (Should).** Load shift: model a percentage of on-peak
  usage moving to off-peak and show its revenue effect, labelled as an
  assumption.

## 8. Cross-cutting

- **TOU-X-1 (Must).** Every new table holds `utility_id`, has an RLS
  policy in the fail-loud form and `FORCE ROW LEVEL SECURITY`, and is
  covered by `assertRlsEnforced` (architecture §7.1). No new
  `cis_platform` path.
- **TOU-X-2 (Must).** Calendar, holiday, season and register-mapping
  changes are audited with actor and before/after values. Publishing
  requires the rates EDIT permission.
- **TOU-X-3 (Must).** A TOU customer's enrollment is a rate schedule
  assignment with an effective date, using the existing assignment UI.
  Switching on or off TOU mid-period follows the existing assignment
  proration.

---

## What electric still needs beyond this spec

Verified against the grammar on 2026-11-02. TOU is one of five
unsupported pieces, and the other four are not TOU's:

- **`peak_demand` and `ratchet`** — demand charges. Billed on the
  highest measured demand in the period, often with a ratchet holding a
  floor from the highest of the last eleven months. This is what makes
  commercial and industrial accounts billable, and it is where an
  electric utility's revenue concentrates. Scoped out of this spec on
  purpose (it needs slice 2's interval store but none of the TOU
  pricing) and **has no spec of its own yet.**
- **`power_factor` and `load_factor`** — adjustments on large accounts.
  Also unspecified.

So "we can bill electric" is three documents, not one. This spec gets a
residential TOU bill out; a municipal electric utility with commercial
accounts needs the demand spec as well. Worth stating plainly so the
sequencing is a choice rather than a surprise: slice 1 below is
genuinely the gate to *residential* electric, and nothing more.

## Suggested slices

| Slice | Delivers | Unblocks |
|---|---|---|
| 1 | Configurable seasons (TOU-SEA-1 – 3), TOU calendar and holidays (TOU-CAL-*), register-based TOU (TOU-REG-*), engine filter and pricing (TOU-ENG-1, 2, 4, 5, 8), golden tests | The first TOU bill, from TOU-register meters, with no interval storage |
| 2 | Interval store, import, reconciliation, retention, freeze (TOU-INT-*), missing-data exceptions (TOU-GAP-1), per-interval classification (TOU-SEA-4, TOU-ENG-3, 7) | TOU from AMI interval data; the foundation for demand charges |
| 3 | Bill and portal presentation, shadow bill (TOU-BIL-*), calendar UI polish, test-rating panel | Selling TOU as a feature |
| 4 | Modeling (TOU-MOD-*) | The stand-alone rate engine offer for electric |

Demand charges (peak demand, on-peak demand, ratchets) follow slice 2 as
their own spec.

## Open questions (settled 2026-11-02)

No prospect's tariff or meter population was available to answer these,
and waiting would have stalled the build. **Rao's instruction was to
pick samples and build generically**, so each is settled below as a
build decision — by me, not by a customer — with what would reopen it.
Treat every one as provisional against the first real utility.

The general rule the answers follow: where a question is about a
*vocabulary* the model takes it from the tenant, and where it is about
*behaviour* the model declares the choice rather than hard-coding one.
Three places already work that way — season codes, day-type codes and
peak codes are all open sets, so nothing in code matches a literal
value. *(One exception since 2026-11-04: `holiday` is a reserved
day-type code the system owns. The open set stays open around it, and
TOU-CAL-2 says what the reservation costs and buys.)*

1. **Which tariff first? — SMUD residential Time-of-Day (5–8 p.m.).**
   Sacramento Municipal Utility District, a publicly owned utility,
   which is the market this system targets, and it publishes the whole
   calendar on one page: seasons, windows and the holidays.

   Chosen because it exercises more of the model than a two-period
   tariff would: a season that **wraps the year end** (non-summer is
   1 Oct – 31 May), **three periods in summer and two in non-summer** so
   the calendar's shape is not constant across seasons, a period
   appearing **twice in one day** (summer mid-peak brackets the peak),
   **eleven holidays** including both fixed dates and floating ones, and
   an **observance that is not the one a textbook assumes** — a
   fixed-date holiday falling on a weekend is *not* shifted to an
   adjacent weekday, so 4 July 2026 stays on the Saturday and 3 July is
   an ordinary summer weekday at the tariff's peak rate. Under rules
   that was eleven `observance: "NONE"` settings, each easy to set
   wrongly; as dates it is the eleven days somebody typed.

   Fixture and golden test: `__tests__/tariff-golden/_smud-time-of-day-fixtures.ts`
   and `smud-time-of-day-calendar.test.ts`. The model accepted the
   tariff unchanged; the test was then mutation-checked — a wrong
   Thanksgiving week, a season that stops a day short of the wrap, and a
   span boundary a quarter-hour out each failed exactly the assertion
   meant to catch it.

   **Deliberately omitted:** SMUD's monthly System Infrastructure Fixed
   Charge. Sources disagree on which step is current, and a flat monthly
   charge exercises nothing the Bozeman and NWE golden tests already
   cover — so the fixture carries the energy charges only, which are the
   part a TOU calendar decides. A tariff should not be cited for a
   number that could not be confirmed.

   *Reopens when* a prospect's schedule arrives. It becomes a second
   fixture file, never an edit to this one.

2. **Register or interval first? — registers, as slice 1 says, and the
   choice costs nothing.** The storage decision above already makes both
   meter kinds produce one shape: a TOU bucket is a `meter_read` row
   with a nullable `tou_period_id`, and an interval is a row in
   `meter_read_interval` that aggregates into the same shape. So the
   engine does not branch on the source, TOU-ENG-2 collapses, and slice
   2 adds a data source rather than a second code path. There is no
   longer anything for slices 1 and 2 to swap.

   *Reopens* only if a utility needs interval data before any register
   meter exists, which changes the order of work and not the design.

3. **Interval formats — deferred to slice 2, and generic by
   construction.** The import infrastructure (spec 22) already takes a
   declared column mapping per batch rather than a vendor-specific
   parser, so a new MDM export is configuration until one proves
   otherwise. The first format to need real code will be whichever one
   is not a delimited file with a timestamp and a value per row.

   *Reopens* when a utility names its MDM system.

4. **Tiers within TOU — declared on the component, not assumed.**
   SMUD's TOU rate has no tiers, so the golden tariff does not settle
   it, and both behaviours are real: a tiered block applied to the
   period's own usage, or to the month's total with the period deciding
   only the price. TOU-ENG-5 names both as required, so this is where
   building generically earns its keep — the pricing grammar gains one
   enum, which is not an abstraction layer. **Default total-first**,
   because that is what a tariff means when it is silent.

   *Built with TOU-ENG-5, not before.*

5. **Mid-period rate change — answered on 2026-11-03, and the answer is
   a defect.** Not a TOU defect: the general rate engine bills a
   mid-cycle tariff change wrongly today, for any utility. Four places
   agree, and one of them says so on purpose:

   - `load-base.ts:52` loads *every* assignment overlapping the period
     and does not pick one.
   - `rate.ts:17` keeps all of them and concatenates the components of
     each, so every schedule's components fire in full.
   - `schema.prisma:757`, on `SAScheduleAssignment`: "Overlap exclusion
     is deferred to slice 2/3." Nothing in the database or the service
     layer refuses two overlapping assignments.
   - `topo-sort.ts` does not deduplicate; it orders and returns all.

   So an agreement whose tariff changes mid-period is billed under
   **both tariffs in full** — two fixed charges, and the period's usage
   priced twice. `roleCode` is loaded (`types.ts:46`) and never read by
   the engine, so it cannot tell "delivery plus a rider", which is the
   legitimate case, from "the old tariff and its replacement".
   `selectors.ts:29` and `topo-sort.ts`'s `source_schedule_role` both
   record the same blind spot. The pre-run check does not catch it
   either: `planning.ts:259` blocks an agreement with *no* assignment
   and one naming a draft schedule, and two published overlapping ones
   look healthy. Spec 09 lists it as outstanding already (Req 62,
   "proration logic in rate engine").

   **What this does to TOU-ENG-7:** its original wording — follow "the
   same rule the engine uses today" — cannot be honoured, because the
   rule today is double-charging. TOU-ENG-7 now states the rule
   directly instead of inheriting it.

   *Not spec 26's to fix.* The fix is an exclusion constraint on
   `(utility_id, service_agreement_id, role_code, daterange)` plus a
   per-window split in `rate()`, and it belongs in spec 07 beside the
   assignment model. Recorded here because OQ5 asked.

6. **Missing-data default — an exception, as this spec already says.**
   Estimation is deferred until a tariff mandates a method, because the
   method is the part that matters and inventing one would produce
   confident wrong numbers. An exception stops the bill and names the
   gap, which is the behaviour a utility can act on.

   *Reopens* when a tariff specifies an estimation method, which is then
   configuration naming that method — not a general estimation engine.
