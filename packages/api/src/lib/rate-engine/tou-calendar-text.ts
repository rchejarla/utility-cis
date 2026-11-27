/**
 * A TOU calendar's hours, in the words a bill prints (spec 26, TOU-BIL-2):
 * "Peak: 5–8 pm weekdays, excluding holidays. Off-peak: all other hours."
 *
 * Pure, like the rest of the engine, and deliberately small: it reads the
 * spans a published calendar is made of and says what they say. Nothing
 * here decides a price.
 *
 * **One season — the one the bill was priced in.** Pricing resolves a
 * single season for a service period, from its start date
 * (`evaluators/predicate.ts`, `computeSeason`). Describing every season the
 * calendar has would put hours on the bill that were not charged, so the
 * caller names the season and only its spans are read.
 *
 * **The largest period is "all other hours"** (decided 2026-11-27): the
 * period with the most minutes in a week is named last, without hours. It
 * is how rate sheets read, and it is shorter than spelling out the night.
 */

import type { SeasonDefinition } from "./seasons.js";
import {
  HOLIDAY_DAY_TYPE_CODE,
  type IsoWeekday,
  type TouCalendarDefinition,
} from "./tou-calendar.js";

const DAY = 1440;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface TouHoursInput {
  definition: TouCalendarDefinition;
  seasons: SeasonDefinition[];
  /** The season the bill was priced in. */
  seasonCode: string;
  /** Peak code → the tenant's display label. A code with no label prints as itself. */
  periodLabels: Map<string, string>;
  /** Peak codes in display order (the tenant's `TouPeriod.sortOrder`). */
  periodOrder: string[];
  /** `standard` means the hours do not move with daylight saving time. */
  clockBasis: string;
}

/** A half-open range of minutes; `end` may exceed 1440 for a range that runs past midnight. */
type Range = [number, number];

/**
 * The footnote, one string per line: a heading naming the season, then one
 * line per period in display order, with the largest period last as "all
 * other hours". Empty when the season prices nothing.
 */
export function describeTouHours(input: TouHoursInput): string[] {
  const { definition, seasons, seasonCode, periodLabels, periodOrder, clockBasis } = input;
  const label = (code: string) => periodLabels.get(code) ?? code;

  const weekdayTypes = definition.dayTypes.filter((d) => d.weekdays.length > 0);
  const holidayType = definition.dayTypes.find((d) => d.dayTypeCode === HOLIDAY_DAY_TYPE_CODE);

  // Peak code → day type → merged ranges, for this season only.
  const byPeak = new Map<string, Map<string, Range[]>>();
  for (const dayType of definition.dayTypes) {
    const spans = definition.slots
      .filter((s) => s.seasonCode === seasonCode && s.dayTypeCode === dayType.dayTypeCode)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (const [peak, ranges] of mergeByPeak(spans)) {
      const forPeak = byPeak.get(peak) ?? new Map<string, Range[]>();
      forPeak.set(dayType.dayTypeCode, ranges);
      byPeak.set(peak, forPeak);
    }
  }
  if (byPeak.size === 0) return [];

  // Minutes per week on ordinary days, to find the period named "all other hours".
  const weekly = (peak: string) =>
    weekdayTypes.reduce(
      (sum, d) => sum + minutes(byPeak.get(peak)?.get(d.dayTypeCode) ?? []) * d.weekdays.length,
      0,
    );
  const present = [
    ...periodOrder.filter((c) => byPeak.has(c)),
    ...[...byPeak.keys()].filter((c) => !periodOrder.includes(c)).sort(),
  ];
  const largest = present.reduce((best, c) => (weekly(c) > weekly(best) ? c : best), present[0]!);

  const lines: string[] = [heading(seasons, seasonCode, clockBasis)];
  if (present.length === 1) {
    lines.push(`${label(present[0]!)}: all hours.`);
    return lines;
  }

  for (const peak of present) {
    if (peak === largest) continue;
    const forPeak = byPeak.get(peak)!;

    // Day types with the same hours read as one phrase: "5–8 pm weekdays".
    const byText = new Map<string, IsoWeekday[]>();
    for (const d of weekdayTypes) {
      const ranges = forPeak.get(d.dayTypeCode);
      if (!ranges || ranges.length === 0) continue;
      const text = rangesText(ranges);
      byText.set(text, [...(byText.get(text) ?? []), ...d.weekdays]);
    }
    const parts = [...byText.entries()].map(([text, days]) => `${text} ${daysText(days)}`);
    if (parts.length === 0 && !holidayType) continue;

    let holidayClause = "";
    if (holidayType && parts.length > 0) {
      const onHolidays = forPeak.get(holidayType.dayTypeCode);
      if (!onHolidays || onHolidays.length === 0) holidayClause = ", excluding holidays";
      else if (![...byText.keys()].includes(rangesText(onHolidays))) {
        holidayClause = `; ${rangesText(onHolidays)} on holidays`;
      }
    } else if (holidayType && parts.length === 0) {
      const onHolidays = forPeak.get(holidayType.dayTypeCode);
      if (onHolidays && onHolidays.length > 0) parts.push(`${rangesText(onHolidays)} on holidays`);
    }
    if (parts.length === 0) continue;

    lines.push(`${label(peak)}: ${parts.join("; ")}${holidayClause}.`);
  }
  lines.push(`${label(largest)}: all other hours.`);
  return lines;
}

