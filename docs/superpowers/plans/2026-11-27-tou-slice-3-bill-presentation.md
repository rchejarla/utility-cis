# Spec 26 slice 3 — TOU on the bill

**Status:** plan, 2026-11-27, **decisions made** (see the end). Nothing
built.

**Scope:** spec 26 §6 — TOU-BIL-2 (Must), TOU-BIL-3 (Should), TOU-BIL-4
(Should). TOU-BIL-1, the pre-run check, is built.

**Headline:** TOU-BIL-2 needs **no schema change** — everything the bill
needs is already in rows that cannot change. Only the shadow bill needs a
migration (one nullable column). Five slices, each shippable alone.

---

## Facts established (verified against the code)

**Bill rendering knows nothing about TOU.** `loadBillPresentation`
(`services/bill-presentation/load.ts`) loads segments and lines and hands
them to `chargeGroups` (`charges.ts`), which makes one group per commodity
and prints each stored line as it is. `BillPresentation`
(`bill-presentation/document.ts`) is the one string-only shape every
surface reads: the PDF template (`bill-template/default-bill.tsx`) and the
staff bill dialog (`GET /api/v1/bills/:id/presentation`). Spec 09 promises
a reprint is byte-identical. A text-extraction golden test exists
(`__tests__/bill-generation/generate-bill-pdf.test.ts`).

**A TOU bill line does not record its period, season or price.**
`BillSegmentLine` stores label, kind, amount, quantity, unit,
`sourceScheduleId` and `sourceComponentId` — nothing else. The engine's
line carries the rate, but the save drops it (`bill-segment.service.ts`,
step 8). **It is all recoverable, and stably:** a published schedule's
components refuse edits (`rate-component.service.ts`,
`SCHEDULE_NOT_EDITABLE`), so joining a line to its component through
`sourceComponentId` gives `quantitySource.peak_code`, `predicate.season`
and `pricing.rate`, and always the same answer.

**Zero-price and zero-usage periods vanish from the lines.** The engine
suppresses zero-amount lines (pinned by the SMUD golden test). But the
**buckets** exist as rows for both meter kinds — the interval roll-up seeds
every period the calendar uses at zero, and register imports must write
zero rows — so the bill can show "Off-peak 0.0 kWh" from the buckets even
where no line exists.

**Pricing uses one season per bill**: the season at the period's **start
date** (`evaluators/predicate.ts`, `computeSeason`). So the bill's period
table is per TOU period, not per (period, season).

**The calendar a bill used is exact:** `rate_schedule.tou_calendar_id`
names one calendar version, and the billing run classifies with that id.
The calendar's hours are in `TouSlot.startMinute/endMinute` (half-open),
weekday coverage in `TouDayTypeWeekday`, seasons with labels and
month/day bounds, holidays via the calendar's holiday set, and the clock in
`timeZone` + `clockBasis`. **Nothing turns spans into words today** — only
two private helpers that print "17:15".

**The portal's usage is wrong for TOU meters today.**
`web/app/portal/usage/page.tsx` adds up `consumption` from every read,
buckets included, so a TOU meter's month counts its total read *and* its
buckets. It also prints `Number(r.reading)` where `reading` can now be
null. The usage endpoint returns raw reads with no peak code, no intervals
and no link to a billed period. "Hourly" is a disabled button.

**Shadow bill:** no schedule links to a "standard" one anywhere. Rating is
inline in `createBillSegmentForServiceAgreement`; the engine itself is
pure. `meter:reads` falls back to the sum of the buckets when a meter has
no total read, so a non-TOU schedule would see the period's total usage.
Tenant TOU settings already have a home: `settings.tou`
(`validators/tenant-settings.ts`, `touSettingsSchema`).

## Where the code and spec 26 disagree (to fix in the spec)

1. §2 says the calendar version is resolved by name as of the period
   start. Production uses the schedule's exact version by id
   (`loadTouCalendar` by name is called only by tests).
2. TOU-ENG-8 says a line carries period, season and price. It carries the
   component's label; the rest is recoverable through the component.
3. TOU-ENG-3 / TOU-SEA-4 read as per-interval seasons. That is true for
   classifying intervals into periods; **pricing** uses one season per bill.
4. Spec 15 still lists hourly usage as future work, and does not mention
   that monthly totals are wrong for TOU meters.

---

## Slice 1 — TOU-BIL-2, and the bill half of TOU-BIL-3 (M)

**What the customer sees:** after each commodity's charges, a **Usage by
time of day** table — Period / Usage / Share / Amount — and a footnote
naming each period's hours ("On-peak: 4–9 pm weekdays, Jun–Sep, excluding
holidays").

