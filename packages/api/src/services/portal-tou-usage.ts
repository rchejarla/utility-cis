import { prisma } from "../lib/prisma.js";
import { loadTouCalendarById } from "../lib/rate-engine-loaders/load-tou-calendar.js";
import { resolvePeak } from "../lib/rate-engine/tou-calendar.js";
import { toLocalMoment, zoneOffsetMinutes } from "../lib/rate-engine/tou-clock.js";
import type { BillPresentationTouSection } from "./bill-presentation/document.js";
import { loadTouSections } from "./bill-presentation/tou.js";

/**
 * A customer's usage for one **billed** period, by TOU period and by hour
 * (spec 26, the portal half of TOU-BIL-3).
 *
 * **Ownership is in every query**, the portal's rule: the agreement is
 * found through `account.customerId`, and a segment only through that
 * agreement and a **posted** bill — an unposted bill is a calculation the
 * customer does not owe yet. Anything else is not found, never forbidden.
 *
 * **The period table is the bill's own** (`loadTouSections`), so the portal
 * cannot show a split the bill does not.
 *
 * **The hourly view is a 24-hour profile**: usage at each hour of the day,
 * summed across the billed period and stacked by TOU period. A bar per hour
 * of a month is about 744 bars nobody can read; the profile says what a TOU
 * customer wants to know — how much of their use lands in the expensive
 * hours. Each interval is classified exactly as the roll-up that priced the
 * bill classifies it (`toLocalMoment` + `resolvePeak`, against the
 * schedule's calendar version), by its start. Only interval meters have
 * one; a register meter records totals per period, not when they were used.
 */

export interface BilledPeriod {
  segmentId: string;
  periodStart: string;
  periodEnd: string;
  billNumber: string;
  /** Whether the period was rated on a TOU schedule, so the page knows to offer the breakdown. */
  tou: boolean;
}

export interface BilledPeriodUsage {
  period: BilledPeriod;
  /** The bill's usage-by-period table; null when the period was not rated on TOU. */
  byPeriod: BillPresentationTouSection | null;
  /**
   * Usage by hour of day, stacked by TOU period; null for a meter with no
   * interval data (a register meter) or a period not rated on TOU.
   */
  hourly: {
    unit: string | null;
    /** Display order and labels for the stack. */
    periods: Array<{ code: string; label: string }>;
    /** Exactly 24 entries, hour 0–23 local. */
    hours: Array<{ hour: number; byPeriod: Record<string, number> }>;
  } | null;
}

/** The agreement, only if it is this customer's. */
async function ownedAgreement(customerId: string, agreementId: string) {
  return prisma.serviceAgreement.findFirst({
    where: { id: agreementId, account: { customerId } },
    select: { id: true },
  });
}

/** Segments on posted bills, newest first. Null when the agreement is not the customer's. */
export async function listBilledPeriods(
  utilityId: string,
  customerId: string,
  agreementId: string,
): Promise<BilledPeriod[] | null> {
  if (!(await ownedAgreement(customerId, agreementId))) return null;
  const segments = await prisma.billSegment.findMany({
    where: { utilityId, serviceAgreementId: agreementId, bill: { postedAt: { not: null } } },
    orderBy: { periodStart: "desc" },
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      bill: { select: { billNumber: true } },
      lines: { select: { sourceSchedule: { select: { touCalendarId: true } } } },
    },
  });
  return segments.map((s) => ({
    segmentId: s.id,
    periodStart: s.periodStart.toISOString().slice(0, 10),
    periodEnd: s.periodEnd.toISOString().slice(0, 10),
    billNumber: s.bill?.billNumber ?? "",
    tou: s.lines.some((l) => l.sourceSchedule?.touCalendarId != null),
  }));
}

