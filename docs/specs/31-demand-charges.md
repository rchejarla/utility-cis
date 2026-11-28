# 31 — Demand Charges

**Status:** Approved 2026-11-28 — D1–D7 taken as recommended.
**Slice 1 built 2026-11-28** (DEM-MEAS-1, DEM-MEAS-2, DEM-RD-1); slices 2
and 3 not started.

### Slice 1 as built

- `computeConsumption` (`meter-read.service.ts`) treats a register whose
  unit's measure type is `DEMAND` — or a register-less read on a meter
  whose own unit is — as a peak: `consumption = reading × multiplier`,
  prior kept for display, negative refused (`DEMAND_READING_NEGATIVE`).
  Every read path goes through it (manual, import, route entry).
- Demand rows are excluded, by measure type, from `meter:reads` and from
  TOU buckets (`MeterLoader`), and from the portal's agreement usage.
  Excluded rather than usage included, because TOU registers may carry a
  TOU measure type and must still count.
- Read-route entry: `isDemand` on the entry row; the band is
  `typical × factor` rather than `last + typical × factor`; no
  "below the last reading" hold; a hold message about peaks.
- The e2e entry spec types EM-003's demand register as a peak near its
  last, not as a running total.
- **Not changed, noted:** consumption uses `meter.multiplier` for every
  register although spec 08 says `register.multiplier` — pre-existing,
  separate fix.
**Depends on:** Rate Model v2 engine (built), spec 08 multi-register
reads (built), spec 26 slice 2 interval store and roll-up (built).
**Reference tariffs:** [07c](07c-northwestern-energy-rate-reference.md)
GSEDS-1, GSEDS-2 (non-coincident demand with a ratchet) and RSGTOUD-1
(on-peak demand).

## Why

A commercial or industrial electric customer pays for two things: the
energy they use (kWh) and the **capacity they make the utility hold
ready** — their peak demand, in kW. The second is commonly a third to a
half of a commercial bill, and it is where an electric utility's revenue
concentrates. The engine cannot price it: the `peak_demand` quantity
source and the `ratchet` transform are declared in the grammar and throw
`Unsupported`. So every commercial electric bill this system produces
today is short by its demand charge — the seed's NWE-GSEDS-1 says so in
its description.

Spec 26 scoped demand out on purpose ("its own spec after slice 2"), and
slice 2 — the interval store — is built. This is that spec.

## What exists, and what is wrong with it

| Piece | State |
|---|---|
| `DEMAND` measure type, `KW` unit | Exist (reference data; the seed creates KW for electric) |
| A meter register measuring demand | Exists — a `meter_register` with a KW unit. EM-003 in the read-route scenario has one |
| Interval store `meter_read_interval` | Built (spec 26 slice 2): `quantity` per `interval_start` / `length_minutes`, with `quality` |
| Interval → `meter_read` roll-up | Built for TOU buckets (`interval-rollup.service.ts`, `classifyIntervals`) |
| `peak_demand` base, `ratchet` transform | In the grammar, `supported: false`; both throw |
| `meter:peak_demand:<meter>:<window>` variable | Declared in the meter loader; throws |
| `floor` transform | Built — serves a contract minimum demand as it is |

**Two defects in what exists, both live today and both prerequisites:**

1. **A demand read is stored as a difference.** `meter-read.service.ts`
   computes `consumption = (reading − priorReading) × multiplier`, with
   rollover handling, for every register. That is right for an energy
   dial, which accumulates, and wrong for a demand dial, which shows the
   period's peak and is **reset** when read. EM-003's demand read is
   stored as `prior 0, reading 310, consumption 310`; next month a
   300 kW peak would compute as −10, or be taken for a dial rollover.
2. **The energy total includes kW.** `MeterLoader` sums every
   `meter_read` row for the meter in the period into `meter:reads`,
   whatever its unit, and labels the total with the last row's unit. On
   a meter with an energy and a demand register, the kWh charge prices
   kWh + kW. Nothing has been billed this way yet only because no seeded
   agreement with a demand register has been rated.

The read-route entry screen inherits defect 1: its outlier band is
`last reading + median consumption`, which for a demand register is
meaningless, and `read-route-entry.spec.ts` types EM-003's demand as
cumulative (`opening 310, monthly 20`).

## Architectural check (CLAUDE.md)

