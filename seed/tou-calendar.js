/**
 * A published time-of-use calendar, and the holiday set it names.
 *
 * Without it every TOU screen opens empty on a fresh database, and the
 * one control worth having — the spot check, "what period is Friday 3
 * July at 5:15 pm, and why" — cannot be used at all, because it needs a
 * calendar with hours in it. The same reason the delinquency ladder and
 * the payment plan got modules of their own.
 *
 * Three decisions in here are worth knowing:
 *
 * **It uses the season set the tenant already has.** The `season_sets`
 * migration seeds every tenant a published "Default" set carrying the
 * engine's old hard-coded behaviour, and a TOU calendar's spans are
 * keyed on a set's season *codes*. Creating a second set here would
 * have seeded a problem: a published calendar naming one set while
 * another is in force is exactly the divergence the season editor warns
 * about (spec 26, TOU-SEA-6), and a fresh dev database should not open
 * on a warning about a state nobody caused.
 *
 * **The codes are read, not assumed.** `tou_slot.season_code` is a
 * string with no foreign key, so spans keyed on a code the set does not
 * have would save happily and then price nothing — `resolvePeak` would
 * answer "no period covers 17:15" on every bill. So the spans are built
 * from whatever codes the set actually declares, and the calendar tiles
 * however many there are.
 *
 * **Every (season, day type) is covered exactly once**, because
 * `publishTouCalendar` refuses anything less and this seeds it
 * published. A gap would leave usage uncharged with nothing raised,
 * which is the whole reason that refusal exists.
 *
 * Written with Prisma rather than by calling the services, like every
 * other section of the seed: `seed.js` runs as plain `node seed.js` and
 * cannot import the TypeScript. One consequence worth naming — the
 * `holiday` day type is created here by hand. `createTouCalendar` adds
 * it for a calendar built through the API; a seed writing rows directly
 * gets no such help, and a holiday set with no day type to resolve to
 * would price every holiday by its weekday.
 */

/*
 * Named for what it is for, not for what it currently says.
 *
 * It was "Time of Day 5-8pm" — lifted from SMUD's published tariff,
 * which is the golden fixture the rate engine's tests transcribe. Wrong
 * three times over for a seed: it is another utility's product name
 * sitting in Bozeman's demo data; it names a *rate* where this is the
 * *hours* a rate prices against, which is the distinction that lets a
 * schedule reference a calendar; and a name describing the current peak
 * cannot survive its own next version.
 *
 * That last one decides it. A version IS a (name, effectiveDate) pair,
 * so the name is half the version key — a 2027 calendar moving the peak
 * to 4-9pm has to keep this name to be a new *version* of it. Any name
 * describing today's hours is therefore a bad calendar name by
 * construction.
 */
const CALENDAR_NAME = "Residential time-of-use";
const HOLIDAY_SET_NAME = "Observed holidays";

/** Bozeman. The tariff's zone, not any customer's (TOU-CAL-6). */
const TIME_ZONE = "America/Denver";

const EFFECTIVE_DATE = new Date(Date.UTC(2026, 0, 1));

/**
 * The dates, observed — not the dates on the wall calendar.
 *
 * Every row here is the day the utility actually prices as a holiday,
 * which is the whole argument for holding dates instead of rules
 * (TOU-CAL-4). Three of them show why:
 *
 * - **3 July 2026** — Independence Day falls on the Saturday, so it is
 *   taken on the Friday before. A weekday whose peak hours disappear.
 * - **5 July 2027** — the same holiday falls on the Sunday, so it moves
 *   the other way, to the Monday after.
 * - **24 December 2027** — Christmas on a Saturday, taken on Friday the
 *   24th; the 25th itself is a Saturday and already off-peak.
 *
 * A rule saying "4 July, nearest weekday" produces all three, and says
 * none of them. Nobody reviewing the tariff could see which day their
 * bill will be cheap.
 *
 * Two years, because a set covers a horizon and runs out: a calendar
 * naming a set whose last date is behind it prices no holidays at all,
 * which `holidayHorizonProblems` reports and `publishTouCalendar`
 * refuses. Two years is what the editor is for — the third is typed by
 * whoever is here in 2028.
 */