- **`bill-presentation/tou.ts` — `loadTouSections(utilityId, bill)`.** For
  each segment rated on a schedule with a TOU calendar:
  - one row per peak code the schedule prices (its `tou_period`
    components), ordered by `TouPeriod.sortOrder`;
  - **amount**: the sum of that code's lines, via the component join;
  - **usage**: the line's quantity where a line exists (that is what was
    charged); otherwise the bucket total from `meter_read` for the
    segment's meters and period, **bounded by `createdAt <=
    segment.createdAt`** so a late correction cannot change a reprint;
  - **unit price**: shown for `flat` pricing, blank otherwise;
  - **share**: each row's percentage of the total — this *is* "share of
    usage on-peak" (TOU-BIL-3) without having to decide which tenant code
    counts as "the peak".
- **`lib/rate-engine/tou-calendar-text.ts` — `describeTouHours(...)`**, a
  pure function: only the seasons the bill period touches; adjacent spans
  merged; day types named from their weekdays ("weekdays", "weekends", or
  a list); "excluding holidays" when the holiday day type does not carry
  the period; 12-hour times ("4–9 pm"); "(standard time)" when
  `clockBasis = standard`.
- **`BillPresentation` gains `touSections`** — `[]` for a bill without
  TOU, so every existing bill renders byte-for-byte as before.
- The calendar loader also returns season labels (it drops them today).
- **PDF template and staff bill dialog** render the table and footnote.
  The table is information, not a charge group: it adds nothing to totals.

**No migration. API:** `/bills/:id/presentation` gains `touSections`.

**Tests:** unit tests for `describeTouHours` (the SMUD calendar, a
two-period calendar, a season across the year end, standard time, a
Saturday day type); unit test for `loadTouSections` including a $0-price
period that still shows its usage; integration against real Postgres —
bill the SMUD tariff for a June period with no on-peak usage and assert a
peak row of "0.00 kWh / $0.00", and that a correction read added after
the segment does not change the output; golden PDF text — headings, rows,
footnote, unchanged total.

**Considered:** looping over the stored lines — rejected, it silently drops
any period with no line, which spec 26 already names as the failure.
A frozen `bill_segment_tou_usage` table written at rating time — rejected
for now: a table, RLS and a second copy of reads, for stability the
`createdAt` bound already gives.

## Slice 2 — portal usage by period and by hour (M), TOU-BIL-3 portal half

- **First, fix today's bug (S):** monthly totals skip bucket rows when a
  total read exists (the meter loader's own rule); a null `reading` shows
  "—".
- **`GET /portal/api/agreements/:id/billed-periods`** — segments on
  **posted** bills of an agreement the customer owns.
- **`GET /portal/api/agreements/:id/billed-periods/:segmentId/usage`** —
  `byPeriod` from the same `loadTouSections` builder (the portal cannot
  disagree with the PDF), and `hourly`: the period's intervals classified
  against the schedule's calendar and grouped by local hour; `null` for a
  register meter.
- Ownership in the query (`requireCustomerId` + `customerId`), 404 on a
  miss, unposted bills withheld — the portal's existing rules.
- **UI:** a billed-period picker on the usage page for TOU agreements; the
  period table; "Hourly" enabled as stacked bars by period; a register
  meter says hourly data isn't available.

**Tests:** ownership 404; unposted withheld; a 15-minute meter rolled into
hours with peak hours right across the fall-back DST day; register meter
gives `hourly: null`; page component test.

**Considered:** storing the hourly roll-up — rejected: one meter-month is
at most 2,880 rows, cheap to read on demand.

## Slice 3a — shadow bill for staff, TOU → standard (M), TOU-BIL-4

**What staff see:** for a TOU customer, in the bill dialog, "Compared with
the standard rate: $X — you saved / paid $Y more", labelled an estimate.

- **Migration (hand-written):** `rate_schedule.comparison_schedule_code
  varchar(50) NULL` — a **code**, not an id, because the other tariff is
  versioned on its own; the version is resolved per period (published,
  effective by the period start, highest). **One column, both directions:**
  a TOU schedule names its standard rate (used here), and a standard
  schedule names its TOU alternative (used by 3b). Validated when set: the
  code exists, same commodity, and **the opposite kind** — exactly one of
  the pair has a TOU calendar. Draft-only, like the calendar (decision 2);
  copied by revise.
- **Refactor, justified now that a second caller exists:** pull the rating
  steps of `createBillSegmentForServiceAgreement` into
  `rateAgreementPeriod(tx, utilityId, saId, period, { substitute? })`.
  Segment creation calls it and does the writes; the shadow bill calls it
  and writes nothing.
- **`shadowBillForSegment(utilityId, segmentId)`** — swaps the TOU
  schedule for the comparison schedule (other roles kept), rates, returns
  `{ comparisonSchedule, lines, total, actualTotal, difference }`, or 422
  `NO_COMPARISON_SCHEDULE`.
- **`GET /api/v1/bill-segments/:id/shadow`** (`accounts:VIEW`). Never on
  the PDF, which stays byte-stable.
- **UI:** the comparison panel in the bill dialog; a comparison-schedule
  picker in the rate schedule editor.

**Tests:** substitution unit test; integration — TOU vs flat gives the
expected difference, missing comparison gives the 422; the billing-run and
segment suites stay green (proves the refactor).

**Considered:** storing the shadow total at rating time — rejected: a
column and slower rating for every TOU bill, for a figure staff look at
occasionally.

## Slice 3b — shadow bill for staff, "considering TOU" (M), TOU-BIL-4

**What staff see:** for a standard-rate customer **with an interval
meter**, "On the TOU rate this period would have cost $X". For a customer
whose meter records no time of day, the panel says the estimate needs
interval data — never a guess.

Built after 3a and slice 2, because it reuses both.

- **Which TOU rate:** the standard schedule's `comparison_schedule_code`
  (the column from 3a, other direction). 422 `NO_COMPARISON_SCHEDULE`
  when unset; 422 `NO_INTERVAL_DATA` for a meter with no intervals in the
  period.
- **Usage by period, computed and not stored:** the period's intervals
  classified against the TOU schedule's calendar in memory —
  the same classification slice 2's hourly view does (`toLocalMoment` +
  `resolvePeak`), summed per peak code. `rollUpIntervals` cannot be used
  as it stands: it writes `meter_read` rows, which for a customer not on
  TOU would be fabricated buckets the next real bill could pick up.
- **Rating from computed buckets:** `rateAgreementPeriod` (from 3a) gains a
  way to supply the period's TOU quantities directly instead of the meter
  loader reading `meter_read`. This is the engine-side hook rate modeling
  (spec 26 slice 4 / spec 29) needs too, so it is shared groundwork, not a
  one-off.
- **`shadowBillForSegment`** branches on direction: a TOU segment → 3a; a
  standard segment with a comparison schedule → this path. Same response
  shape, same endpoint, plus `direction`.
- **UI:** the same comparison panel, worded for the direction.

**Tests:** in-memory classification matches what the roll-up would have
written for the same intervals (one assertion, both paths); integration —
an interval-metered standard customer gets a TOU estimate equal to rating
a real roll-up of the same data; a register meter gets 422
`NO_INTERVAL_DATA`; **nothing is written** (no `meter_read` rows before
and after).

**Considered:** running the real roll-up inside a transaction and rolling
it back — rejected: it couples an estimate to the write path's locks and
side effects, and a rollback is not a design.

## Slice 4 — shadow bill in the portal (S)

- `settings.tou.portalShadowBill` (boolean, default off) — jsonb per spec
  18, since only TOU tenants have it and it is read off a row in hand; a
  toggle beside the TOU settings.
- The slice 2 usage endpoint includes `shadow` only when it is on — for
  **both** directions: a TOU customer sees the standard-rate comparison,
  an interval-metered standard customer sees the TOU estimate.
- Tests: off → absent; on → present in each direction.

## Risks

1. **Riders that select TOU components.** A percentage tax on energy
   would match nothing once TOU components are swapped out, and silently
   fall to zero in the shadow bill. Refuse the shadow bill if any selector
   references a substituted component; test it.
2. **The shadow bill reads usage as it is now**, not as of rating. It is
   labelled an estimate; exact reproduction would mean threading an as-of
   date through the meter loader.
3. **One season per bill** shows as one season label even when a bill
   straddles a season change — accurate to what was charged, possibly
   surprising.
4. **`TouPeriod.label` is editable and unversioned**, so regenerating a
   bill after a label edit changes its bytes. Document in spec 09.

## Decisions (product owner, 2026-11-27)

1. **Shadow bill: both directions.** TOU → standard (3a) first; "considering
   TOU" (3b) after it and slice 2, limited to interval-metered customers
   and saying so for the rest. The rating-from-computed-buckets hook it
   needs is shared groundwork for modeling.
2. **Comparison schedule: draft schedules only**, like the TOU calendar; a
   published schedule gets one by revising.
3. **On-peak share: a share column for every period** — no "this is the
   peak" flag on `tou_period`.
4. **Footnote: "all other hours" for the largest period**, every other
   period spelled out.

## Order and size

Slice 1 (M) → slice 2 (M, starting with the S portal bug fix) → slice 3a
(M) → slice 3b (M) → slice 4 (S). Slice 1 alone delivers the Must. The
portal bug fix at the head of slice 2 is worth doing first regardless —
customers on TOU meters see wrong monthly totals today.
