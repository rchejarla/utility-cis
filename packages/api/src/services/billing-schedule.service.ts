/**
 * Is it going to happen? (SCH-BILL-12)
 *
 * The dispatcher decides due-ness one hourly tick at a time and reports
 * what it did afterwards. Nothing in the product could answer the
 * question in advance, which is the one an operator actually has on the
 * 8th: a cycle that will not fire on the 10th is worth knowing about
 * before the 10th, not on the 11th.
 *
 * **Projected by running `billingDueAt` forward, not by a second date
 * calculation.** Converting "the 10th at 03:00 in Denver" to a UTC
 * instant here would be a second answer to a question the dispatcher
 * already answers, and the two would be free to disagree — a screen
 * that disagrees with the schedule is worse than no screen. Stepping the
 * real UTC hour boundaries the cron fires on also gets DST right for
 * free: the offset used is the one in force on the future bill day, not
 * the one in force today.
 */
import { prisma } from "../lib/prisma.js";
import { formatInTimeZone } from "../lib/iana-tz.js";
import { billDayIn } from "./bill.service.js";
import { billingDueAt } from "../workers/billing-dispatcher.js";
import { previewBillingRun } from "./billing-run.service.js";
import { getAutomationConfig } from "./automation-config.service.js";

/** One hour, the cron's own cadence — the grain of every answer here. */
const HOUR_MS = 3_600_000;

/**
 * How far ahead to look.
 *
 * Thirty-four days covers the longest gap between two monthly bill days
 * (the 31st of one 31-day month to the 31st clamped into the next),
 * with a day's slack. A cap rather than an open loop: a cycle that can
 * never be due must return "never", not spin.
 */
const HORIZON_HOURS = 34 * 24;

export type ScheduleReason =
  /** A future instant, and the ordinary answer. */
  | "scheduled"
  /** Its day has passed with no run; the next tick will take it. */
  | "overdue"
  /** The rate engine cannot bill this cycle at all. */
  | "unsupportedFrequency"
  /** Nothing in the horizon would dispatch it. */
  | "never";

export interface NextDispatch {
  at: Date | null;
  reason: ScheduleReason;
}

interface Tenant {
  timezone: string;
  runHourLocal: number | null;
}

interface Cycle {
  billDayOfMonth: number;
  frequency: string;
}

/**
 * The next whole hour strictly after `from` — where the cron fires next.
 *
 * Strictly after, including when `from` is itself on the boundary: the
 * tick at that instant is the one that just observed the cycle overdue,
 * so naming it would promise a dispatch at a time that has passed.
 */
function nextTick(from: Date): Date {
  return new Date((Math.floor(from.getTime() / HOUR_MS) + 1) * HOUR_MS);
}

/**
 * When this cycle will next be dispatched.
 *
 * `currentWindowRun` is the one fact `billingDueAt` cannot know: it
 * reports a passed bill day as due forever (SCH-BILL-7's catch-up), so
 * without it a cycle billed on the 10th would read as "overdue" for the
 * rest of the month. With a run in hand the question becomes about the
 * next window, which is what the caller is asking after a successful
 * run.
 */
export function nextBillingDispatchAt(
  now: Date,
  tenant: Tenant,
  cycle: Cycle,
  opts: { currentWindowRun: boolean },
): NextDispatch {
  const verdict = billingDueAt(now, tenant, cycle);
  if (verdict.reason === "unsupportedFrequency") {
    return { at: null, reason: "unsupportedFrequency" };
  }

  /*
   * Due now and nothing has run it: the dispatcher takes it on the next
   * tick. Reported as overdue rather than scheduled because on the 12th
   * "scheduled for the 10th" is not true, and the distinction is the
   * whole point of showing this before the day.
   */
  if (verdict.due && !opts.currentWindowRun) {
    return { at: nextTick(now), reason: verdict.reason === "catchingUp" ? "overdue" : "scheduled" };
  }

  /*
   * Otherwise: step hour boundaries to the first due one, skipping the
   * bill day already run.
   *
   * `after` is set only when the verdict is due — meaning the bill day
   * has arrived — because that is the only case where a run in hand
   * covers the day the scan is about to find. Before the bill day,
   * `currentWindowRun` refers to *last* month's window, and skipping
   * this month's day on the strength of it would look past a dispatch
   * that is still coming. A cycle billing on the 31st asked on the 20th
   * reported "never" until this distinction was drawn: the scan skipped
   * November's clamped 30th as already run and then ran out of horizon
   * before December's.
   */
  const after = verdict.due && opts.currentWindowRun ? billDayKeyOf(now, tenant, cycle) : null;

  let t = nextTick(now);
  for (let i = 0; i < HORIZON_HOURS; i += 1, t = new Date(t.getTime() + HOUR_MS)) {
    const due = billingDueAt(t, tenant, cycle);
    if (!due.due) continue;
    if (after !== null && billDayKeyOf(t, tenant, cycle) === after) continue;
    return { at: t, reason: "scheduled" };
  }

  return { at: null, reason: "never" };
}

