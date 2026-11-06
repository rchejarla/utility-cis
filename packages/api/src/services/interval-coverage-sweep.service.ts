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
 * What it does with what it finds is **flag it**: a
 * `meter_data_exception` row per (meter, day, kind), opened when the
 * problem appears and resolved by a later sweep that finds the data
 * arrived. A log line was the first step and a poor last one — a
 * warning in a worker's output is not work anybody is assigned.
 *
 * **It writes exceptions; it does not repair data.** Nothing here
 * writes a `meter_read`, derives a bucket or touches an interval, and
 * the only statuses it sets are `open` and `resolved` — both facts
 * about whether the intervals are there. A sweep that filled a gap in
 * would be estimating on a schedule, and a sweep that marked one
 * `accepted` would be deciding to bill a short month, which are
 * judgements nobody has reviewed. The same line `suppressAutoPost`
 * draws elsewhere.
 */
import { intervalCoverageSettings, DEFAULT_RUN_HOUR_LOCAL } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { localHour } from "../lib/iana-tz.js";
import { findCoverageProblems, type CoverageProblem } from "../lib/interval-coverage.js";
import { groupCoverageFindings } from "../lib/meter-data-exception.js";
import { flagDataExceptions } from "./meter-data-exception.service.js";
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
  /**
   * The window swept, which is what an exception is keyed on — one row
   * per (meter, window, kind), so a second sweep of the same day finds
   * its own row rather than opening another.
   */
  window: { startDate: Date; endDate: Date };
  minutesAffected: number;
  problems: CoverageProblem[];
}

export interface SweepResult {
  tenantsConsidered: number;
  tenantsSwept: number;
  metersChecked: number;
  findings: MeterCoverageFinding[];
  /** What the findings did to the exception queue, across all tenants. */
  exceptionsOpened: number;
  exceptionsUpdated: number;
  exceptionsResolved: number;
}

/** The total minutes a window's problems account for, for a headline. */
function minutesIn(problems: CoverageProblem[]): number {
  return problems.reduce((total, p) => total + p.minutes, 0);
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
          window: { startDate: window.startDate, endDate: window.endDate },
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
  let exceptionsOpened = 0;
  let exceptionsUpdated = 0;
  let exceptionsResolved = 0;
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

    /*
     * Both inside one tenant scope, and awaited inside it: the flag
     * action writes tenant-scoped rows, and a `PrismaPromise` returned
     * out of the scope would execute after it had exited.
     *
     * The windows are passed to the flag action as well as to the
     * sweep, because resolving is only honest for days that were
     * actually examined — a narrowed lookback must not close the
     * exceptions it stopped looking at.
     */
    const result = await runAsTenant(tenant.utilityId, async () => {
      const swept = await sweepTenant(tenant.utilityId, windows);
      const flagged = await flagDataExceptions({
        utilityId: tenant.utilityId,
        sweptWindowStarts: windows.map((w) => w.startDate),
        found: groupCoverageFindings(swept.findings),
        now,
      });
      return { ...swept, flagged };
    });
    tenantsSwept += 1;
    metersChecked += result.metersChecked;
    exceptionsOpened += result.flagged.opened;
    exceptionsUpdated += result.flagged.updated;
    exceptionsResolved += result.flagged.resolved;
    findings.push(...result.findings);

    for (const f of result.findings) {
      logger.warn(
        {
          component: "interval-coverage-sweep",
          utilityId: tenant.utilityId,
          meterNumber: f.meterNumber,
          day: f.day,
          minutesAffected: f.minutesAffected,
          problems: f.problems.map((p) => p.message),
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
    exceptionsOpened,
    exceptionsUpdated,
    exceptionsResolved,
  };
}