Rate model v2 (07b, "Loader strategy") anticipated a
**`PeakDemandHistory` table** for ratchets. This spec does not add one.

- **The simple version:** a period's measured peak is a `meter_read` row
  in the KW unit — which is already how a demand register's read lands,
  and already how the roll-up stores an interval-derived TOU bucket.
  Ratchet history is then a query over those rows for the lookback
  months. One shape for both sources, no second store.
- **What a history table would buy:** nothing the reads do not already
  hold. Its usual justification is that intervals are purged
  (`intervalReadRetentionDays`), which is true — and is why the roll-up
  writes the period's peak to `meter_read` (kept indefinitely) at the
  same moment it writes the TOU buckets, rather than recomputing from
  intervals a year later.
- **When to revisit:** if a ratchet ever needs something a read cannot
  carry (a *billed* rather than measured demand basis, D7), the billed
  determinant is already on `bill_segment_line.quantity`.

## Requirements

### Measuring demand

- **DEM-MEAS-1 (Must).** A register is a demand register when its unit's
  measure type is `DEMAND`. Its read stores `reading` as the dial value
  and `consumption = reading × multiplier`. No prior is subtracted, no
  rollover is inferred, and a negative or missing value is refused.
  `prior_reading` is stored as the previous read's value for display
  only. *(Fixes defect 1.)*
- **DEM-MEAS-2 (Must).** `meter:reads` — the period's usage — counts only
  rows whose unit's measure type is usage. Demand rows never enter an
  energy total. *(Fixes defect 2.)*
- **DEM-MEAS-3 (Must).** Interval-derived demand: for each meter with
  intervals in the period, the period's peak is
  `max(block quantity × 60 / block minutes)` over **fixed clock blocks**
  of the tariff's demand interval (15, 30 or 60 minutes), built from the
  stored intervals (four 15-minute intervals make one 60-minute block)
  (D5). Stored as a `meter_read` row in the KW unit, with no dial
  reading, by the roll-up that already writes TOU buckets, with the
  peak's timestamp in `read_datetime`.
- **DEM-MEAS-4 (Must).** A block containing a `missing` interval does not
  produce a peak. A period with any such block raises the existing
  TOU-GAP exception for the meter rather than quietly taking the maximum
  of what remains (D6) — a missing hour is exactly where the peak may
  have been.
- **DEM-MEAS-5 (Should).** On-peak demand: the same, restricted to
  intervals the TOU calendar classifies as a given period, stored with
  that `peak_code` (RSGTOUD-1). Reuses `classifyIntervals`.
- **DEM-MEAS-6 (Must).** Where a meter has both a demand register read
  and interval-derived demand for a period, the register read is the
  billing determinant (D4). Both stay visible.

### Pricing

- **DEM-ENG-1 (Must).** `quantitySource: { base: "peak_demand" }`
  prices the period's measured peak in kW, from a new loader variable
  `meter:demand:<meterId>` (optionally `:<peakCode>`), one per meter.
  Existing pricing types apply unchanged: flat per kW, tiered blocks of
  kW, `floor` for a contract minimum.
- **DEM-ENG-1a (Must).** **A meter's demand for a period is the maximum
  of its demand reads in that period, never their sum.** Each read is a
  peak, not an amount, so a period with an on-cycle read and an
  off-cycle one (a re-read, a move-in read that reset the dial) has the
  higher of the two as its peak. Summed, a meter read twice would bill
  double capacity. Interval-derived demand is the same rule over blocks.
  (Rao, 2026-11-28.)
- **DEM-ENG-2 (Must).** An agreement with several meters bills the
  **sum of each meter's own peak** (non-coincident) (D3) — the maximum
  is taken per meter, then the meters are added. Taking the maximum
  across meters would bill only the largest and drop the rest.
- **DEM-ENG-3 (Must).** A `peak_demand` component on an agreement whose
  meters measure no demand — no demand register, no interval data —
  **refuses to rate** (`DEMAND_NOT_MEASURED`) rather than billing 0 kW.
  The same rule the TOU buckets follow: an absent quantity is not zero.
- **DEM-ENG-4 (Must).** Ratchet transform:
  `{ type: "ratchet", percent: 75, lookback_periods: 11, months?: [6,7,8,9] }`.
  Billed demand = `max(measured, percent% × highest measured peak in the
  lookback)`. The lookback is the agreement's own demand reads in the
  `lookback_periods` billing periods before this one (D1, D7). `months`,
  when given, admits only peaks measured in those calendar months — a
  summer ratchet (D2).
