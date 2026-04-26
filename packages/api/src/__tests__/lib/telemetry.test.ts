import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  withTelemetry,
  registry,
  jobAttemptsCounter,
  jobDurationHistogram,
} from "../../lib/telemetry.js";

/**
 * Unit tests for `withTelemetry` — the canonical wrapper every job
 * handler runs through. Verifies that:
 *   - success path increments outcome="success", failure path
 *     increments outcome="failed"
 *   - histogram observations record per-call durations
 *   - the wrapper preserves the inner function's return value
 *   - exceptions re-throw (BullMQ's retry needs the rejection)
 *
 * The OTel span side of the wrapper is intentionally NOT asserted
 * here — `trace.getTracer` returns a no-op tracer when no SDK is
 * registered, and we don't register one in tests. Spans become real
 * data when ship 2 wires the OTel exporter; until then the assertion
 * surface is metrics-only.
 */

async function getCounterValue(queue: string, outcome: "success" | "failed"): Promise<number> {
  const m = await jobAttemptsCounter.get();
  const sample = m.values.find(
    (v) => v.labels.queue === queue && v.labels.outcome === outcome,
  );
  return sample?.value ?? 0;
}

async function getHistogramSampleCount(
  queue: string,
  outcome: "success" | "failed",
): Promise<number> {
  // prom-client exposes one "_count" sample per labelset for a histogram.
  const m = await jobDurationHistogram.get();
  const sample = m.values.find(
    (v) =>
      v.metricName === "job_duration_seconds_count" &&
      v.labels.queue === queue &&
      v.labels.outcome === outcome,
  );
  return sample?.value ?? 0;
}

beforeEach(() => {
  // Reset metric state between tests so sample counts aren't carried
  // across cases. We can't `registry.clear()` because that detaches
  // the metric registrations from the singleton; just reset values.
  jobAttemptsCounter.reset();
  jobDurationHistogram.reset();
});

describe("withTelemetry", () => {
  it("returns the inner function's resolved value on success", async () => {
    const result = await withTelemetry("suspension-transitions", async () => ({
      activated: 3,
      completed: 2,
    }));
    expect(result).toEqual({ activated: 3, completed: 2 });
  });

  it("records outcome=success counter on the success path", async () => {
    await withTelemetry("notification-send", async () => "ok");
    expect(await getCounterValue("notification-send", "success")).toBe(1);
    expect(await getCounterValue("notification-send", "failed")).toBe(0);
  });

  it("records a duration sample on the success path", async () => {
    await withTelemetry("sla-breach-sweep", async () => 42);
    expect(await getHistogramSampleCount("sla-breach-sweep", "success")).toBe(1);
  });

  it("re-throws on failure (BullMQ needs the rejection to schedule retry)", async () => {
    const err = new Error("synthetic handler failure");
    await expect(
      withTelemetry("delinquency-tenant", async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });

  it("records outcome=failed counter on the failure path", async () => {
    await expect(
      withTelemetry("audit-retention", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await getCounterValue("audit-retention", "failed")).toBe(1);
    expect(await getCounterValue("audit-retention", "success")).toBe(0);
  });

  it("records a duration sample on the failure path too (visibility into slow failures)", async () => {
    await expect(
      withTelemetry("audit-retention", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect(await getHistogramSampleCount("audit-retention", "failed")).toBe(1);
  });

  it("scopes labels per queue — separate counters never collide", async () => {
    await withTelemetry("suspension-transitions", async () => "ok");
    await withTelemetry("notification-send", async () => "ok");
    await withTelemetry("notification-send", async () => "ok");

    expect(await getCounterValue("suspension-transitions", "success")).toBe(1);
    expect(await getCounterValue("notification-send", "success")).toBe(2);
  });

  it("increments after the inner function awaits (not eagerly)", async () => {
    let counterValueDuringInner: number | null = null;
    await withTelemetry("delinquency-dispatch", async () => {
      // While the inner is running, the counter shouldn't have moved
      // yet — it's incremented in the finally/then path.
      counterValueDuringInner = await getCounterValue(
        "delinquency-dispatch",
        "success",
      );
    });
    expect(counterValueDuringInner).toBe(0);
    expect(await getCounterValue("delinquency-dispatch", "success")).toBe(1);
  });
});

describe("registry", () => {
  it("includes the documented metrics", async () => {
    const exposition = await registry.metrics();
    expect(exposition).toContain("job_duration_seconds");
    expect(exposition).toContain("job_attempts_total");
    expect(exposition).toContain("job_lag_seconds");
    expect(exposition).toContain("queue_depth");
    expect(exposition).toContain("dlq_depth");
    expect(exposition).toContain("tenant_automation_enabled");
  });

  it("includes Node.js default metrics (process_*)", async () => {
    const exposition = await registry.metrics();
    expect(exposition).toContain("process_cpu_user_seconds_total");
    expect(exposition).toContain("process_resident_memory_bytes");
  });
});
