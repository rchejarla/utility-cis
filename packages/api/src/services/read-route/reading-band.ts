import type { EntryBand } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";

/**
 * The range a meter's next reading is expected to land in, judged from
 * its own recent consumption — so the entry screen can hold a row whose
 * number is wild instead of posting it (design §5.7).
 *
 * **This whole file is provisional and is meant to be deleted.**
 * `ExceptionThreshold` (Req 93) is unbuilt, and `computeConsumption`
 * only reacts to a reading *below* its prior — `ROLLOVER`,
 * `METER_DEFECT`, `REVERSE_FLOW`. Nothing anywhere in `packages/api`
 * detects high usage. So a 3× read posts in silence today, and holding
 * the row at the keyboard is the main thing the screen buys over paper.
 * It is a second opinion about what is wild, which is a real cost: when
 * Req 93 lands, the band comes from there and this file goes, whole.
 * Nothing else imports it, which is why it is a file rather than a
 * function inside the entry service.
 *
 * **It is a hold, never a refusal.** The screen offers "that looks
 * wrong — confirm" and a confirmed number posts, because a reading
 * outside the band is routinely correct: a filled pool, a burst pipe, a
 * tenant who moved in. A rule this provisional must not be able to stop
 * a true number reaching the bill.
 */

/**
 * How many of the meter's own reads the band is judged from. Six is
 * about half a year of monthly reads: long enough that one odd month
 * does not set the bounds by itself, short enough that a house whose
 * occupancy changed last spring is judged on how it is used now.
 */
const TRAILING_READS = 6;

/**
 * Below this many usable reads, there is **no band**. Two consumptions
 * cannot say what is typical, and a band derived from them would hold
 * correct rows and teach the reader to confirm without looking — which
 * is worse than no check at all, because it looks like one.
 */
const MIN_READS_FOR_A_BAND = 3;

/**
 * How far from what the meter typically uses still counts as ordinary.
 * Asymmetric on purpose: a half-month of usage is a plausible meter swap
 * or a vacant month, while a doubling is the leak this exists to catch.
 * These are judgement, not measurement — the honest version of them is
 * Req 93's per-utility thresholds.
 */
const LOW_FACTOR = 0.5;
const HIGH_FACTOR = 2;

/** Which row of which meter — a register's reads are not the meter's. */
const keyOf = (meterId: string, registerId: string | null) => `${meterId}|${registerId ?? ""}`;

