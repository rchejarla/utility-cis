/**
 * Stored instant → local wall clock (spec 26, TOU-CAL-6 and TOU-CAL-7).
 *
 * Interval timestamps are stored in UTC and a TOU calendar classifies by
 * local wall-clock time, so something has to convert between them. This
 * is that something, and it is deliberately the only module in the
 * engine that knows a time zone exists: TOU-CAL-7 classifies the
 * repeated fall-back hour twice, "both by the same wall-clock rule", so
 * the classifying rule must not know about offsets, and the offsets must
 * not know about peaks.
 *
 * No dependency: `Intl` carries the full IANA database in Node, and the
 * offset at an instant is recoverable by formatting it in the zone and
 * reading the parts back as if they were UTC.
 */

/**
 * How a calendar's hours relate to the clock on the wall (TOU-CAL-6).
 *
 * `prevailing` follows daylight saving, which is the common case.
 * `standard` means standard time all year, so during daylight saving a
 * tariff's "4–9 pm" peak runs 5–10 pm by the clock — written into some
 * tariffs precisely so the peak tracks the sun rather than the clock.
 */
export type ClockBasis = "prevailing" | "standard";

export interface LocalMoment {
  /** The local calendar day, as UTC midnight — the engine's date shape. */
  date: Date;
  /** Minutes from local midnight, 0–1439. */
  minuteOfDay: number;
}

const MINUTE_MS = 60_000;

/**
 * Formatters are cached because a classification pass builds one per
 * interval otherwise — 2,880 a month per meter — and constructing an
 * `Intl.DateTimeFormat` is the expensive part of this module by orders
 * of magnitude.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  // Throws RangeError on an unknown zone, which is what we want: a typo
  // in a published calendar's zone would otherwise fall back to UTC and
  // shift every peak by hours with nothing raised.
  const built = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatters.set(timeZone, built);
  return built;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl gave no ${type} for ${timeZone}`);
    return Number(found.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The zone's offset from UTC, in minutes, at a given instant.
 *
 * Positive east of Greenwich. Found by formatting the instant in the
 * zone and reading those parts back as though they were UTC: the
 * difference between that and the instant itself *is* the offset.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Seconds, not milliseconds: Intl does not report sub-second parts,
  // so the two sides have to be compared at the precision both have.
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return (asIfUtc - truncated) / MINUTE_MS;
}

/**
 * The zone's standard-time offset for a year, in minutes.
 *
 * **The lesser of the January and July offsets.** Daylight saving always
 * moves the clock *forward*, so the daylight offset is always the
 * greater of the two and standard is the lesser — which holds in both
 * hemispheres. "Sample January" would call Sydney's daylight time
 * standard and run every peak there an hour early for a whole year.
 *
 * Taken per year rather than once, because zones change their rules and
 * a calendar published in one year must keep classifying the year it
 * was published for.
 */
export function standardOffsetMinutes(timeZone: string, year: number): number {
  const january = zoneOffsetMinutes(new Date(Date.UTC(year, 0, 15, 12)), timeZone);
  const july = zoneOffsetMinutes(new Date(Date.UTC(year, 6, 15, 12)), timeZone);
  return Math.min(january, july);
}

/**
 * The local calendar day and minute-of-day an instant falls on.
 *
 * On a `prevailing` calendar this is the clock on the wall: the hour
 * spring forward removes is reachable by no instant, and the hour fall
 * back repeats is reached by two — each classified the same, which is
 * TOU-CAL-7's rule rather than an edge case to special-case.
 *
 * On a `standard` calendar the standard offset applies all year, so
 * every day has 1440 minutes and no hour is missing or doubled.
 *
 * Not rounded to the 15-minute grid. An interval whose start is off the
 * grid is a data problem worth seeing, and rounding here would classify
 * it plausibly and hide it.
 */
export function toLocalMoment(instant: Date, timeZone: string, basis: ClockBasis): LocalMoment {
  if (basis === "standard") {
    const offset = standardOffsetMinutes(timeZone, instant.getUTCFullYear());
    const shifted = new Date(instant.getTime() + offset * MINUTE_MS);
    return {
      date: new Date(
        Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()),
      ),
      minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    };
  }

  const p = zonedParts(instant, timeZone);
  return {
    date: new Date(Date.UTC(p.year, p.month - 1, p.day)),
    minuteOfDay: p.hour * 60 + p.minute,
  };
}
