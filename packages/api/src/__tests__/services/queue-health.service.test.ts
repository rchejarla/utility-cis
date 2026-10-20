import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * What the platform operator can learn about the queues without opening
 * Bull Board.
 *
 * Bull Board already shows every job, and it is the right tool for the
 * deep verbs — inspect a payload, retry, promote. What it cannot answer
 * is the question an operator actually arrives with: *is anything broken
 * right now, and whose*. It has no notion of a tenant, and a dead-
 * lettered job today only increments a gauge and writes a log line, so
 * nobody learns about it unless they go looking.
 *
 * Two things here carry most of the weight. The tenant attribution, from
 * the `utilityId` the per-tenant job payloads carry; and the timeout —
 * ioredis queues commands while disconnected and retries indefinitely,
 * so a `try/catch` around a Redis call cannot see an unreachable server.
 * It never rejects; it simply never answers. This page must say
 * "unreachable" rather than hang.
 */

const counts: Record<string, Record<string, number>> = {};
const failed: Record<string, unknown[]> = {};
/**
 * What `CLIENT LIST` reports for each queue, keyed by queue name. A
 * worker entry is a Redis client row; `age` arrives as a string, as
 * Redis prints it.
 */
const workers: Record<string, { addr?: string; age?: string }[]> = {};
const pausedQueues = new Set<string>();
/** Set to make a queue call hang forever, as a down Redis does. */
let hangingQueue: string | null = null;
/** Set to make the worker listing throw, as a Redis without the command does. */
let workerListFails = false;

const queueFor = (name: string) => ({
  getJobCounts: vi.fn(async () => {
    if (hangingQueue === name) return new Promise<never>(() => {});
    return counts[name] ?? { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  }),
  getFailed: vi.fn(async () => failed[name] ?? []),
  getWorkers: vi.fn(async () => {
    if (workerListFails) throw new Error("ERR unknown command 'client'");
    return workers[name] ?? [];
  }),
  isPaused: vi.fn(async () => pausedQueues.has(name)),
});

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "imports"],
  dlqNameFor: (n: string) => `dlq-${n}`,
  getQueue: vi.fn((n: string) => queueFor(n)),
  getDlqQueue: vi.fn((n: string) => queueFor(`dlq-${n}`)),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TENANT = "00000000-0000-4000-8000-000000000001";

let svc: typeof import("../../services/queue-health.service.js");
let prisma: typeof import("../../lib/prisma.js").prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(counts)) delete counts[key];
  for (const key of Object.keys(failed)) delete failed[key];
  for (const key of Object.keys(workers)) delete workers[key];
  pausedQueues.clear();
  hangingQueue = null;
  workerListFails = false;
  svc = await import("../../services/queue-health.service.js");
  prisma = (await import("../../lib/prisma.js")).prisma;
});

/** A failed job as BullMQ hands it over. */
function job(over: Record<string, unknown> = {}) {
  return {
    id: "1",
    name: "process-billing-run",
    failedReason: "boom",
    finishedOn: Date.parse("2026-10-20T10:00:00.000Z"),
    timestamp: Date.parse("2026-10-20T09:00:00.000Z"),
    data: { utilityId: TENANT },
    ...over,
  };
}