export interface MeterHistory {
  /** What it last read before the sheet's date. Null if never read. */
  lastReading: string | null;
  /** YYYY-MM-DD. */
  lastReadDate: string | null;
  band: EntryBand | null;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/**
 * A quantity as the rest of the API sends one: rounded to the column's
 * four decimals, with no trailing zeros.
 *
 * `toFixed(4)` alone would send `1030.0000` where every other endpoint
 * sends `1030` — Prisma's `Decimal` serialises without the padding — and
 * the sheet and the entry screen would then print the same reading two
 * ways. The rounding is still needed: `0.5 * 28.3` is 14.149999999999999
 * in binary floating point, and `String()` of that is not a reading.
 */
const quantity = (n: number) => String(Number(n.toFixed(4)));

/**
 * The middle consumption, which is what the bounds are scaled from.
 *
 * **Not the smallest and largest.** Scaling the bounds from `min` and
 * `max` lets one month set them for the next six reads, and it fails in
 * the direction that matters: a burst-pipe month of 500 against a normal
 * 30 — a number this check is *designed* to let through once somebody
 * confirms it — would put the high bound at twice 500, so a later 10×
 * misread of 300 posts in silence. The escape hatch would disarm the
 * check. The median moves by one position instead, and a meter needs
 * half its recent months to be wild before it stops holding anything.
 *
 * Seasonality is still unhandled: an irrigation meter reading 5 in
 * winter and 60 in summer has no single typical month, and no statistic
 * over six reads invents one. That is Req 93's per-utility thresholds,
 * not this file's.
 */
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * The trailing reads of each `(meter, register)` before `onDate`, and the
 * band they imply.
 *
 * "Before", not "up to": a sheet reopened after some stops posted must
 * still show what the reader was comparing against, not the number they
 * just wrote down.
 *
 * One round trip for the whole route. `DISTINCT ON` is not usable here —
 * this wants several reads per row, not the latest — so the window is
 * cut in SQL and the arithmetic done here, where it is readable and
 * where the deletion above is a deletion of one file.
 */
export async function historyForRows(
  utilityId: string,
  rows: { meterId: string; registerId: string | null }[],
  onDate: Date,
): Promise<Map<string, MeterHistory>> {
  const out = new Map<string, MeterHistory>();
  if (rows.length === 0) return out;
  const meterIds = [...new Set(rows.map((r) => r.meterId))];

  /*
   * **`consumption` is divided back to dial movement here**, because the
   * band is added to a dial reading. `computeConsumption` stores the dial
   * difference *times the meter's multiplier* (meter-read.service.ts), so
   * on a CT meter with multiplier 100 a typical movement of 12 is stored
   * as 1200 — and a band built from that held every ordinary reading on
   * every meter whose multiplier is not 1. The current multiplier is the
   * right divisor: it is the one the reader's number will be compared
   * under. NULLIF keeps a misconfigured zero from dividing; such a row
   * drops out as non-positive below.
   */
  const reads = await prisma.$queryRaw<
    {
      meter_id: string;
      register_id: string | null;
      reading: unknown;
      consumption: unknown;
      read_date: Date;
      measure: string;
    }[]
  >`
    SELECT meter_id, register_id, reading, consumption, read_date, measure
    FROM (
      SELECT mr.meter_id, mr.register_id, mr.reading,
             mr.consumption / NULLIF(m.multiplier, 0) AS consumption,
             mr.read_date,
             mt.code AS measure,
             row_number() OVER (
               PARTITION BY mr.meter_id, mr.register_id
               ORDER BY mr.read_date DESC, mr.read_datetime DESC
             ) AS rn
      FROM meter_read mr
      JOIN meter m ON m.id = mr.meter_id AND m.utility_id = mr.utility_id
      JOIN unit_of_measure u ON u.id = mr.uom_id
      JOIN measure_type_def mt ON mt.id = u.measure_type_id
      WHERE mr.utility_id = ${utilityId}::uuid
        AND mr.meter_id = ANY(${meterIds}::uuid[])
        AND mr.reading IS NOT NULL
        -- As 'YYYY-MM-DD' text. A bound JS Date would give the same day —
        -- the pg adapter sends its UTC wall time as untyped text, which
        -- ::date reads in any session zone (ledger-posting test) — but the
        -- explicit day does not lean on how the adapter serialises.
        AND mr.read_date < ${isoDay(onDate)}::date
    ) ranked
    WHERE rn <= ${TRAILING_READS}
    ORDER BY meter_id, register_id, read_date DESC`;

  const byRow = new Map<string, HistoryRead[]>();
  for (const r of reads) {
    const key = keyOf(r.meter_id, r.register_id);
    const list = byRow.get(key) ?? [];
    list.push({
      reading: Number(r.reading),
      consumption: Number(r.consumption),
      readDate: r.read_date,
      isDemand: r.measure === "DEMAND",
    });
    byRow.set(key, list);
  }

  /*
   * A meter with exactly one register may carry reads that name no
   * register at all (`createMeterRead` permits it), and those reads are
   * that register's history. The sheet already makes this allowance;
   * without it, a utility that reads single-register meters without
   * naming the register sees "never read" against every line.
   */
  const registerCount = new Map<string, number>();
  for (const r of rows) {
    if (r.registerId) registerCount.set(r.meterId, (registerCount.get(r.meterId) ?? 0) + 1);
  }

  for (const row of rows) {
    let history = byRow.get(keyOf(row.meterId, row.registerId)) ?? [];
    if (row.registerId && registerCount.get(row.meterId) === 1) {
      const unnamed = byRow.get(keyOf(row.meterId, null)) ?? [];
      // Merged and re-sorted rather than preferred either way: which is
      // more recent is the only thing that decides.
      history = [...history, ...unnamed].sort((a, b) => b.readDate.getTime() - a.readDate.getTime());
    }
    out.set(keyOf(row.meterId, row.registerId), fromHistory(history.slice(0, TRAILING_READS)));
  }
  return out;
}

interface HistoryRead {
  reading: number;
  consumption: number;
  readDate: Date;
  /** A demand register's read: the dial *is* the quantity (spec 31). */
  isDemand: boolean;
}

function fromHistory(history: HistoryRead[]): MeterHistory {
  const latest = history[0];
  const lastReading = latest ? quantity(latest.reading) : null;
  const lastReadDate = latest ? isoDay(latest.readDate) : null;

  /*
   * Zero and negative consumptions are left out of the bounds, not
   * counted as low ones. A zero is usually a vacant month or an
   * estimate, and including it drags the low bound to zero, which
   * silently turns the band one-sided — the check would then pass
   * anything at all below the last reading.
   */
  const used = history.map((h) => h.consumption).filter((c) => c > 0);
  if (used.length < MIN_READS_FOR_A_BAND || !latest) {
    return { lastReading, lastReadDate, band: null };
  }
  const typical = median(used);
  /*
   * **A demand dial is reset each period** (spec 31, DEM-RD-1), so its
   * next reading lands near its typical peak — not on top of the last
   * reading, which is where an energy dial's does. Measured from the last
   * reading, a demand band would hold every ordinary peak and pass only a
   * figure twice the usual one.
   */
  const base = latest.isDemand ? 0 : latest.reading;
  return {
    lastReading,
    lastReadDate,
    band: {
      low: quantity(base + typical * LOW_FACTOR),
      high: quantity(base + typical * HIGH_FACTOR),
      typical: quantity(typical),
      // The observed range, reported beside the typical rather than used
      // as the bound: it is what the operator recognises their own meter
      // by, and it says how settled the typical is.
      typicalLow: quantity(Math.min(...used)),
      typicalHigh: quantity(Math.max(...used)),
    },
  };
}

/**
 * The key `historyForRows` answers under. Exported because its callers
 * look rows up by it and must not build the string themselves — a
 * second spelling of it reads as "never read" for every register.
 */
export const historyKey = keyOf;
