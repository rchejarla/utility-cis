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
/** Set to make a queue call hang forever, as a down Redis does. */
let hangingQueue: string | null = null;

const queueFor = (name: string) => ({
  getJobCounts: vi.fn(async () => {
    if (hangingQueue === name) return new Promise<never>(() => {});
    return counts[name] ?? { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  }),
  getFailed: vi.fn(async () => failed[name] ?? []),
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
  hangingQueue = null;
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