describe("getQueueHealth", () => {
  it("reports every registered queue, quiet ones included", async () => {
    const report = await svc.getQueueHealth();

    expect(report.reachable).toBe(true);
    expect(report.queues.map((q) => q.name)).toEqual(["billing-runs", "imports"]);
    expect(report.totals.failed).toBe(0);
  });

  it("carries each queue's counts and its dead-letter depth", async () => {
    counts["billing-runs"] = { waiting: 2, active: 1, delayed: 0, failed: 3, completed: 9 };
    // A DLQ is written to and never worked, so its jobs sit in waiting.
    counts["dlq-billing-runs"] = { waiting: 4, active: 0, delayed: 1, failed: 0, completed: 0 };

    const report = await svc.getQueueHealth();
    const billing = report.queues.find((q) => q.name === "billing-runs")!;

    expect(billing.counts).toMatchObject({ waiting: 2, active: 1, failed: 3 });
    expect(billing.dlqDepth).toBe(5);
    expect(report.totals.dlq).toBe(5);
  });

  it("names the tenant a failed job belongs to", async () => {
    // The operator's question is whose, and Bull Board structurally
    // cannot answer it.
    counts["billing-runs"] = { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0 };
    failed["billing-runs"] = [job()];
    vi.mocked(prisma.utility.findMany).mockResolvedValue([
      { id: TENANT, name: "City of Testville" },
    ] as never);

    const report = await svc.getQueueHealth();
    const failure = report.queues.find((q) => q.name === "billing-runs")!.recentFailures[0];

    expect(failure).toMatchObject({
      utilityId: TENANT,
      utilityName: "City of Testville",
      reason: "boom",
    });
  });

  it("leaves the tenant unnamed on a sweep that belongs to no one", async () => {
    // delinquency-dispatch, sla-breach-sweep and audit-retention run
    // across tenants; inventing an owner for them would be worse than
    // saying none.
    counts["imports"] = { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 0 };
    failed["imports"] = [job({ data: {} })];

    const report = await svc.getQueueHealth();
    const failure = report.queues.find((q) => q.name === "imports")!.recentFailures[0];

    expect(failure.utilityId).toBeNull();
    expect(failure.utilityName).toBeNull();
  });

  it("puts the newest failure first, whatever order the queue returned", async () => {
    // Sorted here rather than trusted: BullMQ reads the failed set with
    // a range query whose direction is its business, and "most recent"
    // is the only useful order for this page.
    counts["imports"] = { waiting: 0, active: 0, delayed: 0, failed: 2, completed: 0 };
    failed["imports"] = [
      job({ id: "old", finishedOn: Date.parse("2026-10-19T08:00:00.000Z") }),
      job({ id: "new", finishedOn: Date.parse("2026-10-20T08:00:00.000Z") }),
    ];

    const report = await svc.getQueueHealth();

    expect(report.queues.find((q) => q.name === "imports")!.recentFailures.map((f) => f.jobId))
      .toEqual(["new", "old"]);
  });

  it("says unreachable rather than hanging when Redis does not answer", async () => {
    hangingQueue = "billing-runs";

    const report = await svc.getQueueHealth({ timeoutMs: 50 });

    expect(report.reachable).toBe(false);
    expect(report.queues).toEqual([]);
  });

  it("counts the worker processes attached to each queue", async () => {
    /*
     * The counts alone cannot answer "why is nothing moving". Workers are
     * a separate process from the API — `start_dev.bat` says so out loud
     * and does not start them — so zero attached is the ordinary
     * development state and the reason a queue fills up and sits.
     */
    workers["billing-runs"] = [
      { addr: "172.24.0.1:42484", age: "900" },
      { addr: "172.24.0.1:42488", age: "30" },
    ];

    const report = await svc.getQueueHealth();

    expect(report.queues.find((q) => q.name === "billing-runs")).toMatchObject({
      workers: 2,
      // The longest-attached one: a number that keeps resetting on reload
      // is a worker restarting, which one attached-for-30s row hides.
      workerAgeSeconds: 900,
    });
    expect(report.queues.find((q) => q.name === "imports")).toMatchObject({
      workers: 0,
      workerAgeSeconds: null,
    });
  });

  it("reports a paused queue, which processes nothing however many workers are attached", async () => {
    // Nothing in this codebase pauses a queue; Bull Board's buttons and
    // redis-cli do. An operator looking at "2 workers, 80 waiting,
    // nothing happening" has no other way to find out.
    workers["imports"] = [{ addr: "172.24.0.1:1", age: "10" }];
    pausedQueues.add("imports");

    const report = await svc.getQueueHealth();

    expect(report.queues.find((q) => q.name === "imports")!.paused).toBe(true);
    expect(report.queues.find((q) => q.name === "billing-runs")!.paused).toBe(false);
  });

  it("says worker attachment is unknown rather than zero when Redis will not list clients", async () => {
    /*
     * Managed Redis (GCP Memorystore) refuses CLIENT LIST. BullMQ
     * swallows that and returns a single entry carrying only a message,
     * so counting the array would report one phantom worker; a thrown
     * error would otherwise sink the whole report. Both must come back as
     * "not known" — which the page says, instead of "no workers".
     */
    workerListFails = true;

    const report = await svc.getQueueHealth();

    expect(report.reachable).toBe(true);
    expect(report.queues.find((q) => q.name === "billing-runs")).toMatchObject({
      workers: null,
      workerAgeSeconds: null,
    });
  });

  it("does not count a client-list refusal notice as an attached worker", async () => {
    // BullMQ's own fallback shape: one entry, a message, no address.
    workers["billing-runs"] = [{ age: undefined } as never];

    const report = await svc.getQueueHealth();

    expect(report.queues.find((q) => q.name === "billing-runs")!.workers).toBeNull();
  });

  it("says unreachable when a queue call fails outright", async () => {
    counts["billing-runs"] = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
    const queues = await import("../../lib/queues.js");
    vi.mocked(queues.getQueue).mockImplementationOnce(() => {
      throw new Error("ECONNREFUSED");
    });

    const report = await svc.getQueueHealth();

    expect(report.reachable).toBe(false);
  });
});
