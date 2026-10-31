import { Worker } from "bullmq";
import { logger } from "../lib/logger.js";
import { withTelemetry } from "../lib/telemetry.js";
import { QUEUE_NAMES, getQueue, enqueueSafely, workerOptions } from "../lib/queues.js";
import { scopedJob } from "../lib/queue-scope.js";
import { localHour, formatInTimeZone } from "../lib/iana-tz.js";
import { prisma } from "../lib/prisma.js";
import { runAsTenant } from "../lib/tenant-context.js";
import { billDayIn } from "../services/bill.service.js";
import { previewBillingRun, createBillingRun } from "../services/billing-run.service.js";
import { BILLING_RUN_JOB_NAME } from "./billing-run-worker.js";

/**
 * Hourly dispatcher for billing runs — the one job in this system that
 * had no clock behind it.
 *
 * A `BillingCycle` declares `bill_day_of_month` and nothing acted on it:
 * somebody opened a screen on the bill day and pressed Start, per cycle,
 * every month, for every tenant. It is also the most consequential job
 * here, which is why every refusal below is named rather than silent.
 *
 * The shape is `delinquency-dispatch`, which is what this codebase
 * already uses for "fire often, decide per tenant": one hourly cron, one
 * cross-tenant read, one deterministic job per unit of work.
 *
 * **It generates; it does not post.** Posting is governed by
 * `autoPostBills` and 09-billing has already decided what automatic
 * posting needs — rules and a circuit-breaker. A dispatcher that posted
 * would silently become that feature without any of its brakes.
 *
 * `docs/specs/27-job-scheduling.md` §3.
 */

export const BILLING_DISPATCH_SCHEDULER_ID = "billing-dispatch-cron";
export const BILLING_DISPATCH_JOB_NAME = "dispatch-billing";

/** What the audit trail says started a scheduled run. */
export const DISPATCHER_ACTOR_NAME = "Billing dispatcher";

export type DueReason =
  /** Its bill day, and the tenant's hour has come. */
  | "onSchedule"
  /** Past its bill day with no run yet — late, not skipped. */
  | "catchingUp"
  /** Its bill day, before the tenant's hour. */
  | "waitingForHour"
  /** Its bill day has not arrived; the window is still open. */
  | "windowOpen"
  /** The rate engine cannot bill this cycle at all. */
  | "unsupportedFrequency";

export interface DueVerdict {
  due: boolean;
  reason: DueReason;
}

/**
 * Whether this cycle is due, given the clock.
 *
 * Pure, and takes the clock as an argument, so month-end, timezone and
 * missed-tick cases are testable without a container (SCH-X-5).
 *
 * **Tenant-local, not UTC.** A bill dated a day early because the server
 * is in UTC is a bill with the wrong period on it, and 2026-10-10T04:00Z
 * is still the 9th in Denver.
 *
 * **At or after the hour, not equal to it.** An equality match would
 * strand a cycle on the day the clocks spring forward, when the
 * configured local hour does not occur at all — it would bill a day
 * late, every spring, for whichever tenants chose the skipped hour. The
 * cost of `>=` is that the verdict stays true for the rest of the day,
 * which costs nothing: the database's
 * `@@unique([utilityId, billingCycleId, windowEnd])` is what stops a
 * second run, and it is the only thing that needs to.
 */
export function billingDueAt(
  now: Date,
  tenant: { timezone: string; billingRunHourLocal: number },
  cycle: { billDayOfMonth: number; frequency: string },
): DueVerdict {
  /*
   * MONTHLY only, because that is all `computeBillPeriod` supports — it
   * throws 501 for anything else. Creating the run anyway would produce
   * one whose every account fails, which is worse than not creating it:
   * an active cycle that can never bill is worth an operator's
   * attention, and this reports it by name.
   */
  if (cycle.frequency !== "MONTHLY") return { due: false, reason: "unsupportedFrequency" };

  const localDate = formatInTimeZone(now, tenant.timezone, "yyyy-MM-dd");
  const [year, month, day] = localDate.split("-").map(Number);
  const hour = localHour(now, tenant.timezone);

  // The same clamp the window calculation uses, imported rather than
  // repeated: a dispatcher firing on a day the window disagrees about
  // would bill the wrong period or nothing at all.
  const billDay = billDayIn(year, month - 1, cycle.billDayOfMonth);

  if (day < billDay) return { due: false, reason: "windowOpen" };
  if (day === billDay) {
    return hour >= tenant.billingRunHourLocal
      ? { due: true, reason: "onSchedule" }
      : { due: false, reason: "waitingForHour" };
  }
  /*
   * Past the bill day. BullMQ repeatables do not backfill — one overdue
   * occurrence fires on recovery, not one per interval missed — so a
   * worker that was down at the configured hour would otherwise skip
   * the month entirely. The window stays dispatchable until the next
   * bill day closes it (SCH-BILL-7).
   */
  return { due: true, reason: "catchingUp" };
}