/** "Summer season (1 Jun – 30 Sep)", with the clock basis when it is not the default. */
function heading(seasons: SeasonDefinition[], seasonCode: string, clockBasis: string): string {
  const season = seasons.find((s) => s.seasonCode === seasonCode);
  const name = humanize(seasonCode);
  const span = season
    ? ` (${season.startDay} ${MONTHS[season.startMonth - 1]} – ${season.endDay} ${MONTHS[season.endMonth - 1]})`
    : "";
  const clock = clockBasis === "standard" ? ", standard time all year" : "";
  return `Time-of-day periods, ${name.toLowerCase()} season${span}${clock}:`;
}

/** Spans of one day type, merged per peak code where they touch — including across midnight. */
function mergeByPeak(
  spans: Array<{ startMinute: number; endMinute: number; peakCode: string }>,
): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  for (const s of spans) {
    const ranges = out.get(s.peakCode) ?? [];
    const last = ranges[ranges.length - 1];
    if (last && last[1] === s.startMinute) last[1] = s.endMinute;
    else ranges.push([s.startMinute, s.endMinute]);
    out.set(s.peakCode, ranges);
  }
  // A period that ends the day and starts it is one range through midnight.
  for (const ranges of out.values()) {
    if (ranges.length > 1 && ranges[0]![0] === 0 && ranges[ranges.length - 1]![1] === DAY) {
      const first = ranges.shift()!;
      ranges[ranges.length - 1]![1] = DAY + first[1];
    }
  }
  return out;
}

function minutes(ranges: Range[]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
}

function rangesText(ranges: Range[]): string {
  if (ranges.length === 1 && ranges[0]![0] === 0 && ranges[0]![1] === DAY) return "all day";
  return [...ranges]
    .sort((a, b) => a[0] - b[0])
    .map(([a, b]) => rangeText(a, b))
    .join(" and ");
}

/** "4–9 pm", "7 am–4 pm", "9 pm–7 am", "noon–6 pm". */
function rangeText(start: number, end: number): string {
  const a = clock(start);
  const b = clock(end);
  if (a.meridiem && a.meridiem === b.meridiem) return `${a.text}–${b.text} ${b.meridiem}`;
  return `${a.full}–${b.full}`;
}

function clock(minute: number): { text: string; meridiem: string; full: string } {
  const m = ((minute % DAY) + DAY) % DAY;
  if (m === 0) return { text: "midnight", meridiem: "", full: "midnight" };
  if (m === 720) return { text: "noon", meridiem: "", full: "noon" };
  const h = Math.floor(m / 60);
  const mm = m % 60;
  const meridiem = h < 12 ? "am" : "pm";
  const text = `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
  return { text, meridiem, full: `${text} ${meridiem}` };
}

/** "weekdays", "weekends", "every day", "Mon–Thu", or "Mon, Wed". */
function daysText(days: IsoWeekday[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join("");
  if (key === "12345") return "weekdays";
  if (key === "67") return "weekends";
  if (key === "1234567") return "every day";
  const contiguous = set.every((d, i) => i === 0 || d === set[i - 1]! + 1);
  if (contiguous && set.length > 2) return `${WEEKDAY_SHORT[set[0]! - 1]}–${WEEKDAY_SHORT[set[set.length - 1]! - 1]}`;
  return set.map((d) => WEEKDAY_SHORT[d - 1]).join(", ");
}

function humanize(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
