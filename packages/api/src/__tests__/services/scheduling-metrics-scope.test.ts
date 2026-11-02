import { describe, it, expect, vi, beforeEach } from "vitest";
import { currentTenant } from "../../lib/tenant-context.js";

/**
 * The worker's metrics tick reads across tenants, so it has to say so.
 *
 * `refreshSchedulingMetrics` calls `getQueueHealth`, which resolves each
 * job's tenant name through `utilityNames` — a read of `utility`, a
 * policied table. Run with no scope, the policy compares
 * `current_setting('app.current_utility_id')::uuid` against `''`, which
 * Postgres rejects as 22P02, and `getQueueHealth`'s own try/catch turns
 * that into `logger.warn("queue health check failed")`.
 *
 * So it failed every 60 seconds, at warn level, in a process nobody
 * watches — and `health.reachable` then came back false, which makes
 * the tick publish nothing *on purpose*. The scheduling alert gauges
 * have therefore been empty since they shipped, while every unit test
 * passed: they mock Prisma, and a mock has no row-level security.
 *
 * Found by running `scripts/smoke-async-import.ts` against the real
 * stack and reading the worker's log, which is the only place it was
 * ever visible.
 *
 * The platform *route* was never affected — it already runs as the
 * platform actor — which is why the console's queue page looked right
 * the whole time.
 */

const { getQueueHealth, getSchedulerReport } = vi.hoisted(() => ({
  getQueueHealth: vi.fn(),
  getSchedulerReport: vi.fn(),
}));

vi.mock("../../services/queue-health.service.js", () => ({ getQueueHealth }));
vi.mock("../../services/scheduler-view.service.js", () => ({ getSchedulerReport }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshSchedulingMetrics", () => {
  it("reads the cluster under the platform authority, not unscoped", async () => {
    let scopeDuringRead: ReturnType<typeof currentTenant> = null;
    getQueueHealth.mockImplementation(async () => {
      scopeDuringRead = currentTenant();
      return { reachable: false, queues: [] };
    });
    getSchedulerReport.mockResolvedValue({ reachable: false, schedulers: [] });

    const { refreshSchedulingMetrics } = await import(
      "../../services/scheduling-metrics.js"
    );
    await refreshSchedulingMetrics(new Date("2026-11-02T12:00:00.000Z"));

    expect(scopeDuringRead).toEqual({ kind: "platform" });
  });

  it("scopes the scheduler read too, since it runs in the same tick", async () => {
    let scopeDuringRead: ReturnType<typeof currentTenant> = null;
    getQueueHealth.mockResolvedValue({ reachable: false, queues: [] });
    getSchedulerReport.mockImplementation(async () => {
      scopeDuringRead = currentTenant();
      return { reachable: false, schedulers: [] };
    });

    const { refreshSchedulingMetrics } = await import(
      "../../services/scheduling-metrics.js"
    );
    await refreshSchedulingMetrics(new Date("2026-11-02T12:00:00.000Z"));

    expect(scopeDuringRead).toEqual({ kind: "platform" });
  });

  it("still swallows a failing tick rather than killing the interval", async () => {
    getQueueHealth.mockRejectedValue(new Error("redis gone"));
    getSchedulerReport.mockResolvedValue({ reachable: false, schedulers: [] });

    const { refreshSchedulingMetrics } = await import(
      "../../services/scheduling-metrics.js"
    );
    await expect(
      refreshSchedulingMetrics(new Date("2026-11-02T12:00:00.000Z")),
    ).resolves.toBeUndefined();
  });
});