/**
 * Which bill day this instant belongs to, as `yyyy-MM` plus the clamped
 * day — the identity of the window, used only to tell "the one already
 * run" from "the next one".
 *
 * Clamped with `billDayIn`, the same call the window calculation and the
 * dispatcher use: a cycle billing on the 31st bills on the 30th in
 * November, and a key built on the raw 31 would never match.
 */
function billDayKeyOf(at: Date, tenant: Tenant, cycle: Cycle): string {
  const [year, month] = formatInTimeZone(at, tenant.timezone, "yyyy-MM").split("-").map(Number);
  return `${year}-${month}-${billDayIn(year, month - 1, cycle.billDayOfMonth)}`;
}

export interface CycleSchedule {
  billingCycleId: string;
  cycleCode: string;
  cycleName: string;
  nextRunAt: string | null;
  reason: ScheduleReason;
  /** The window a run would cover, so the date on the bill is visible too. */
  windowEnd: string | null;
  /** A run already covers that window — then `nextRunAt` is the one after. */
  alreadyRun: boolean;
}

export interface BillingScheduleReport {
  /** False when the tenant has not switched billing automation on. */
  enabled: boolean;
  timezone: string;
  runHourLocal: number | null;
  cycles: CycleSchedule[];
}

/**
 * Every active cycle's next dispatch, for `/billing-runs`.
 *
 * Reported even when automation is off, with `enabled: false`: "nothing
 * is scheduled because nobody turned it on" is the most useful answer
 * this screen can give, and suppressing the list would make it
 * indistinguishable from a tenant with no cycles.
 */
export async function getBillingSchedule(
  utilityId: string,
  now: Date = new Date(),
): Promise<BillingScheduleReport> {
  const config = await getAutomationConfig(utilityId);
  const billing = config.schedulers.find((s) => s.key === "billing");

  const cycles = await prisma.billingCycle.findMany({
    where: { utilityId, active: true },
    select: { id: true, cycleCode: true, name: true, billDayOfMonth: true, frequency: true },
    orderBy: { cycleCode: "asc" },
  });

  const tenant = { timezone: config.timezone, runHourLocal: billing?.runHourLocal ?? null };

  const rows: CycleSchedule[] = [];
  for (const cycle of cycles) {
    /*
     * The plan, for the window and for whether a run already covers it.
     * `previewBillingRun` is the one place the window is decided, so
     * asking it is what keeps this screen's dates equal to the dates a
     * run would actually carry.
     */
    let windowEnd: string | null = null;
    let alreadyRun = false;
    try {
      const plan = await previewBillingRun(utilityId, {
        billingCycleId: cycle.id,
        windowEnd: now,
      });
      windowEnd = plan.windowEnd.toISOString().slice(0, 10);
      alreadyRun = plan.existingRun !== null;
    } catch {
      // A cycle the planner refuses (an unsupported frequency reaches
      // `computeBillPeriod` as a 501) still gets a row: the reason
      // below is the useful half, and dropping the cycle would make an
      // unbillable one invisible.
    }

    const next = nextBillingDispatchAt(now, tenant, cycle, { currentWindowRun: alreadyRun });
    rows.push({
      billingCycleId: cycle.id,
      cycleCode: cycle.cycleCode,
      cycleName: cycle.name,
      nextRunAt: next.at?.toISOString() ?? null,
      reason: next.reason,
      windowEnd,
      alreadyRun,
    });
  }

  return {
    enabled: billing?.enabled ?? false,
    timezone: config.timezone,
    runHourLocal: tenant.runHourLocal,
    cycles: rows,
  };
}