const HOLIDAYS = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-05-25", name: "Memorial Day" },
  { date: "2026-06-19", name: "Juneteenth" },
  { date: "2026-07-03", name: "Independence Day (observed)" },
  { date: "2026-09-07", name: "Labor Day" },
  { date: "2026-11-11", name: "Veterans Day" },
  { date: "2026-11-26", name: "Thanksgiving Day" },
  { date: "2026-11-27", name: "Day after Thanksgiving" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" },
  { date: "2027-05-31", name: "Memorial Day" },
  { date: "2027-06-18", name: "Juneteenth (observed)" },
  { date: "2027-07-05", name: "Independence Day (observed)" },
  { date: "2027-09-06", name: "Labor Day" },
  { date: "2027-11-11", name: "Veterans Day" },
  { date: "2027-11-25", name: "Thanksgiving Day" },
  { date: "2027-11-26", name: "Day after Thanksgiving" },
  { date: "2027-12-24", name: "Christmas Day (observed)" },
];

const PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "mid_peak", label: "Mid-peak" },
  { peakCode: "peak", label: "On-peak" },
];

/*
 * `holiday` is the one code the engine knows by name: `resolveDayType`
 * matches it before any weekday mapping, so a date in the set named
 * above gets these hours whatever day of the week it lands on. The other
 * two codes are the tenant's own and mean nothing to the engine — the
 * weekday rows are what give them effect.
 */