- **DEM-ENG-5 (Must).** Ratchet history comes from
  `demand:history:<saId>`, a per-agreement variable the meter loader
  fills from `meter_read` — no new table (see the architectural check).
  An agreement younger than its lookback ratchets on what it has.

### The bill

- **DEM-BIL-1 (Must).** A demand line shows the billed kW, and when a
  ratchet set it, says so: *"Demand 42.0 kW — ratchet, 75% of 56.0 kW
  (Jul 2026); measured 31.4 kW"*. A customer billed on a ratchet has to
  be able to see why they paid for capacity they did not use this month.
  Carried as a nullable `basis` text on `bill_segment_line`, written by
  the engine, rather than folded into `label`, so the label stays the
  tariff's.
- **DEM-BIL-2 (Should).** The bill's usage section shows measured peak
  demand per meter next to kWh, with the peak's date and time where the
  source is intervals.
- **DEM-BIL-3 (Should).** The shadow bill (spec 26) prices demand like
  any other component — it already rates through `rateAgreementPeriod`.

### Reading entry

- **DEM-RD-1 (Must).** Read-route entry and manual entry judge a demand
  register's value against the meter's own recent **values**, not
  `last + median consumption`. The e2e entry spec types EM-003's demand
  as a value near its history, not as a cumulative dial.

## Decisions (all seven approved as recommended, 2026-11-28)

| # | Question | Recommendation | Why |
|---|---|---|---|
| D1 | Does the ratchet follow the **agreement** or the **premise**? | Agreement | A new customer at a building is not billed on the previous occupant's peak. A move-in starts a new agreement, so it starts with no history. |
| D2 | Can a ratchet be limited to certain months (a summer ratchet)? | Yes, optional `months` | Common in tariffs whose capacity cost is summer-driven; costs one filter. |
| D3 | Several meters on one agreement: sum of each meter's peak, or the peak of the combined load? | Sum (non-coincident) | The combined peak needs simultaneous intervals on every meter. It can follow for interval-only agreements if a tariff asks for "totalized" demand. |
| D4 | Register and intervals both present: which bills? | Register | It is the device's certified billing determinant; intervals stay as evidence. |
| D5 | Demand interval: fixed clock blocks or a rolling window? | Fixed blocks | What most tariffs mean by "15-minute demand", and the only kind a demand register can report. A rolling window can be added as an option without reshaping anything. |
| D6 | Missing interval data in the period: hold the bill or bill the peak of what is there? | Hold (exception) | The missing hour may be the peak. Undercharging silently is the failure that never gets noticed. |
| D7 | Ratchet basis: prior **measured** peaks or prior **billed** demand? | Measured | NWE and most PSC tariffs ratchet on measured maximum demand. Billing a ratchet on a ratchet would compound it indefinitely. |

## Slices

| Slice | Delivers | Visible result |
|---|---|---|
| 1 | DEM-MEAS-1, -2, DEM-RD-1: demand reads stored as values, energy totals usage-only, entry band for demand registers, e2e spec corrected | No change to any current bill — and the two latent defects closed before anything prices demand |
| 2 | DEM-ENG-1–5, DEM-BIL-1: register demand priced, ratchet from read history, `basis` on the line; GSEDS-1 seeded with a demand charge and the commercial meters given demand registers and a year of peaks; golden test on GSEDS-1 including a ratchet month | Commercial bills include demand |
| 3 | DEM-MEAS-3–6, DEM-BIL-2: interval-derived demand in the roll-up, on-peak demand (RSGTOUD-1), gap handling, peak timestamp on the bill | AMI commercial and the residential demand pilot |

## Out of scope

- **Coincident peak** (billing on the customer's load at the *system's*
  peak hour) — needs system load data from outside.
- **Power factor and kVA demand** — `power_factor` stays unsupported;
  its own spec, with reactive-energy registers.
- **Load factor** discounts.
- **Standby / reservation charges** (SESS-1) — priced on contracted kW,
  a fixed quantity the existing kinds can already express.
- **Rebill** when a demand read is corrected after posting — the general
  rebill workflow (07b, slice 5d), not demand-specific.
