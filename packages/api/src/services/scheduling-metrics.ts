/**
 * The two alert conditions, as metrics a scrape can page on.
 *
 * `scheduling-alerts` decides whether a condition holds; this publishes
 * it. Separate modules because they are separate jobs — one is a
 * judgement about the cluster, the other is an exposition format — and
 * because the deciding half must stay importable without dragging the
 * telemetry registry and the worker layer with it.
 *
 * **Why a metric at all, when the console already shows both.**
 * SCH-NODE-4 asks for "an alert, not only a row on a page", and a row on
 * a page is exactly what a detection on `/platform/cluster` is: it
 * requires somebody to open it. A gauge is the one carrier that works
 * whatever this deployment's on-call surface turns out to be —
 * Prometheus, PagerDuty, a webhook — since all of them consume a metric.
 *
 * It is also the only carrier that does not depend on the subsystem it
 * reports on. The alternative considered and rejected was mail through
 * the notification outbox, which would have needed `utility_id` nullable
 * on `notification` and `notification_template`. That part is cheap and
 * the isolation holds (a NULL never matches `utility_id = $1`), but the
 * delivery is circular: SCH-PAUSE-6's condition *is* a paused
 * `notification-send`, and SCH-NODE-4's includes having no worker — and
 * a worker is what drains the outbox. An alert about a stopped mail
 * queue, queued in that stopped mail queue, arrives once somebody has
 * already fixed it.
 *
 * **Where this runs.** In the worker, on a plain interval, because the
 * worker is what exposes `/metrics` (`lib/health-server.ts`; the API has
 * no such route). Not a queued job: the conditions include "nothing is
 * draining the queues", so an evaluator that was itself a job would be
 * subject to the failure it reports.
 *
 * The gap that leaves is a deployment with **no worker at all**, which
 * publishes nothing. That is the right division: a dead process cannot
 * report its own death, and `up` / `absent()` on the worker target is
 * what answers it. What a *running* worker adds is the case staleness
 * alerting cannot see — `WORKER_QUEUES` naming a subset, so the process
 * is healthy while one queue has nothing attached at all.
 */
import { logger } from "../lib/logger.js";
import { schedulingAlertGauge, schedulingAlertSecondsGauge } from "../lib/telemetry.js";
import { getQueueHealth } from "./queue-health.service.js";
import { getSchedulerReport } from "./scheduler-view.service.js";
import { getSchedulingAlerts, type SchedulingAlert } from "./scheduling-alerts.js";

/**
 * How often to look.
 *
 * A minute, against thresholds measured in a scheduler's own interval —
 * the shortest of which is ten seconds, but a ten-second cron that has
 * gone unpromoted will still be unpromoted a minute later, and the
 * alerting rule's own `for:` clause is where impatience belongs. Each
 * tick is a bounded set of Redis reads: both reports carry their own
 * deadline.
 */
export const METRICS_INTERVAL_MS = 60_000;

/**
 * Write the current conditions to the gauges.
 *
 * `reset()` before each write, which is the whole correctness of this
 * function: a gauge left at 1 keeps a resolved alert firing, so the
 * operator who fixed it at 02:00 is paged about it at 09:00 and learns
 * to ignore the alert. Resetting also drops a label set that no longer
 * appears — a scheduler removed between ticks would otherwise keep its
 * series at the last value it had, which reads as a live condition.
 */
export function publishSchedulingAlerts(alerts: readonly SchedulingAlert[]): void {
  schedulingAlertGauge.reset();
  schedulingAlertSecondsGauge.reset();

  for (const alert of alerts) {
    /*
     * Every sample of a metric has to carry the same label names, so a
     * queue-wide condition gets an empty `scheduler_id` rather than
     * none. Omitting it would make the two kinds two different metrics
     * wearing one name.
     */
    const labels = {
      kind: alert.kind,
      queue: alert.queue,
      scheduler_id: alert.schedulerId ?? "",
    };

    schedulingAlertGauge.set(labels, 1);
    /*
     * No duration where the age is unknowable — a pause with no record
     * has no start. Zero would read as "just now", which is the
     * opposite of the truth: an unrecorded pause is usually an old one.
     */
    if (alert.forSeconds !== null) {
      schedulingAlertSecondsGauge.set(labels, alert.forSeconds);
    }
  }
}

/** Read the cluster and publish. Tolerant: a bad tick costs one tick. */
export async function refreshSchedulingMetrics(now: Date = new Date()): Promise<void> {
  try {
    const [health, schedulers] = await Promise.all([getQueueHealth(), getSchedulerReport()]);

    /*
     * An unreadable report publishes nothing rather than zeroes. Zeroes
     * would assert "no condition holds", which is a claim nothing has
     * checked — and the last good values staying put until the next tick
     * is the more honest gap, because staleness is what `up` and
     * `absent()` are for.
     */
    if (!health.reachable) return;

    publishSchedulingAlerts(
      await getSchedulingAlerts(
        health.queues,
        schedulers.reachable ? schedulers.schedulers : null,
        now,
      ),
    );
  } catch (err) {
    logger.warn({ err, component: "scheduling-metrics" }, "Could not refresh scheduling metrics");
  }
}

/**
 * Evaluate on an interval until the returned stop is called.
 *
 * `unref` so the timer never holds the process open: a worker draining
 * for a deploy must not wait on a metrics tick, and the shutdown path
 * stops it explicitly anyway.
 */
export function startSchedulingMetrics(intervalMs: number = METRICS_INTERVAL_MS): () => void {
  // One straight away, so a scrape within the first minute of a boot has
  // something truthful rather than nothing.
  void refreshSchedulingMetrics();

  const timer = setInterval(() => void refreshSchedulingMetrics(), intervalMs);
  timer.unref();

  logger.info(
    { component: "scheduling-metrics", intervalMs },
    "Publishing scheduling alert conditions",
  );

  return () => clearInterval(timer);
}