/** One billed period's usage. Null when the agreement or segment is not the customer's, or not posted. */
export async function billedPeriodUsage(
  utilityId: string,
  customerId: string,
  agreementId: string,
  segmentId: string,
): Promise<BilledPeriodUsage | null> {
  if (!(await ownedAgreement(customerId, agreementId))) return null;
  const segment = await prisma.billSegment.findFirst({
    where: {
      id: segmentId,
      utilityId,
      serviceAgreementId: agreementId,
      bill: { postedAt: { not: null } },
    },
    include: {
      bill: { select: { billNumber: true } },
      serviceAgreement: { include: { commodity: true } },
      lines: {
        orderBy: { sortOrder: "asc" },
        include: { sourceSchedule: { select: { touCalendarId: true } } },
      },
    },
  });
  if (!segment) return null;

  const touCalendarId = segment.lines.map((l) => l.sourceSchedule?.touCalendarId).find((id) => id != null) ?? null;
  const period: BilledPeriod = {
    segmentId: segment.id,
    periodStart: segment.periodStart.toISOString().slice(0, 10),
    periodEnd: segment.periodEnd.toISOString().slice(0, 10),
    billNumber: segment.bill?.billNumber ?? "",
    tou: touCalendarId !== null,
  };
  if (!touCalendarId) return { period, byPeriod: null, hourly: null };

  const [byPeriod] = await loadTouSections(utilityId, [segment]);
  return {
    period,
    byPeriod: byPeriod ?? null,
    hourly: await hourlyProfile(utilityId, segment, touCalendarId),
  };
}

async function hourlyProfile(
  utilityId: string,
  segment: { serviceAgreementId: string; periodStart: Date; periodEnd: Date },
  touCalendarId: string,
): Promise<BilledPeriodUsage["hourly"]> {
  const load = await loadTouCalendarById(prisma, {
    utilityId,
    id: touCalendarId,
    period: { startDate: segment.periodStart, endDate: segment.periodEnd },
  });
  if (!load.ok) return null;
  const { calendar } = load;

  const installs = await prisma.servicePointMeter.findMany({
    where: { utilityId, servicePoint: { serviceAgreementId: segment.serviceAgreementId } },
    select: { meterId: true },
  });
  const meterIds = [...new Set(installs.map((i) => i.meterId))];
  if (meterIds.length === 0) return null;

  // The billed days are local calendar days; read the intervals that start
  // inside them, in the calendar's own zone.
  const from = localMidnight(segment.periodStart, calendar.timeZone);
  const to = localMidnight(new Date(segment.periodEnd.getTime() + 86_400_000), calendar.timeZone);
  const intervals = await prisma.meterReadInterval.findMany({
    where: { utilityId, meterId: { in: meterIds }, intervalStart: { gte: from, lt: to } },
    select: { intervalStart: true, quantity: true, quality: true, uom: { select: { code: true } } },
  });
  // A register meter has no intervals: it says how much per period, not when.
  if (intervals.length === 0) return null;

  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, byPeriod: {} as Record<string, number> }));
  for (const row of intervals) {
    if (row.quality === "missing") continue;
    const at = toLocalMoment(row.intervalStart, calendar.timeZone, calendar.clockBasis);
    const peak = resolvePeak({
      date: at.date,
      minuteOfDay: at.minuteOfDay,
      calendar: calendar.definition,
      seasons: calendar.seasons,
      observedHolidays: calendar.observedHolidays,
    });
    if (!peak.ok) continue;
    const slot = hours[Math.floor(at.minuteOfDay / 60)]!.byPeriod;
    slot[peak.peakCode] = round4((slot[peak.peakCode] ?? 0) + Number(row.quantity));
  }

  const codes = [...new Set(calendar.definition.slots.map((s) => s.peakCode))];
  const labels = await prisma.touPeriod.findMany({
    where: { utilityId, peakCode: { in: codes } },
    select: { peakCode: true, label: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { peakCode: "asc" }],
  });
  return {
    unit: intervals[0]?.uom?.code ?? null,
    periods: labels.map((l) => ({ code: l.peakCode, label: l.label })),
    hours,
  };
}

/** The instant of local midnight on a calendar day (a DATE read as UTC midnight). */
function localMidnight(day: Date, timeZone: string): Date {
  const utcMidnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  /*
   * The offset **at local midnight itself**, found in two steps: guess with
   * the offset at UTC midnight, then take the offset at the guess. It took
   * the offset at midday until 2026-11-27, which on a fall-back day is
   * already standard time — Denver's 1 November midnight came out at 07:00Z
   * instead of 06:00Z, and the day's first hour of intervals was dropped.
   * DST changes at 2 am, so midnight is never itself skipped or repeated.
   */
  const guess = utcMidnight - zoneOffsetMinutes(new Date(utcMidnight), timeZone) * 60_000;
  return new Date(utcMidnight - zoneOffsetMinutes(new Date(guess), timeZone) * 60_000);
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
