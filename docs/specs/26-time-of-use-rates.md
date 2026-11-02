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
- **TOU-CAL-2 (Must).** Day types are at least *weekday*, *weekend* and
  *holiday*. A tenant may define more (e.g. *Saturday*) and say which
  weekdays each covers.
- **TOU-CAL-3 (Must).** Validation at save: every 15-minute slot of every
  (season, day type) is assigned exactly once; every period referenced
  is defined; every period defined is used somewhere. Errors name the
  season, day type and time range.
- **TOU-CAL-4 (Must).** Holidays: a tenant maintains a holiday list per
  calendar, by fixed date (Jul 4), by rule (fourth Thursday of November,
  last Monday of May), with an observed-date rule (a Saturday holiday
  observed Friday, a Sunday holiday observed Monday — configurable,
  including "not observed"). The system shows the resolved dates for the
  current and next two years.
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

### Data model (built 2026-11-02)

Eight tables, by the `tou_calendar` migration.

```
tou_calendar          utility_id, name, effective_date, published_at,
                      season_set_id → season_set, tou_holiday_list_id?,
                      time_zone, clock_basis
                      unique (utility_id, name, effective_date)

tou_period            utility_id, tou_calendar_id, peak_code, label, sort_order
                      unique (utility_id, tou_calendar_id, peak_code)

tou_day_type          utility_id, tou_calendar_id, day_type_code, label,
                      is_holiday, sort_order
                      unique (utility_id, tou_calendar_id, day_type_code)
                      partial unique (utility_id, tou_calendar_id) where is_holiday

tou_day_type_weekday  utility_id, tou_calendar_id, tou_day_type_id, iso_weekday
                      unique (utility_id, tou_calendar_id, iso_weekday)

tou_slot              utility_id, tou_calendar_id, season_code,
                      tou_day_type_id, tou_period_id, start_minute, end_minute
                      EXCLUDE on (utility, calendar, season_code, day_type,
                                  int4range(start_minute, end_minute))

tou_day_override      utility_id, tou_calendar_id, override_date,
                      tou_day_type_id, reason
                      unique (utility_id, tou_calendar_id, override_date)

tou_holiday_list      utility_id, name
                      unique (utility_id, name)

tou_holiday_rule      utility_id, tou_holiday_list_id, code, label, kind,
                      month, day?, weekday?, nth?, observance
                      unique (utility_id, tou_holiday_list_id, code)
```

**`is_holiday` is a flag, not a code the resolver matches.** TOU-CAL-2
makes the day-type vocabulary open — at least weekday, weekend and
holiday, and a tenant may add Saturday — so `day_type_code` is the
tenant's own string and no code path may compare it to a literal
`'holiday'`. A tenant coding theirs `observed_holiday` would otherwise
have every holiday classified as an ordinary weekday with nothing
raised. One per calendar; `validateCalendar` reports a second before the
save, the partial unique index refuses it.

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

Four things live only in SQL, and `migrate dev` would propose dropping
each: the exclusion constraint, the partial unique index on
`is_holiday`, the nullable composite key from a calendar to its holiday
list, and the CHECK that keeps each holiday-rule kind's columns and not
the other's.

### Holiday rules rather than a list of dates (decided 2026-11-02)

TOU-CAL-4 says "by fixed date, by rule", and the rules are kept even
though a date list would need no resolution code. A published calendar
is immutable, so a list of dates **expires**: a calendar published in
2026 holds no holidays for 2029, and either somebody re-enters dates
every year forever or the dates live outside the version, at which point
publishing no longer fixes what the calendar means. A missed year raises
nothing — the holiday day type silently stops applying and every TOU
bill for those days misprices, which is the same failure shape as the
interval timestamp basis (TOU-INT-2a).

Three smaller consequences: TOU-CAL-4's three-year preview is a rule
feature, since a list has no output to show; observance has to be
computed, and with dates the person typing them applies it in their head
and nothing records whether they did; and "fourth Thursday of November"
survives a regulator's question where a bare `2027-11-25` does not.

The honest limit: a fixed-date rule *is* a list entry with a leap-year
guard, so the rules only earn their keep for the recurring-weekday and
observance cases. Genuine one-offs are not forced into a rule —
`tou_day_override` (TOU-CAL-9) is the mechanism for those.

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
  of a named calendar (e.g. register 2 = `on_peak`, register 3 =
  `off_peak`). A meter's TOU registers plus any total register must
  reconcile: if a total register exists, the TOU registers' consumption
  sums to it within a tenant tolerance, or the read is an exception.
