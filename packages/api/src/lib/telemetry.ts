import { Histogram, Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { trace } from "@opentelemetry/api";

/**
 * Telemetry primitives shared between API and worker.
 *
 * Prometheus: `registry.metrics()` is exposed at `/metrics` on the worker
 * (see lib/health-server.ts). The API also exposes `/metrics` to surface
 * request-handling counters once API instrumentation lands.
 *
 * OTel spans: created here but the SDK / exporter is not wired in ship 1.
 * `trace.getTracer(...)` returns a no-op tracer when no SDK is registered,
 * so calling `tracer.startSpan(...)` is safe and zero-cost. Ship 2 adds
 * the SDK and the OTLP exporter; spans then start flowing without code
 * changes.
 *
 * The `withTelemetry` wrapper is the canonical way to instrument a job
 * handler. It records duration, increments the attempt counter, and
 * starts/closes a span — all in one place, so individual handlers stay
 * focused on business logic.
 */

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const DURATION_BUCKETS = [0.1, 0.5, 1, 5, 30, 60, 300];

export const jobDurationHistogram = new Histogram({
  name: "job_duration_seconds",
  help: "Duration of background job executions in seconds.",
  labelNames: ["queue", "outcome"],
  buckets: DURATION_BUCKETS,
  registers: [registry],
});

export const jobAttemptsCounter = new Counter({
  name: "job_attempts_total",
  help: "Total number of job attempts by outcome (success / failed / retry).",
  labelNames: ["queue", "outcome"],
  registers: [registry],
});

export const jobLagGauge = new Gauge({
  name: "job_lag_seconds",
  help: "Time between scheduled-at and started-at for a job. Surfaces worker saturation.",
  labelNames: ["queue"],
  registers: [registry],
});

export const queueDepthGauge = new Gauge({
  name: "queue_depth",
  help: "Number of jobs in a given queue state.",
  labelNames: ["queue", "state"],
  registers: [registry],
});

export const dlqDepthGauge = new Gauge({
  name: "dlq_depth",
  help: "Number of dead-lettered jobs by source queue.",
  labelNames: ["queue"],
  registers: [registry],
});

export const tenantAutomationGauge = new Gauge({
  name: "tenant_automation_enabled",
  help: "Number of tenants with each scheduler enabled.",
  labelNames: ["scheduler"],
  registers: [registry],
});

/**
 * The scheduling conditions worth paging on (SCH-NODE-4, SCH-PAUSE-6).
 *
 * 1 while a condition holds, and the series disappears when it clears —
 * see `publishSchedulingAlerts`, which resets before each write. A gauge
 * left at 1 keeps a resolved alert firing, which teaches an operator to
 * ignore it.
 *
 * **The verdict, not the raw facts.** A rule rebuilt from a next-run
 * timestamp, a worker count and a cron interval would re-derive in PromQL
 * what `scheduling-alerts` already computes and tests, and would then be
 * free to drift from it. The thresholds are derived rather than
 * preferences — a scheduler's own interval, a tenant's own quiet window —
 * so there is nothing here for an operator to tune.
 *
 * Set by a plain interval in the worker, deliberately **not** by a queued
 * job: the conditions include "nothing is draining the queues", and an
 * evaluator that was itself a job would be subject to the failure it
 * reports.
 */
export const schedulingAlertGauge = new Gauge({
  name: "scheduling_alert",
  help: "1 while a scheduling alert condition holds (kind: unpromotedScheduler | mailHeldPaused).",
  labelNames: ["kind", "queue", "scheduler_id"],
  registers: [registry],
});

/** How long the condition has held. Absent where the age is unknowable. */
export const schedulingAlertSecondsGauge = new Gauge({
  name: "scheduling_alert_seconds",
  help: "Seconds a scheduling alert condition has held, where that is known.",
  labelNames: ["kind", "queue", "scheduler_id"],
  registers: [registry],
});

export const tracer = trace.getTracer("utility-cis-worker", "1.0.0");

/**
 * Wrap a job handler in observability — duration histogram, attempts
 * counter, and an OTel span. Re-throws on failure so BullMQ's retry
 * logic kicks in normally.
 */
export async function withTelemetry<T>(
  queueName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(`job.${queueName}`, {
    attributes: { "job.queue": queueName },
  });
  const startedAt = Date.now();
  try {
    const result = await fn();
    const elapsed = (Date.now() - startedAt) / 1000;
    jobDurationHistogram.observe({ queue: queueName, outcome: "success" }, elapsed);
    jobAttemptsCounter.inc({ queue: queueName, outcome: "success" });
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err) {
    const elapsed = (Date.now() - startedAt) / 1000;
    jobDurationHistogram.observe({ queue: queueName, outcome: "failed" }, elapsed);
    jobAttemptsCounter.inc({ queue: queueName, outcome: "failed" });
    if (err instanceof Error) span.recordException(err);
    span.setStatus({ code: 2 }); // ERROR
    throw err;
  } finally {
    span.end();
  }
}
