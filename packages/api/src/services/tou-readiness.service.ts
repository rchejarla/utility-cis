/**
 * What is wrong with a TOU service before it is billed (spec 26,
 * TOU-BIL-1, and the checks TOU-REG-1 and TOU-REG-2 ask for).
 *
 * All four problems here share one property: **none of them is visible
 * on the resulting bill.** That is the whole reason this exists as a
 * pre-run check rather than being left to rating.
 *
 * - A **calendar mismatch** bills correctly against hours the meter was
 *   not counting by. Every figure reconciles; the split is simply wrong.
 * - An **unrecorded meter calendar** means nobody can tell whether there
 *   is a mismatch at all.
 * - **Unreconciled registers** mean the TOU dials and the total dial
 *   disagree, so some usage is either billed twice or not at all.
 * - A **period the meter never reported** is the one that *does* stop
 *   rating — `tou_period` raises on the absent bucket — which is better
 *   found here, before a run of thousands, than halfway through one.
 *
 * Reported rather than enforced. The operator approves the preview, and
 * a tenant mid-migration may knowingly bill a service whose meter
 * programming is not yet recorded.
 */

import { prisma } from "../lib/prisma.js";
import { TOU_DEFAULTS, type TouSettings } from "@utility-cis/shared";
import { Decimal, ZERO, toDecimal } from "../lib/rate-engine/decimal.js";

export interface RegisterTolerance {
  /** Absolute slack, in the meter's own unit. */
  absolute: Decimal;
  /** Relative slack, as a percentage of the total. */
  percent: Decimal;
}

export type TouReadinessProblem =
  | {
      kind: "CALENDAR_MISMATCH";
      meterId: string;
      meterNumber: string;
      meterCalendar: string;
      scheduleCalendar: string;
    }
  | { kind: "CALENDAR_UNKNOWN"; meterId: string; meterNumber: string }
  | {
      kind: "REGISTERS_UNRECONCILED";
      meterId: string;
      meterNumber: string;
      total: string;
      bucketSum: string;
      difference: string;
      allowed: string;
    }
  | { kind: "PERIOD_NOT_REPORTED"; meterId: string; meterNumber: string; peakCode: string }
  | { kind: "NO_TOU_READS"; meterId: string; meterNumber: string };

/**
 * Do a meter's TOU registers sum to its total register?
 *
 * Within **either** tolerance, not both: a relative tolerance alone
 * fails absurdly at low usage, and an absolute one alone fails at high
 * usage where real slack hides a fault.
 *
 * Returns null when there is nothing to check — no total read means
 * there is no second opinion to compare against, which is not a fault.
 */
export function reconcileRegisters(
  total: Decimal | null,
  bucketSum: Decimal,
  tolerance: RegisterTolerance,
): { difference: Decimal; allowed: Decimal } | null {
  if (total === null) return null;

  const difference = total.minus(bucketSum).abs();
  const relative = total.abs().mul(tolerance.percent).div(100);
  const allowed = Decimal.max(tolerance.absolute, relative);
  return difference.gt(allowed) ? { difference, allowed } : null;
}

/** A tenant's tolerance, or the declared defaults. */
export function toleranceFrom(settings: TouSettings | undefined): RegisterTolerance {
  return {
    absolute: toDecimal(settings?.registerToleranceAbsolute ?? TOU_DEFAULTS.registerToleranceAbsolute),
    percent: toDecimal(settings?.registerTolerancePercent ?? TOU_DEFAULTS.registerTolerancePercent),
  };
}

/** One readable sentence per problem, so the API and the UI agree. */
export function describeTouProblem(p: TouReadinessProblem): string {
  switch (p.kind) {
    case "CALENDAR_MISMATCH":
      return `Meter ${p.meterNumber} is programmed with TOU calendar "${p.meterCalendar}", but the rate schedule prices against "${p.scheduleCalendar}". The bill would reconcile and still split the usage by the wrong hours.`;
    case "CALENDAR_UNKNOWN":
      return `Meter ${p.meterNumber} has no recorded TOU calendar, so whether its peak hours match the rate schedule's cannot be checked.`;
    case "REGISTERS_UNRECONCILED":
      return `Meter ${p.meterNumber}: the TOU registers total ${p.bucketSum} against a total register of ${p.total}, a difference of ${p.difference} where ${p.allowed} is allowed. Some usage is billed twice or not at all.`;
    case "PERIOD_NOT_REPORTED":
      return `Meter ${p.meterNumber} reported no "${p.peakCode}" usage for this period, and the rate schedule prices it. Rating will stop rather than bill zero.`;
    case "NO_TOU_READS":
      return `Meter ${p.meterNumber} reported no TOU usage at all for this period, and the rate schedule is a TOU tariff.`;
  }
}

/**
 * The TOU problems on one service agreement for one period.
 *
 * Empty for a non-TOU service, and it costs two indexed reads to find
 * that out — the pre-run check runs over every account in a cycle, so
 * the non-TOU path has to be cheap.
 */