/** Why one cycle was not dispatched, for the operator rather than the log. */
export interface SkippedCycle {
  utilityId: string;
  billingCycleId: string;
  cycleCode: string;
  reason: DueReason | "readsIncomplete" | "alreadyRun" | "failed";
  detail?: string;
}

export interface BillingDispatchResult {
  cyclesConsidered: number;
  started: number;
  reasons: { onSchedule: number; catchingUp: number };
  /** Only the ones worth an operator's attention; not every "not yet". */
  skipped: SkippedCycle[];
}

/**
 * Whether this cycle's reads have landed at all.
 *
 * **A narrowing of SCH-BILL-5, deliberately.** The requirement says a
 * cycle whose read day has passed with reads still missing must not be
 * dispatched, because billing before the reads land produces a bill for
 * zero usage and then a double one next period. Read strictly — refuse
 * if *any* account lacks a read — one unread meter would block a
 * twelve-thousand-account cycle, and a dispatcher that almost never
 * fires is the failure this spec exists to remove.
 *
 * So the line is drawn where the two facts differ in kind: **no reads at
 * all** is a fact about the cycle (the import did not happen), and
 * *some* missing reads are facts about meters — which the run already
 * reports per account as `NO_READ_IN_WINDOW` skips, with the exception
 * list that is the whole value of a run.
 */
async function readsLanded(
  utilityId: string,
  billingCycleId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const read = await prisma.meterRead.findFirst({
    where: {
      utilityId,
      readDate: { gte: windowStart, lte: windowEnd },
      // A read names its agreement directly, and an agreement names its
      // account — so this is two joins, not a walk through assignments.
      serviceAgreement: { account: { billingCycleId } },
    },
    select: { id: true },
  });
  return read !== null;
}

export async function dispatchBilling(now: Date = new Date()): Promise<BillingDispatchResult> {
  /*
   * Cross-tenant, so platform authority — the caller's `scopedJob`
   * provides it (QUEUE_TENANCY marks this queue `all-tenants`). A sweep
   * on a confined connection finds nothing and reports success, which
   * is the one failure mode worse than an error.
   */
  const tenants = await prisma.utilityConfig.findMany({
    where: { billingEnabled: true },
    select: { utilityId: true, timezone: true, billingRunHourLocal: true },
  });

  const result: BillingDispatchResult = {
    cyclesConsidered: 0,
    started: 0,
    reasons: { onSchedule: 0, catchingUp: 0 },
    skipped: [],
  };
  if (tenants.length === 0) return result;

  const cycles = await prisma.billingCycle.findMany({
    where: { active: true, utilityId: { in: tenants.map((t) => t.utilityId) } },
    select: {
      id: true,
      utilityId: true,
      cycleCode: true,
      billDayOfMonth: true,
      frequency: true,
    },
  });
  result.cyclesConsidered = cycles.length;

  for (const cycle of cycles) {
    const tenant = tenants.find((t) => t.utilityId === cycle.utilityId);
    if (!tenant) continue;

    const verdict = billingDueAt(now, tenant, cycle);
    if (!verdict.due) {
      // Only the ones an operator should see. "Not its day yet" is the
      // answer 29 days in 30 and reporting it would bury the rest.
      if (verdict.reason === "unsupportedFrequency") {
        result.skipped.push({
          utilityId: cycle.utilityId,
          billingCycleId: cycle.id,
          cycleCode: cycle.cycleCode,
          reason: verdict.reason,
          detail: `${cycle.frequency} billing is not supported; this cycle cannot be billed automatically or by hand`,
        });
      }
      continue;
    }

    try {
      await startOneCycle(cycle, verdict, result);
    } catch (err) {
      /*
       * One tenant's failure must not end the sweep. The next cycle may
       * be another tenant's, and a dispatcher that stops at the first
       * bad cycle turns one misconfiguration into everybody's missed
       * month.
       */
      const detail = err instanceof Error ? err.message : String(err);
      result.skipped.push({
        utilityId: cycle.utilityId,
        billingCycleId: cycle.id,
        cycleCode: cycle.cycleCode,
        reason: "failed",
        detail,
      });
      logger.error(
        { err, component: "billing-dispatcher", utilityId: cycle.utilityId, cycleCode: cycle.cycleCode },
        "Could not start a scheduled billing run",
      );
    }
  }

  return result;
}

/**
 * Plan, refuse or create, for one due cycle.
 *
 * Under `runAsTenant`: the read above crosses tenants by design, and
 * everything from here is one tenant's data, so it runs under that
 * tenant's authority like every other fan-out.
 */
