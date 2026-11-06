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

/** The peak codes a component set prices. */
function pricedCodesOf(components: Array<{ quantitySource: unknown }>): string[] {
  return components.flatMap((c) => {
    const qs = c.quantitySource as Record<string, unknown> | null;
    if (!qs || typeof qs !== "object" || qs.base !== "tou_period") return [];
    return typeof qs.peak_code === "string" && qs.peak_code.length > 0 ? [qs.peak_code] : [];
  });
}

/**
 * The TOU problems on many service agreements at once.
 *
 * **Batched because the caller is a billing run's preview**, which runs
 * over every account in a cycle. Called once per agreement this would be
 * six queries times tens of thousands of agreements; here it is five
 * queries in total, and the first one answers "none of these is a TOU
 * service" for the great majority of cycles and returns.
 *
 * Returns a map keyed by agreement id, carrying only the agreements that
 * have a problem — an empty map means nothing to report, not nothing
 * checked.
 */
export async function checkTouReadinessForAgreements(
  utilityId: string,
  saIds: readonly string[],
  period: { startDate: Date; endDate: Date },
): Promise<Map<string, TouReadinessProblem[]>> {
  const out = new Map<string, TouReadinessProblem[]>();
  if (saIds.length === 0) return out;

  /*
   * 1. Which of these are TOU services at all?
   *
   * The in-force window is the one `loadBase` uses — effective on or
   * before the period end, not expired before its start — so this
   * checks the schedules that would actually rate.
   */
  const assignments = await prisma.sAScheduleAssignment.findMany({
    where: {
      serviceAgreementId: { in: [...saIds] },
      utilityId,
      effectiveDate: { lte: period.endDate },
      OR: [{ expirationDate: null }, { expirationDate: { gte: period.startDate } }],
    },
    select: {
      serviceAgreementId: true,
      rateSchedule: {
        select: {
          touCalendarId: true,
          components: { select: { quantitySource: true } },
        },
      },
    },
  });

  interface TouService {
    calendarId: string;
    pricedCodes: Set<string>;
  }
  const touBySa = new Map<string, TouService>();
  for (const a of assignments) {
    const schedule = a.rateSchedule;
    if (!schedule?.touCalendarId) continue;
    const existing = touBySa.get(a.serviceAgreementId);
    const pricedCodes = existing?.pricedCodes ?? new Set<string>();
    for (const code of pricedCodesOf(schedule.components)) pricedCodes.add(code);
    // The first TOU schedule's calendar wins. Two TOU schedules on one
    // agreement would be two tariffs pricing the same hours, which has
    // no coherent meaning and which the publish check cannot see; this
    // does not try to adjudicate it.
    touBySa.set(a.serviceAgreementId, {
      calendarId: existing?.calendarId ?? schedule.touCalendarId,
      pricedCodes,
    });
  }
  if (touBySa.size === 0) return out;

  const touSaIds = [...touBySa.keys()];

  // 2. The meters on those agreements, and 3. the tenant's tolerance.
  const [servicePoints, config] = await Promise.all([
    prisma.servicePoint.findMany({
      where: { serviceAgreementId: { in: touSaIds }, utilityId, endDate: null },
      select: {
        serviceAgreementId: true,
        meters: {
          where: { removedDate: null },
          select: { meter: { select: { id: true, meterNumber: true, touCalendarId: true } } },
        },
      },
    }),
    prisma.utilityConfig.findFirst({ where: { utilityId }, select: { settings: true } }),
  ]);

  const tolerance = toleranceFrom(
    (config?.settings as Record<string, unknown> | null)?.tou as TouSettings | undefined,
  );

  const metersBySa = new Map<string, Array<{ id: string; meterNumber: string; touCalendarId: string | null }>>();
  for (const sp of servicePoints) {
    const list = metersBySa.get(sp.serviceAgreementId) ?? [];
    for (const m of sp.meters) list.push(m.meter);
    metersBySa.set(sp.serviceAgreementId, list);
  }

  /*
   * 4. Every calendar named by either side, in one query.
   *
   * Names, not versions: the comparison is by name (TOU-REG-2) so
   * republishing a calendar does not flag every TOU meter in the
   * territory.
   */
  const calendarIds = new Set<string>();
  for (const svc of touBySa.values()) calendarIds.add(svc.calendarId);
  for (const meters of metersBySa.values()) {
    for (const m of meters) if (m.touCalendarId) calendarIds.add(m.touCalendarId);
  }
  const calendars = await prisma.touCalendar.findMany({
    where: { id: { in: [...calendarIds] }, utilityId },
    select: { id: true, name: true },
  });
  const calendarNameById = new Map(calendars.map((c) => [c.id, c.name]));

  /*
   * 5. The reads, by meter and period.
   *
   * Filtered by meter and not by agreement, deliberately: `MeterLoader`
   * does the same, and this check has to see what rating will see. A
   * meter that moved between agreements mid-period would otherwise be
   * reported as reconciling here and rate differently.
   */
  const allMeterIds = [...new Set([...metersBySa.values()].flat().map((m) => m.id))];
  const reads = allMeterIds.length
    ? await prisma.meterRead.findMany({
        where: {
          meterId: { in: allMeterIds },
          utilityId,
          readDate: { gte: period.startDate, lte: period.endDate },
        },
        select: { meterId: true, peakCode: true, consumption: true },
      })
    : [];

  const readsByMeter = new Map<string, typeof reads>();
  for (const r of reads) {
    const list = readsByMeter.get(r.meterId) ?? [];
    list.push(r);
    readsByMeter.set(r.meterId, list);
  }

  /*
   * Which of these meters report intervals for the period.
   *
   * An interval meter's buckets do not exist until the calendar has
   * classified its intervals, and since 2026-11-05 the billing run
   * derives them itself (`billing-run/interval-reads.ts`). So no reads
   * **and** no intervals is a meter with no data; no reads and a month
   * of intervals is a meter the run will deal with, and reporting it as
   * "reported no TOU usage at all" sent an operator to import readings
   * that were already in the database.
   */
  const intervalGroups = allMeterIds.length
    ? await prisma.meterReadInterval.groupBy({
        by: ["meterId"],
        where: {
          utilityId,
          meterId: { in: allMeterIds },
          intervalStart: { gte: period.startDate, lt: period.endDate },
        },
        _count: { meterId: true },
      })
    : [];
  const meterIdsWithIntervals = new Set(intervalGroups.map((g) => g.meterId));

  for (const [saId, svc] of touBySa) {
    const problems: TouReadinessProblem[] = [];
    const scheduleCalendarName = calendarNameById.get(svc.calendarId) ?? "(missing)";

    for (const meter of metersBySa.get(saId) ?? []) {
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

      const buckets = new Map<string, Decimal>();
      let total: Decimal | null = null;
      for (const r of readsByMeter.get(meter.id) ?? []) {
        const c = toDecimal(r.consumption.toString());
        if (r.peakCode === null) {
          total = (total ?? ZERO).plus(c);
        } else {
          buckets.set(r.peakCode, (buckets.get(r.peakCode) ?? ZERO).plus(c));
        }
      }

      if (buckets.size === 0) {
        // Nothing to reconcile or to miss a period from. Reporting the
        // absent periods on top would read as several faults where there
        // is one cause.
        //
        // Unless the meter reports intervals, in which case it has data
        // and the run derives the buckets from it before rating. Saying
        // it reported nothing would be false, and the thing it told an
        // operator to go and do was already done.
        if (!meterIdsWithIntervals.has(meter.id)) {
          problems.push({ kind: "NO_TOU_READS", ...where });
        }
        continue;
      }

      for (const peakCode of [...svc.pricedCodes].sort()) {
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

    if (problems.length > 0) out.set(saId, problems);
  }

  return out;
}

/**
 * The TOU problems on one service agreement.
 *
 * A thin wrapper, for the single-agreement callers — an agreement's
 * detail page, and a test. The run's preview uses the batched form.
 */
export async function checkTouReadiness(
  utilityId: string,
  saId: string,
  period: { startDate: Date; endDate: Date },
): Promise<TouReadinessProblem[]> {
  const byAgreement = await checkTouReadinessForAgreements(utilityId, [saId], period);
  return byAgreement.get(saId) ?? [];
}