export async function checkTouReadiness(
  utilityId: string,
  saId: string,
  period: { startDate: Date; endDate: Date },
): Promise<TouReadinessProblem[]> {
  /*
   * The schedules in force for the period, the same window
   * `loadBase` uses: effective on or before the period end, and not
   * expired before the period start.
   */
  const assignments = await prisma.sAScheduleAssignment.findMany({
    where: {
      serviceAgreementId: saId,
      utilityId,
      effectiveDate: { lte: period.endDate },
      OR: [{ expirationDate: null }, { expirationDate: { gte: period.startDate } }],
    },
    select: {
      rateSchedule: {
        select: {
          touCalendarId: true,
          components: { select: { quantitySource: true } },
        },
      },
    },
  });

  const touSchedules = assignments
    .map((a) => a.rateSchedule)
    .filter((s): s is NonNullable<typeof s> => Boolean(s?.touCalendarId));
  if (touSchedules.length === 0) return [];

  // One calendar per schedule, and in practice one TOU schedule per
  // agreement; a second would be two tariffs pricing the same hours,
  // which the publish check cannot see and this does not try to.
  const calendarId = touSchedules[0]!.touCalendarId!;
  const pricedCodes = new Set(
    touSchedules.flatMap((s) =>
      s.components.flatMap((c) => {
        const qs = c.quantitySource as Record<string, unknown> | null;
        if (!qs || typeof qs !== "object" || qs.base !== "tou_period") return [];
        return typeof qs.peak_code === "string" && qs.peak_code.length > 0 ? [qs.peak_code] : [];
      }),
    ),
  );

  const [calendar, config, meters] = await Promise.all([
    prisma.touCalendar.findFirst({
      where: { id: calendarId, utilityId },
      select: { name: true },
    }),
    prisma.utilityConfig.findFirst({ where: { utilityId }, select: { settings: true } }),
    prisma.servicePoint.findMany({
      where: { serviceAgreementId: saId, utilityId, endDate: null },
      select: {
        meters: {
          where: { removedDate: null },
          select: {
            meter: {
              select: { id: true, meterNumber: true, touCalendarId: true },
            },
          },
        },
      },
    }),
  ]);

  const scheduleCalendarName = calendar?.name ?? "(missing)";
  const tolerance = toleranceFrom(
    ((config?.settings as Record<string, unknown> | null)?.tou as TouSettings | undefined),
  );

  const meterRows = meters.flatMap((sp) => sp.meters.map((m) => m.meter));
  if (meterRows.length === 0) return [];

  // The meters' own calendars, for the name comparison. Names, not
  // versions: republishing a calendar must not flag every TOU meter in
  // the territory (TOU-REG-2).
  const meterCalendarIds = [
    ...new Set(meterRows.map((m) => m.touCalendarId).filter((id): id is string => id !== null)),
  ];
  const meterCalendars = meterCalendarIds.length
    ? await prisma.touCalendar.findMany({
        where: { id: { in: meterCalendarIds }, utilityId },
        select: { id: true, name: true },
      })
    : [];
  const calendarNameById = new Map(meterCalendars.map((c) => [c.id, c.name]));

  const reads = await prisma.meterRead.findMany({
    where: {
      meterId: { in: meterRows.map((m) => m.id) },
      utilityId,
      readDate: { gte: period.startDate, lte: period.endDate },
    },
    select: { meterId: true, peakCode: true, consumption: true },
  });

  const problems: TouReadinessProblem[] = [];

  for (const meter of meterRows) {
    const where = { meterId: meter.id, meterNumber: meter.meterNumber };

    if (meter.touCalendarId === null) {
      problems.push({ kind: "CALENDAR_UNKNOWN", ...where });
    } else {
      const meterCalendar = calendarNameById.get(meter.touCalendarId) ?? "(missing)";
      if (meterCalendar !== scheduleCalendarName) {
        problems.push({
          kind: "CALENDAR_MISMATCH",
          ...where,
          meterCalendar,
          scheduleCalendar: scheduleCalendarName,
        });
      }
    }

    const mine = reads.filter((r) => r.meterId === meter.id);
    const buckets = new Map<string, Decimal>();
    let total: Decimal | null = null;
    for (const r of mine) {
      const c = toDecimal(r.consumption.toString());
      if (r.peakCode === null) {
        total = (total ?? ZERO).plus(c);
      } else {
        buckets.set(r.peakCode, (buckets.get(r.peakCode) ?? ZERO).plus(c));
      }
    }

    if (buckets.size === 0) {
      problems.push({ kind: "NO_TOU_READS", ...where });
      continue; // Nothing to reconcile or compare against.
    }

    for (const peakCode of [...pricedCodes].sort()) {
      if (!buckets.has(peakCode)) {
        problems.push({ kind: "PERIOD_NOT_REPORTED", ...where, peakCode });
      }
    }

    const bucketSum = [...buckets.values()].reduce((a, b) => a.plus(b), ZERO);
    const off = reconcileRegisters(total, bucketSum, tolerance);
    if (off) {
      problems.push({
        kind: "REGISTERS_UNRECONCILED",
        ...where,
        total: (total ?? ZERO).toString(),
        bucketSum: bucketSum.toString(),
        difference: off.difference.toString(),
        allowed: off.allowed.toString(),
      });
    }
  }

  return problems;
}
