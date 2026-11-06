/**
 * The daily interval-coverage sweep (spec 26, TOU-INT-4c).
 *
 * Coverage was checked in exactly one place — inside `rollUpIntervals`,
 * reached only from a billing run or an operator's script. That is the
 * one moment a gap is useless to know about: by bill day the only
 * options are to hold the account or estimate it. Found the day after
 * it happened, the meter can be re-polled, the comms path chased, a
 * technician sent — the gap can stop being one, which is always the
 * best outcome.
 *
 * So this detects; it does not act. `report` is the only action in
 * this step, and it means a log line and a count. Opening an exception
 * for somebody to work needs somewhere to put it, and that table is
 * the next step rather than a side effect of this one.
 *
 * Read-only by design. Nothing here writes a `meter_read`, derives a
 * bucket or touches an interval: a sweep that repaired data would be
 * doing estimation on a schedule, which is a judgement nobody has
 * reviewed.
 */
import { intervalCoverageSettings, DEFAULT_RUN_HOUR_LOCAL } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { localHour } from "../lib/iana-tz.js";
import { findCoverageProblems } from "../lib/interval-coverage.js";
import { windowsToCheck, type CoverageWindow } from "../lib/coverage-windows.js";
import { markSchedulerRun, tenantsForScheduler } from "./automation-config.service.js";
import { runAsTenant } from "../lib/tenant-context.js";

/**
 * How many meters' intervals to pull at once.
 *
 * The gap test is the same pure function the roll-up uses, over real
 * rows, rather than a second implementation in SQL — one definition of
 * "covered", in one place. That means reading the rows, so they are
 * read in chunks: at 15-minute data a meter is ~96 rows a day, so a
 * chunk of 200 meters over a week is ~134k narrow rows, and a utility
 * with 12,000 interval meters is ~60 queries a night.
 *
 * Unmeasured at that size. TOU-INT-8 says to measure the interval
 * store's volume rather than assume it, and this is one of the things
 * it should measure.
 */
const METER_CHUNK = 200;

export interface MeterCoverageFinding {
  meterId: string;
  meterNumber: string;
  /** The local day, as the tenant would name it. */
  day: string;
  minutesAffected: number;
  problems: string[];
}

export interface SweepResult {
  tenantsConsidered: number;
  tenantsSwept: number;
  metersChecked: number;
  findings: MeterCoverageFinding[];
}

/** The total minutes a window's problems account for, for a headline. */
function minutesIn(problems: string[]): number {
  let total = 0;
  for (const p of problems) {
    const m = /(\d+) minutes/.exec(p);
    if (m) total += Number(m[1]);
  }
  return total;
}

/**
 * One tenant's interval meters, checked day by day over the window.
 *
 * Only meters that reported *something* in the range are checked. A
 * meter with no intervals at all is not a coverage problem: it is
 * either not an interval meter or not reporting, and calling every
 * register meter in the utility a gap would bury the real findings.
 */
async function sweepTenant(
  utilityId: string,
  windows: CoverageWindow[],
): Promise<{ metersChecked: number; findings: MeterCoverageFinding[] }> {
  if (windows.length === 0) return { metersChecked: 0, findings: [] };
  const rangeStart = windows[0]!.startDate;
  const rangeEnd = windows[windows.length - 1]!.endDate;

  const reporting = await prisma.meterReadInterval.groupBy({
    by: ["meterId"],
    where: { utilityId, intervalStart: { gte: rangeStart, lt: rangeEnd } },
    _count: { meterId: true },
  });
  if (reporting.length === 0) return { metersChecked: 0, findings: [] };

  const meterIds = reporting.map((r) => r.meterId);
  const meters = await prisma.meter.findMany({
    where: { utilityId, id: { in: meterIds } },
    select: { id: true, meterNumber: true },
  });
  const numberById = new Map(meters.map((m) => [m.id, m.meterNumber]));

  const findings: MeterCoverageFinding[] = [];

  for (let i = 0; i < meterIds.length; i += METER_CHUNK) {
    const chunk = meterIds.slice(i, i + METER_CHUNK);
    const rows = await prisma.meterReadInterval.findMany({
      where: { utilityId, meterId: { in: chunk }, intervalStart: { gte: rangeStart, lt: rangeEnd } },
      orderBy: [{ meterId: "asc" }, { intervalStart: "asc" }],
      select: { meterId: true, intervalStart: true, lengthMinutes: true },
    });

    const byMeter = new Map<string, Array<{ intervalStart: Date; lengthMinutes: number }>>();
    for (const r of rows) {
      const list = byMeter.get(r.meterId) ?? [];
      list.push({ intervalStart: r.intervalStart, lengthMinutes: r.lengthMinutes });
      byMeter.set(r.meterId, list);
    }

    for (const meterId of chunk) {
      const all = byMeter.get(meterId) ?? [];
      for (const window of windows) {
        /*
         * Only this day's intervals, and only if the meter reported
         * any. A meter installed on the 3rd has no data on the 2nd,
         * which is not a hole in its data — the already-sorted list is
         * filtered rather than re-queried per day.
         */
        const inWindow = all.filter(
          (r) =>
            r.intervalStart.getTime() >= window.startDate.getTime() &&
            r.intervalStart.getTime() < window.endDate.getTime(),
        );
        if (inWindow.length === 0) continue;

        const problems = findCoverageProblems(inWindow, window);
        if (problems.length === 0) continue;

        findings.push({
          meterId,
          meterNumber: numberById.get(meterId) ?? meterId,
          day: window.startDate.toISOString().slice(0, 10),
          minutesAffected: minutesIn(problems),
          problems,
        });
      }
    }
  }

  return { metersChecked: meterIds.length, findings };
}

/**
 * Sweep every tenant whose local hour has come round.
 *
 * Fires on the hour that matches each tenant's configured run hour, the
 * same gate the delinquency dispatcher uses. No missed-tick recovery:
 * a skipped hour costs one day's detection on a check that runs again
 * tomorrow and re-examines the same window, which is a different
 * proposition from a delinquency pass that would otherwise never send
 * a notice.
 */
export async function sweepIntervalCoverage(now: Date = new Date()): Promise<SweepResult> {
  const candidates = await tenantsForScheduler("intervalCoverage");

  let tenantsSwept = 0;
  let metersChecked = 0;
  const findings: MeterCoverageFinding[] = [];

  for (const tenant of candidates) {
    if (localHour(now, tenant.timezone) !== (tenant.runHourLocal ?? DEFAULT_RUN_HOUR_LOCAL)) {
      continue;
    }

    const { graceHours, lookbackDays } = intervalCoverageSettings(tenant.settings);
    const windows = windowsToCheck({
      now,
      timeZone: tenant.timezone,
      lookbackDays,
      graceHours,
    });

    const result = await runAsTenant(tenant.utilityId, () =>
      sweepTenant(tenant.utilityId, windows),
    );
    tenantsSwept += 1;
    metersChecked += result.metersChecked;
    findings.push(...result.findings);

    for (const f of result.findings) {
      logger.warn(
        {
          component: "interval-coverage-sweep",
          utilityId: tenant.utilityId,
          meterNumber: f.meterNumber,
          day: f.day,
          minutesAffected: f.minutesAffected,
          problems: f.problems,
        },
        "Interval data does not cover the day",
      );
    }

    await markSchedulerRun(tenant.utilityId, "intervalCoverage", now);
  }

  return {
    tenantsConsidered: candidates.length,
    tenantsSwept,
    metersChecked,
    findings,
  };
}
