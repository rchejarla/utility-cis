import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What is meant to run, and when.
 *
 * The Queues page answers "what is waiting". This answers the question
 * before it: *is anything going to fire at all*. Nothing in the product
 * showed a cron's pattern, its next run or its last, and the three
 * failures that hides are each silent:
 *
 * - **Nothing armed it.** `worker.ts` registers schedulers only at boot,
 *   so a deployment where no worker started has crons that were never
 *   armed — not merely un-run. `WORKER_QUEUES` naming a subset does the
 *   same for the rest.
 * - **Nothing promotes it.** An armed scheduler on a queue with no
 *   worker goes overdue and stays there. Seen while building this spec:
 *   audit-retention sat due 2026-10-18 with the date at the 20th.
 * - **Redis holds one the code does not.** Since 2026-10-30 boot reports
 *   those rather than deleting them, which makes showing them the only
 *   way anybody sees one outside a log line.
 *
 * `docs/specs/27-job-scheduling.md` §1.
 */

const armed: Record<string, Record<string, unknown>[]> = {};
const completed: Record<string, Record<string, unknown>[]> = {};
const attachment: Record<string, { workers: number | null; paused: boolean }> = {};
let listFails: string | null = null;

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["suspension-transitions", "audit-retention", "billing-runs"],
  getQueue: vi.fn((name: string) => ({
    getJobSchedulers: vi.fn(async () => {
      if (listFails === name) throw new Error("ERR unknown command");
      return armed[name] ?? [];
    }),
    getCompleted: vi.fn(async () => completed[name] ?? []),
  })),
}));

vi.mock("../../services/queue-health.service.js", () => ({
  readQueueAttachment: vi.fn(async (name: string) => ({
    workers: attachment[name]?.workers ?? 1,
    workerAgeSeconds: 900,
    paused: attachment[name]?.paused ?? false,
  })),
}));

vi.mock("../../lib/schedulers.js", () => ({
  // A build that knows two of the three armed below.
  SCHEDULER_REGISTRY: new Set(["suspension-cron", "audit-retention-cron"]),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let svc: typeof import("../../services/scheduler-view.service.js");

const HOUR = 3_600_000;

/** One scheduler record, as BullMQ hands it over. */
function scheduler(over: Record<string, unknown> = {}) {
  return {
    key: "suspension-cron",
    name: "transition-suspensions",
    pattern: "0 * * * *",
    tz: "UTC",
    next: Date.now() + HOUR,
    iterationCount: 412,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of Object.keys(armed)) delete armed[k];
  for (const k of Object.keys(completed)) delete completed[k];
  for (const k of Object.keys(attachment)) delete attachment[k];
  listFails = null;
  svc = await import("../../services/scheduler-view.service.js");
});

describe("what is armed", () => {
  it("reports the pattern, timezone and next run from Redis, not from the source", async () => {
    // The record in Redis is what fires. A view built from the literals
    // in the worker modules would describe a deploy rather than a running
    // cluster, and would agree with it only until someone changed a
    // pattern without restarting every node.
    armed["suspension-transitions"] = [scheduler()];

    const report = await svc.getSchedulerReport();
    const row = report.schedulers.find((s) => s.schedulerId === "suspension-cron");

    expect(row).toMatchObject({
      queue: "suspension-transitions",
      jobName: "transition-suspensions",
      pattern: "0 * * * *",
      timezone: "UTC",
      iterations: 412,
      orphan: false,
      overdue: false,
    });
    expect(Date.parse(row!.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it("calls a next run in the past overdue, which is the whole signal", async () => {
    // audit-retention sat due two days back because no worker was up to
    // run it and re-arm it. A bare timestamp makes the reader do that
    // subtraction, which is how it went unnoticed.
    armed["audit-retention"] = [
      scheduler({ key: "audit-retention-cron", next: Date.now() - 2 * 24 * HOUR }),
    ];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0]).toMatchObject({ overdue: true });
  });

  it("marks one this build does not register as an orphan", async () => {
    armed["billing-runs"] = [scheduler({ key: "billing-dispatch-cron" })];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0]).toMatchObject({
      schedulerId: "billing-dispatch-cron",
      orphan: true,
    });
  });

  it("calls out a queue with no worker to promote it", async () => {
    // The ordinary state of a dev stack. An armed cron with nothing
    // attached will not fire, and the record looks perfectly healthy.
    armed["suspension-transitions"] = [scheduler()];
    attachment["suspension-transitions"] = { workers: 0, paused: false };

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0]).toMatchObject({ workers: 0 });
  });

  it("carries whether the queue is paused, since a paused queue fires nothing", async () => {
    armed["suspension-transitions"] = [scheduler()];
    attachment["suspension-transitions"] = { workers: 1, paused: true };

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0]).toMatchObject({ paused: true });
  });

  it("keeps going when one queue cannot be listed", async () => {
    listFails = "suspension-transitions";
    armed["billing-runs"] = [scheduler({ key: "billing-dispatch-cron" })];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers).toHaveLength(1);
    expect(report.reachable).toBe(true);
  });
});

describe("the crons nobody armed", () => {
  it("names a registered scheduler that no queue holds", async () => {
    /*
     * The failure the spec exists to prevent, in its purest form:
     * registration happens only at boot, so a deployment where the
     * worker never started has crons that were never armed. Nothing in
     * the product reported that — the queue looked idle, which is what
     * an idle queue looks like.
     */
    armed["suspension-transitions"] = [scheduler()];

    const report = await svc.getSchedulerReport();

    expect(report.unarmed).toEqual(["audit-retention-cron"]);
  });

  it("is empty when every registered cron is armed somewhere", async () => {
    armed["suspension-transitions"] = [scheduler()];
    armed["audit-retention"] = [scheduler({ key: "audit-retention-cron" })];

    expect((await svc.getSchedulerReport()).unarmed).toEqual([]);
  });
});

describe("when it last fired", () => {
  it("takes the newest completed job the scheduler produced", async () => {
    armed["suspension-transitions"] = [scheduler()];
    completed["suspension-transitions"] = [
      { repeatJobKey: "suspension-cron", finishedOn: Date.parse("2026-10-30T08:00:00.000Z") },
      { repeatJobKey: "suspension-cron", finishedOn: Date.parse("2026-10-30T09:00:00.000Z") },
    ];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0].lastRunAt).toBe("2026-10-30T09:00:00.000Z");
  });

  it("falls back to the job name where no repeat key is recorded", async () => {
    // Belt and braces: if BullMQ ever stops stamping `repeatJobKey`, a
    // null last run would be indistinguishable from a cron that has not
    // fired — a wrong answer with no error. The job names on these
    // queues are the cron's own, so matching one is the same work.
    armed["suspension-transitions"] = [scheduler()];
    completed["suspension-transitions"] = [
      { name: "transition-suspensions", finishedOn: Date.parse("2026-10-30T07:00:00.000Z") },
    ];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0].lastRunAt).toBe("2026-10-30T07:00:00.000Z");
  });

  it("is null when nothing of its own is in the retained window", async () => {
    // Completed jobs are kept 24h / 1000, so null means "not lately",
    // never "never". The page has to say which.
    armed["suspension-transitions"] = [scheduler()];
    completed["suspension-transitions"] = [
      { repeatJobKey: "some-other-cron", finishedOn: Date.now() },
    ];

    const report = await svc.getSchedulerReport();

    expect(report.schedulers[0].lastRunAt).toBeNull();
  });
});
