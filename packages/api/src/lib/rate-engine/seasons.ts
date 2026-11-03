/**
 * Tenant-configured seasons (spec 26, TOU-SEA-1 – 3).
 *
 * A season is a month/day range that repeats every year and may wrap
 * the year end (Nov 1 – Mar 31). A tenant's set must cover every day of
 * the year exactly once.
 *
 * Pure, and deliberately so: the engine never queries, and slice 2's
 * per-interval classification (TOU-SEA-4) needs the same resolution
 * against the same definitions, one interval at a time. A loader that
 * resolved the season itself and passed a single answer would have to
 * be unpicked then.
 *
 * Replaces `seasonOf()`, which hard-coded summer as May–October for
 * every tenant.
 */

export interface SeasonDefinition {
  /**
   * What a tariff's `season` predicate compares against.
   *
   * Qualified rather than a bare `code` because a TOU calendar resolves
   * three of these vocabularies at once — season, day type and peak —
   * and in this layer all three are plain strings. Passing one where
   * another belongs would compile, run, and classify every interval
   * wrong with nothing raised anywhere.
   */
  seasonCode: string;
  /** 1–12. */
  startMonth: number;
  startDay: number;
  endMonth: number;
  endDay: number;
}

export type SeasonValidation = { ok: true } | { ok: false; problems: string[] };

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A leap year, on purpose.
 *
 * Validation enumerates the days of 2028 — 366 of them — because any
 * day that exists in *some* year has to belong to a season. A set that
 * ends one season on 28 February and starts the next on 1 March tiles
 * 365 days exactly and loses a day every fourth year, which is a fault
 * that ships and then waits.
 */
const LEAP_YEAR = 2028;

/** 1-based month and day → the day's ordinal in a leap year. */
function ordinal(month: number, day: number): number {
  return Math.round(
    (Date.UTC(LEAP_YEAR, month - 1, day) - Date.UTC(LEAP_YEAR, 0, 1)) / 86_400_000,
  );
}

function label(month: number, day: number): string {
  return `${day} ${MONTH_NAMES[month - 1] ?? month}`;
}

function daysInMonth(month: number): number {
  return new Date(Date.UTC(LEAP_YEAR, month, 0)).getUTCDate();
}

/** Every ordinal a season covers, unwrapping a range that crosses the year end. */
function coveredOrdinals(season: SeasonDefinition): number[] {
  const from = ordinal(season.startMonth, season.startDay);
  const to = ordinal(season.endMonth, season.endDay);
  const total = ordinal(12, 31) + 1;
  const out: number[] = [];
  if (from <= to) {
    for (let i = from; i <= to; i++) out.push(i);
  } else {
    // Wraps: Nov 1 – Mar 31 is "from November to the year end, then
    // from the year start to March".
    for (let i = from; i < total; i++) out.push(i);
    for (let i = 0; i <= to; i++) out.push(i);
  }
  return out;
}

function isRealDate(month: number, day: number): boolean {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(month);
}

/**
 * Which seasons claim each day of the year, by ordinal.
 *
 * 366 entries, because the year enumerated is a leap year on purpose —
 * see `LEAP_YEAR`. Exported so the season editor's year bar is drawn
 * from the same computation that decides whether the set is valid: a
 * screen with its own containment arithmetic would eventually show a
 * tidy green year for a set the validator rejects, and the wrap case
 * (Nov 1 – Mar 31) is exactly where that would happen.
 *
 * A season whose boundary is not a real date claims nothing, which is
 * the truth — `30 February` covers no day — and leaves those days
 * showing as uncovered while `validateSeasons` names the real fault.
 */
export function seasonCoverage(seasons: SeasonDefinition[]): string[][] {
  const total = ordinal(12, 31) + 1;
  const claimedBy: string[][] = Array.from({ length: total }, () => []);
  for (const s of seasons) {
    if (!isRealDate(s.startMonth, s.startDay) || !isRealDate(s.endMonth, s.endDay)) continue;
    for (const day of coveredOrdinals(s)) claimedBy[day].push(s.seasonCode);
  }
  return claimedBy;
}

/** The month and day an ordinal falls on, for labelling the year bar. */
export function ordinalDate(day: number): { month: number; day: number } {
  const d = new Date(Date.UTC(LEAP_YEAR, 0, 1) + day * 86_400_000);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Does this set cover every day of the year exactly once?
 *
 * Reports **every** gap and overlap by date rather than stopping at the
 * first, because a season set is edited as a whole and fixing one
 * boundary usually moves another: being told about one at a time turns
 * one save into four.
 */
export function validateSeasons(seasons: SeasonDefinition[]): SeasonValidation {
  if (seasons.length === 0) {
    return { ok: false, problems: ["A season set needs at least one season."] };
  }

  const problems: string[] = [];

  // Bad dates first. An unreal boundary makes the coverage arithmetic
  // meaningless, so reporting 366 gaps on top of it would bury it.
  for (const s of seasons) {
    if (!isRealDate(s.startMonth, s.startDay)) {
      problems.push(`Season "${s.seasonCode}" starts on ${label(s.startMonth, s.startDay)}, which is not a date.`);
    }
    if (!isRealDate(s.endMonth, s.endDay)) {
      problems.push(`Season "${s.seasonCode}" ends on ${label(s.endMonth, s.endDay)}, which is not a date.`);
    }
  }

  const seen = new Set<string>();
  for (const s of seasons) {
    if (seen.has(s.seasonCode)) {
      problems.push(`Two seasons are both called "${s.seasonCode}"; a tariff could not tell them apart.`);
    }
    seen.add(s.seasonCode);
  }

  if (problems.length > 0) return { ok: false, problems };

  const claimedBy = seasonCoverage(seasons);
  const total = claimedBy.length;

  for (let day = 0; day < total; day++) {
    const d = new Date(Date.UTC(LEAP_YEAR, 0, 1) + day * 86_400_000);
    const name = label(d.getUTCMonth() + 1, d.getUTCDate());
    const claims = claimedBy[day];
    if (claims.length === 0) {
      problems.push(`${name} belongs to no season.`);
    } else if (claims.length > 1) {
      problems.push(`${name} is claimed by more than one season: ${claims.join(", ")}.`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Which season a date falls in, or null if none claims it.
 *
 * **Null rather than a guess.** Only an unvalidated set can produce it,
 * and the caller decides whether that is a rating failure or a
 * fallback — silently picking the first season would price a bill
 * against a tariff nobody chose.
 *
 * Read in UTC, like every date in the engine: a period's bounds come
 * from `@db.Date` columns, which Prisma returns as UTC midnight, and
 * local getters turn 1 January into 31 December anywhere west of
 * Greenwich.
 */
export function resolveSeason(date: Date, seasons: SeasonDefinition[]): string | null {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const target = ordinal(month, day);

  for (const s of seasons) {
    const from = ordinal(s.startMonth, s.startDay);
    const to = ordinal(s.endMonth, s.endDay);
    const inside =
      from <= to ? target >= from && target <= to : target >= from || target <= to;
    if (inside) return s.seasonCode;
  }
  return null;
}
