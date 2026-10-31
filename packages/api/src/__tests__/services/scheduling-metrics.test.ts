import { describe, it, expect, beforeEach } from "vitest";
import { publishSchedulingAlerts } from "../../services/scheduling-metrics.js";
import { schedulingAlertGauge, schedulingAlertSecondsGauge } from "../../lib/telemetry.js";
import type { SchedulingAlert } from "../../services/scheduling-alerts.js";

/**
 * The two alert conditions, as metrics a scrape can page on.
 *
 * SCH-NODE-4 asks for "an alert, not only a row on a page", and until
 * this existed both conditions were a line on a screen somebody had to
 * open. A gauge is the one carrier that works whatever the deployment's
 * on-call surface turns out to be — Prometheus, PagerDuty, a webhook —
 * because all of them consume a metric. It is also the only carrier that
 * does not depend on the subsystem it reports on: an alert about a
 * paused mail queue cannot be delivered through that queue.
 *
 * **The verdict is exported, not the raw facts.** A rule rebuilt from
 * `next_run`, `workers` and an interval would re-derive, in PromQL, the
 * logic `scheduling-alerts` already computes and tests — including
 * reading a six-field cron — and would then be free to drift from it.
 * The thresholds here are derived rather than preferences (a scheduler's
 * own interval, a tenant's own quiet window), so there is nothing for an
 * operator to tune.
 */

function alert(over: Partial<SchedulingAlert> = {}): SchedulingAlert {
  return {
    kind: "unpromotedScheduler",
    queue: "billing-dispatch",
    schedulerId: "billing-dispatch-cron",
    message: "nothing has promoted it",
    forSeconds: 7200,
    ...over,
  };
}

/** The gauge's label names, which is all this helper may be asked about. */
type AlertLabel = "kind" | "queue" | "scheduler_id";

/** What the gauge holds for one label set, or undefined if unset. */
async function valueOf(
  gauge: typeof schedulingAlertGauge,
  labels: Partial<Record<AlertLabel, string>>,
): Promise<number | undefined> {
  const metric = await gauge.get();
  return metric.values.find((v) =>
    Object.entries(labels).every(([k, want]) => v.labels[k as AlertLabel] === want),
  )?.value;
}

beforeEach(() => {
  schedulingAlertGauge.reset();
  schedulingAlertSecondsGauge.reset();
});

describe("publishing the alert conditions", () => {
  it("raises the gauge for a condition that holds, with how long it has held", async () => {
    publishSchedulingAlerts([alert()]);

    const labels = { kind: "unpromotedScheduler", queue: "billing-dispatch" };
    expect(await valueOf(schedulingAlertGauge, labels)).toBe(1);
    expect(await valueOf(schedulingAlertSecondsGauge, labels)).toBe(7200);
  });

  it("clears a condition that has gone away", async () => {
    /*
     * The thing a naive gauge gets wrong, and the reason this is a
     * `reset` and not an `inc`. A gauge left at 1 keeps a resolved alert
     * firing for ever — so the operator who fixed it at 02:00 is paged
     * about it at 09:00, and learns to ignore the alert.
     */
    publishSchedulingAlerts([alert()]);
    publishSchedulingAlerts([]);

    const labels = { kind: "unpromotedScheduler", queue: "billing-dispatch" };
    expect(await valueOf(schedulingAlertGauge, labels)).toBeUndefined();
    expect(await valueOf(schedulingAlertSecondsGauge, labels)).toBeUndefined();
  });

  it("drops a label set that no longer appears, rather than leaving it behind", async () => {
    // A scheduler removed between ticks would otherwise keep its series
    // at the last value it had, which reads as a live condition.
    publishSchedulingAlerts([alert({ schedulerId: "retired-cron" })]);
    publishSchedulingAlerts([alert({ schedulerId: "billing-dispatch-cron" })]);

    expect(await valueOf(schedulingAlertGauge, { scheduler_id: "retired-cron" })).toBeUndefined();
    expect(
      await valueOf(schedulingAlertGauge, { scheduler_id: "billing-dispatch-cron" }),
    ).toBe(1);
  });

  it("keeps two conditions on the same queue apart", async () => {
    publishSchedulingAlerts([
      alert({ kind: "unpromotedScheduler", queue: "notification-send" }),
      alert({ kind: "mailHeldPaused", queue: "notification-send", schedulerId: null }),
    ]);

    expect(
      await valueOf(schedulingAlertGauge, { kind: "mailHeldPaused", queue: "notification-send" }),
    ).toBe(1);
    expect(
      await valueOf(schedulingAlertGauge, {
        kind: "unpromotedScheduler",
        queue: "notification-send",
      }),
    ).toBe(1);
  });

  it("labels a queue-wide condition with an empty scheduler rather than omitting it", async () => {
    /*
     * Prometheus requires every sample of a metric to carry the same
     * label names. A mail-held alert has no scheduler, so the label is
     * present and empty — omitting it would make the two kinds
     * different metrics wearing one name.
     */
    publishSchedulingAlerts([alert({ kind: "mailHeldPaused", schedulerId: null })]);

    const metric = await schedulingAlertGauge.get();
    expect(metric.values[0].labels).toHaveProperty("scheduler_id", "");
  });

  it("publishes no duration for a condition whose age is unknown", async () => {
    /*
     * A pause with no record has no start, so there is no duration to
     * report. Zero would read as "just now", which is the opposite of
     * the truth: an unrecorded pause is usually an old one.
     */
    publishSchedulingAlerts([alert({ kind: "mailHeldPaused", forSeconds: null })]);

    const labels = { kind: "mailHeldPaused" };
    expect(await valueOf(schedulingAlertGauge, labels)).toBe(1);
    expect(await valueOf(schedulingAlertSecondsGauge, labels)).toBeUndefined();
  });
});