async function startOneCycle(
  cycle: { id: string; utilityId: string; cycleCode: string },
  verdict: DueVerdict,
  result: BillingDispatchResult,
): Promise<void> {
  const { utilityId } = cycle;

  await runAsTenant(utilityId, async () => {
    const plan = await previewBillingRun(utilityId, { billingCycleId: cycle.id });

    /*
     * Idempotency is the database's, not the dispatcher's.
     * `@@unique([utilityId, billingCycleId, windowEnd])` already means
     * "one run per cycle per window", so an existing run is *already
     * done* rather than a conflict — and nothing about double-firing,
     * restarts or two nodes can produce two sets of bills. No new guard
     * should be written as if it could.
     */
    if (plan.existingRun) {
      logger.debug(
        { component: "billing-dispatcher", utilityId, cycleCode: cycle.cycleCode, runId: plan.existingRun.id },
        "A run already covers this window; nothing to start",
      );
      return;
    }

    if (!(await readsLanded(utilityId, cycle.id, plan.windowStart, plan.windowEnd))) {
      /*
       * Reads first. Billing before they land produces a bill for zero
       * usage and then a double one next period — a scheduled run must
       * refuse where a human would have noticed. Recorded, not silent:
       * a window that closes unbilled is the most expensive silence in
       * the product.
       */
      result.skipped.push({
        utilityId,
        billingCycleId: cycle.id,
        cycleCode: cycle.cycleCode,
        reason: "readsIncomplete",
        detail: `No meter read in ${plan.windowStart.toISOString().slice(0, 10)}..${plan.windowEnd.toISOString().slice(0, 10)}`,
      });
      logger.warn(
        { component: "billing-dispatcher", utilityId, cycleCode: cycle.cycleCode },
        "Not billing this cycle: no reads have landed for the window",
      );
      return;
    }

    /*
     * `actorId: null` — the schedule did this, and there is no user
     * principal to name. `billing_run.created_by` is nullable for
     * exactly this, and the audit trail carries the sentence instead.
     */
    const run = await createBillingRun(utilityId, null, DISPATCHER_ACTOR_NAME, {
      billingCycleId: cycle.id,
    });

    await enqueueSafely(
      QUEUE_NAMES.billingRuns,
      BILLING_RUN_JOB_NAME,
      {
        runId: run.id,
        utilityId,
        actorId: null,
        actorName: DISPATCHER_ACTOR_NAME,
      },
      // Deterministic per run, so a dispatcher that fires twice in an
      // hour enqueues one job. The run row is the real guard; this
      // keeps the queue tidy as well.
      { jobId: `billing-run:scheduled:${run.id}` },
    );

    result.started += 1;
    if (verdict.reason === "onSchedule") result.reasons.onSchedule += 1;
    else result.reasons.catchingUp += 1;

    logger.info(
      {
        component: "billing-dispatcher",
        utilityId,
        cycleCode: cycle.cycleCode,
        runId: run.id,
        windowEnd: plan.windowEnd.toISOString().slice(0, 10),
        reason: verdict.reason,
      },
      verdict.reason === "catchingUp"
        ? "Started a scheduled billing run late, within its own window"
        : "Started a scheduled billing run",
    );
  });

  // Outside the tenant scope: one row per tenant, written as the
  // platform actor that the job already runs under.
  await prisma.utilityConfig.update({
    where: { utilityId },
    data: { billingLastRunAt: new Date() },
  });
}

export function buildBillingDispatcher(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.billingDispatch,
    scopedJob(QUEUE_NAMES.billingDispatch, async () => {
      const result = await withTelemetry(QUEUE_NAMES.billingDispatch, () =>
        dispatchBilling(new Date()),
      );
      if (result.started > 0 || result.skipped.length > 0) {
        logger.info({ component: "billing-dispatcher", ...result }, "Billing dispatch finished");
      }
      return result;
    }),
    { ...workerOptions(QUEUE_NAMES.billingDispatch) },
  );

  worker.on("error", (err) => {
    logger.error({ err, component: "billing-dispatcher" }, "Worker emitted error event");
  });

  return worker;
}

export async function registerBillingDispatchScheduler(): Promise<void> {
  const queue = getQueue(QUEUE_NAMES.billingDispatch);
  /*
   * Hourly in UTC, and the tenant-local hour is decided inside — the
   * same division `delinquency-dispatch` uses. A cron in a tenant's own
   * zone would need one scheduler per tenant.
   *
   * This joins the list of patterns that must stay at least hourly: the
   * moment the decision reads a tenant-local hour, a slower cadence
   * means a tenant whose hour falls between fires never runs, with no
   * job and no error to show for it (SCH-FIX-3).
   */
  await queue.upsertJobScheduler(
    BILLING_DISPATCH_SCHEDULER_ID,
    { pattern: "0 * * * *", tz: "UTC" },
    { name: BILLING_DISPATCH_JOB_NAME },
  );
  logger.info(
    { component: "billing-dispatcher", schedulerId: BILLING_DISPATCH_SCHEDULER_ID, pattern: "0 * * * *" },
    "Billing dispatch cron registered",
  );
}