- **TOU-REG-2 (Must).** Rating a register-based TOU service uses the
  registers' consumption for the period directly; no interval data is
  needed. The meter's own clock decides the periods — the system records
  which calendar the meter is programmed with and flags a mismatch with
  the calendar the rate schedule references.

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

- **TOU-ENG-1 (Must).** A consumption component can filter its quantity
  to one or more TOU periods: `quantity_source: metered` with the
  `tou_window_filter` transform naming the calendar and the periods.
  This replaces the period-level `tou_window` **predicate**, which
  cannot be given a correct meaning — a monthly service period always
  overlaps every TOU window. Remove `tou_window` from the predicate
  grammar after confirming no saved schedule references it.
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
- **TOU-ENG-7 (Must).** A rate change mid-period follows the same rule
  the engine uses today for non-TOU schedules, applied per interval when
  intervals exist. If the current rule is per-period, this spec adopts
  per-interval for TOU and records the decision in 07b.
- **TOU-ENG-8 (Must).** Bill lines: one line per (TOU period, season,
  price) actually used, carrying quantity, unit and price, labelled with
  the period's display label ("On-peak, summer: 312.4 kWh × $0.2410").
- **TOU-ENG-9 (Must).** Golden tests against at least one real, published
  TOU tariff with extracted prices (the reference utility's, or a public
  municipal electric tariff if NorthWestern's PDFs stay unreadable),
  plus tests for a season boundary inside a period, a holiday, both DST
  days, a calendar version change mid-period, and incomplete intervals.

## 5. Configuration UI

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

- **TOU-UI-1d (Must).** A published version is **read-only, with a diff
  against the version it replaced**. "What changed between v1 and v2,
  and from when" is what a regulator and a disputing customer both ask,
  and reconstructing it by opening two screens is how the wrong answer
  gets given. The diff is by span, not by slot: "on-peak shortened from
  16:00–21:00 to 17:00–21:00 on summer weekdays".

- **TOU-UI-1e (Should).** **Preview a date.** Enter a date and see which
  day type and which season resolve for it, with the day's periods laid
  out — the same mechanism as TOU-UI-1c but for a whole day, which is
  how a holiday-observance rule gets sanity-checked.

- **TOU-UI-2 (Must).** A holiday editor: fixed dates and rules ("fourth
  Thursday of November"), each with its observance rule, and **the
  resolved dates for the current and next two years shown beside the
  rule that produced them**. A rule nobody can see the output of is a
  rule nobody will trust — and the observance rules are where the
  surprises live, since a Saturday holiday observed on the Friday moves
  a peak day.

- **TOU-UI-2a (Should).** A holiday list is **shared across calendars**
  of the tenant, since a utility's holidays do not vary by tariff, with
  each calendar naming the list it uses. TOU-CAL-4 says "per calendar";
  this relaxes it to "named by the calendar" so that adding a holiday
  does not mean editing three calendars and missing one.
- **TOU-UI-3 (Must).** The rate schedule editor offers the TOU filter on
  consumption components, picking a published calendar and its periods,
  and refuses to publish a schedule whose periods do not cover every
  period in the calendar (or says which are deliberately unpriced).
- **TOU-UI-4 (Must).** Meter register screens allow mapping a register
  to a TOU period (TOU-REG-1).
- **TOU-UI-5 (Should).** A test-rating panel: pick a service agreement
  and period, see the bucketed quantities and the lines before
  publishing a schedule.

## 6. Billing run and bills

- **TOU-BIL-1 (Must).** The billing run's pre-run check lists TOU
  services with incomplete intervals, unreconciled registers or a
  calendar mismatch (TOU-REG-2), each with its cause.
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

## Open questions

1. **Which tariff first?** The first golden test needs a real TOU tariff
   with prices. Whose — a prospect's, or a public municipal electric
   schedule?
2. **Register or interval first?** Slice 1 assumes the target utilities
   have TOU-register meters. If the first customer is AMI-only, slices 1
   and 2 swap their data halves.
3. **Interval formats.** Which MDM systems and file formats do the target
   utilities use (Itron, Sensus, Landis+Gyr, Honeywell/Elster)? That
   decides TOU-INT-2's second format and TOU-INT-3's connector.
4. **Tiers within TOU.** Total-first or per-period (TOU-ENG-5) — the
   default should match the first tariff.
5. **Mid-period rate change.** Confirm the current rule for non-TOU
   schedules before fixing TOU-ENG-7.
6. **Missing-data default.** Exception (this spec) versus estimation —
   some utilities' tariffs mandate an estimation method.