const DAY_TYPES = [
  { dayTypeCode: "weekday", label: "Weekday", weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", weekdays: [6, 7] },
  { dayTypeCode: "holiday", label: "Holiday", weekdays: [] },
];

const HOUR = 60;

/**
 * The hours for one (season, day type).
 *
 * The first season of the set gets the fuller shape — a shoulder before
 * the peak — so the calendar shows more than one period in use and the
 * 96-quarter strip has something to look at. Later seasons get the
 * simpler peak-and-off-peak shape. Keyed on position rather than on a
 * name because the codes are the tenant's, not ours.
 */
function spansFor(seasonIndex, dayTypeCode) {
  if (dayTypeCode !== "weekday") {
    // Weekends and holidays are off-peak all day, which is what a
    // residential time-of-day tariff actually says.
    return [{ startMinute: 0, endMinute: 24 * HOUR, peakCode: "off_peak" }];
  }
  if (seasonIndex === 0) {
    return [
      { startMinute: 0, endMinute: 15 * HOUR, peakCode: "off_peak" },
      { startMinute: 15 * HOUR, endMinute: 17 * HOUR, peakCode: "mid_peak" },
      { startMinute: 17 * HOUR, endMinute: 20 * HOUR, peakCode: "peak" },
      { startMinute: 20 * HOUR, endMinute: 24 * HOUR, peakCode: "off_peak" },
    ];
  }
  return [
    { startMinute: 0, endMinute: 17 * HOUR, peakCode: "off_peak" },
    { startMinute: 17 * HOUR, endMinute: 20 * HOUR, peakCode: "peak" },
    { startMinute: 20 * HOUR, endMinute: 24 * HOUR, peakCode: "off_peak" },
  ];
}

/**
 * The published holiday set, created if this tenant has none by that
 * name.
 *
 * Seeded published, like the calendar: a published calendar may only
 * name a published set, because a draft set's dates can still change
 * and the calendar's bills cannot. Re-running the seed reuses whatever
 * is there rather than adding dates to it — a published set is
 * immutable, and `putTouHolidays` would refuse the same write from the
 * API.
 */
async function ensureHolidaySet({ p, utilityId }) {
  const existing = await p.touHolidaySet.findFirst({
    where: { utilityId, name: HOLIDAY_SET_NAME },
    orderBy: { effectiveDate: "desc" },
    select: { id: true, name: true, publishedAt: true, _count: { select: { holidays: true } } },
  });
  if (existing) {
    return { id: existing.id, dates: existing._count.holidays, created: false };
  }

  const set = await p.touHolidaySet.create({
    data: {
      utilityId,
      name: HOLIDAY_SET_NAME,
      effectiveDate: EFFECTIVE_DATE,
      publishedAt: new Date(),
    },
  });
  await p.touHoliday.createMany({
    data: HOLIDAYS.map((h) => ({
      utilityId,
      touHolidaySetId: set.id,
      holidayDate: new Date(`${h.date}T00:00:00.000Z`),
      name: h.name,
    })),
  });
  return { id: set.id, dates: HOLIDAYS.length, created: true };
}

async function seedTouCalendar({ p, utilityId }) {
  const existing = await p.touCalendar.findFirst({
    where: { utilityId, name: CALENDAR_NAME, effectiveDate: EFFECTIVE_DATE },
    select: { id: true },
  });
  if (existing) {
    return { skipped: `"${CALENDAR_NAME}" already exists` };
  }

  /*
   * The published set in force, which is what rating would pick for a
   * period starting now (`load-base.ts`). Seeding a calendar against a
   * draft set would make it unpublishable, since `publishTouCalendar`
   * refuses that — correctly, because a draft set can still rename the
   * codes its spans reference.
   */
  const seasonSet = await p.seasonSet.findFirst({
    where: { utilityId, publishedAt: { not: null } },
    orderBy: { effectiveDate: "desc" },
    include: { seasons: { orderBy: { sortOrder: "asc" } } },
  });
  if (!seasonSet) {
    return { skipped: "no published season set for this tenant" };
  }
  if (seasonSet.seasons.length === 0) {
    return { skipped: `season set "${seasonSet.name}" declares no seasons` };
  }

  const holidaySet = await ensureHolidaySet({ p, utilityId });

  const calendar = await p.touCalendar.create({
    data: {
      utilityId,
      name: CALENDAR_NAME,
      effectiveDate: EFFECTIVE_DATE,
      // Published, so a rate schedule can reference it: TOU-CAL-5
      // refuses a published schedule pointing at a draft calendar.
      publishedAt: new Date(),
      seasonSetId: seasonSet.id,
      touHolidaySetId: holidaySet.id,
      timeZone: TIME_ZONE,
      clockBasis: "prevailing",
    },
  });

  const periodByCode = new Map();
  for (const [index, period] of PERIODS.entries()) {
    const row = await p.touPeriod.create({
      data: {
        utilityId,
        touCalendarId: calendar.id,
        peakCode: period.peakCode,
        label: period.label,
        sortOrder: index,
      },
    });
    periodByCode.set(period.peakCode, row.id);
  }

  const dayTypeByCode = new Map();
  for (const [index, dayType] of DAY_TYPES.entries()) {
    const row = await p.touDayType.create({
      data: {
        utilityId,
        touCalendarId: calendar.id,
        dayTypeCode: dayType.dayTypeCode,
        label: dayType.label,
        sortOrder: index,
      },
    });
    dayTypeByCode.set(dayType.dayTypeCode, row.id);
    if (dayType.weekdays.length > 0) {
      await p.touDayTypeWeekday.createMany({
        data: dayType.weekdays.map((isoWeekday) => ({
          utilityId,
          touCalendarId: calendar.id,
          touDayTypeId: row.id,
          isoWeekday,
        })),
      });
    }
  }

  let spanCount = 0;
  for (const [seasonIndex, season] of seasonSet.seasons.entries()) {
    for (const dayType of DAY_TYPES) {
      const spans = spansFor(seasonIndex, dayType.dayTypeCode);
      await p.touSlot.createMany({
        data: spans.map((span) => ({
          utilityId,
          touCalendarId: calendar.id,
          seasonCode: season.seasonCode,
          touDayTypeId: dayTypeByCode.get(dayType.dayTypeCode),
          touPeriodId: periodByCode.get(span.peakCode),
          startMinute: span.startMinute,
          endMinute: span.endMinute,
        })),
      });
      spanCount += spans.length;
    }
  }

  return {
    calendarId: calendar.id,
    name: CALENDAR_NAME,
    seasonSetName: seasonSet.name,
    seasonCodes: seasonSet.seasons.map((s) => s.seasonCode),
    periods: PERIODS.length,
    dayTypes: DAY_TYPES.length,
    spans: spanCount,
    holidaySetName: HOLIDAY_SET_NAME,
    holidayDates: holidaySet.dates,
    holidaySetReused: !holidaySet.created,
    timeZone: TIME_ZONE,
  };
}

module.exports = { seedTouCalendar };
