/**
 * A published time-of-use calendar, and the holiday list it names.
 *
 * Without it every TOU screen opens empty on a fresh database, and the
 * one control worth having — the spot check, "what period is Tuesday 3
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
 * cannot import the TypeScript.
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
const HOLIDAY_LIST_NAME = "Observed holidays";

/** Bozeman. The tariff's zone, not any customer's (TOU-CAL-6). */
const TIME_ZONE = "America/Denver";

const EFFECTIVE_DATE = new Date(Date.UTC(2026, 0, 1));

/**
 * Real rules, with the observances that make them interesting.
 *
 * `NEAREST_WEEKDAY` is the one that catches people out: 4 July 2026 is a
 * Saturday, so it is observed on Friday 3 July — a weekday whose peak
 * hours disappear. A list of fixed dates could not express that, which
 * is why the model holds rules (TOU-CAL-4).
 */
const HOLIDAY_RULES = [
  { code: "new_year", label: "New Year's Day", kind: "FIXED", month: 1, day: 1, observance: "NEAREST_WEEKDAY" },
  { code: "memorial_day", label: "Memorial Day", kind: "NTH_WEEKDAY", month: 5, weekday: 1, nth: -1, observance: "NONE" },
  { code: "independence_day", label: "Independence Day", kind: "FIXED", month: 7, day: 4, observance: "NEAREST_WEEKDAY" },
  { code: "labor_day", label: "Labor Day", kind: "NTH_WEEKDAY", month: 9, weekday: 1, nth: 1, observance: "NONE" },
  { code: "thanksgiving", label: "Thanksgiving", kind: "NTH_WEEKDAY", month: 11, weekday: 4, nth: 4, observance: "NONE" },
  { code: "christmas", label: "Christmas Day", kind: "FIXED", month: 12, day: 25, observance: "NEAREST_WEEKDAY" },
];

const PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "mid_peak", label: "Mid-peak" },
  { peakCode: "peak", label: "On-peak" },
];

const DAY_TYPES = [
  { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [6, 7] },
  // The flag, not the code: TOU-CAL-2 leaves the vocabulary open, so
  // nothing in the engine may match a literal "holiday".
  { dayTypeCode: "holiday", label: "Holiday", isHoliday: true, weekdays: [] },
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

  const holidayList = await p.touHolidayList.upsert({
    where: { utilityId_name: { utilityId, name: HOLIDAY_LIST_NAME } },
    update: {},
    create: { utilityId, name: HOLIDAY_LIST_NAME },
  });
  for (const rule of HOLIDAY_RULES) {
    await p.touHolidayRule.upsert({
      where: {
        utilityId_touHolidayListId_code: {
          utilityId,
          touHolidayListId: holidayList.id,
          code: rule.code,
        },
      },
      update: {},
      create: {
        utilityId,
        touHolidayListId: holidayList.id,
        code: rule.code,
        label: rule.label,
        kind: rule.kind,
        month: rule.month,
        day: rule.day ?? null,
        weekday: rule.weekday ?? null,
        nth: rule.nth ?? null,
        observance: rule.observance,
      },
    });
  }

  const calendar = await p.touCalendar.create({
    data: {
      utilityId,
      name: CALENDAR_NAME,
      effectiveDate: EFFECTIVE_DATE,
      // Published, so a rate schedule can reference it: TOU-CAL-5
      // refuses a published schedule pointing at a draft calendar.
      publishedAt: new Date(),
      seasonSetId: seasonSet.id,
      touHolidayListId: holidayList.id,
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
        isHoliday: dayType.isHoliday,
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
    holidayRules: HOLIDAY_RULES.length,
    timeZone: TIME_ZONE,
  };
}

module.exports = { seedTouCalendar };
