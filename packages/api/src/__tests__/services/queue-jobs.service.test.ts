import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Looking inside a count.
 *
 * The summary says "80 waiting" and that immediately raises the question
 * it cannot answer: waiting since when, for whom, and is the delayed one
 * the scheduler's repeatable job or something stuck. So each count is
 * drillable, fetched only when asked, rather than making the summary
 * carry samples for eight queues and five states nobody looked at.
 *
 * **The payload is not included, on purpose.** Job data holds account
 * ids, run ids, customer ids and file names — D6 sizes this actor by the
 * rule that every capability added to it can reach every customer's
 * data, so this returns the tenant, the timing and the failure reason
 * and stops there. Bull Board still shows a full payload to an operator
 * who deliberately opens one job, which is a different act from a list
 * that prints everyone's data by default.
 */

const jobsByQueue: Record<string, unknown[]> = {};
let hangingQueue: string | null = null;

const queueFor = (name: string) => ({
  getJobs: vi.fn(async () => {
    if (hangingQueue === name) return new Promise<never>(() => {});
    return jobsByQueue[name] ?? [];
  }),
});

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "audit-retention"],
  dlqNameFor: (n: string) => `dlq-${n}`,
  getQueue: vi.fn((n: string) => queueFor(n)),
  getDlqQueue: vi.fn((n: string) => queueFor(`dlq-${n}`)),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TENANT = "00000000-0000-4000-8000-000000000001";

let svc: typeof import("../../services/queue-jobs.service.js");
let prisma: typeof import("../../lib/prisma.js").prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(jobsByQueue)) delete jobsByQueue[key];
  hangingQueue = null;
  svc = await import("../../services/queue-jobs.service.js");
  prisma = (await import("../../lib/prisma.js")).prisma;
});

function job(over: Record<string, unknown> = {}) {
  return {
    id: "7",
    name: "process-billing-run",
    timestamp: Date.parse("2026-10-20T09:00:00.000Z"),
    attemptsMade: 0,
    opts: {},
    data: { utilityId: TENANT, runId: "run-1", accountId: "acct-9" },
    ...over,
  };
}

describe("getQueueJobs", () => {
  it("lists what is waiting, with the tenant named", async () => {
    jobsByQueue["billing-runs"] = [job()];
    vi.mocked(prisma.utility.findMany).mockResolvedValue([
      { id: TENANT, name: "City of Testville" },
    ] as never);

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.reachable).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      jobId: "7",
      jobName: "process-billing-run",
      utilityId: TENANT,
      utilityName: "City of Testville",
      enqueuedAt: "2026-10-20T09:00:00.000Z",
      attemptsMade: 0,
    });
  });

  it("never returns the job payload", async () => {
    // The line this service holds: tenant, timing, reason — not account
    // ids and file names. Bull Board is where a payload is read.
    jobsByQueue["billing-runs"] = [job()];

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(JSON.stringify(result)).not.toContain("acct-9");
    expect(JSON.stringify(result)).not.toContain("run-1");
    expect(result.jobs[0]).not.toHaveProperty("data");
  });

  it("says when a delayed job will run, and whether it repeats", async () => {
    // The five scheduled queues each sit at one delayed job — their
    // repeatable. "Delayed" alone cannot tell that apart from a retry
    // backing off, and the difference is whether the scheduler is armed.
    jobsByQueue["audit-retention"] = [
      job({
        name: "audit-retention",
        opts: { delay: 3_600_000, repeat: { pattern: "0 3 * * *" } },
        repeatJobKey: "audit-retention::0 3 * * *",
        data: {},
      }),
    ];

    const result = await svc.getQueueJobs("audit-retention", "delayed");

    expect(result.jobs[0]).toMatchObject({
      runsAt: "2026-10-20T10:00:00.000Z",
      repeats: "0 3 * * *",
    });
  });

  it("gives the failure reason when the state is failed", async () => {
    jobsByQueue["billing-runs"] = [
      job({ failedReason: "Bill 7 has no charges", attemptsMade: 3 }),
    ];

    const result = await svc.getQueueJobs("billing-runs", "failed");

    expect(result.jobs[0]).toMatchObject({ reason: "Bill 7 has no charges", attemptsMade: 3 });
  });

  it("reads the paired dead-letter queue for the dlq state", async () => {
    jobsByQueue["dlq-billing-runs"] = [job({ id: "dead-1" })];

    const result = await svc.getQueueJobs("billing-runs", "dlq");

    expect(result.jobs.map((j) => j.jobId)).toEqual(["dead-1"]);
  });

  it("caps how much it will return", async () => {
    jobsByQueue["billing-runs"] = Array.from({ length: 40 }, (_, i) => job({ id: String(i) }));

    const result = await svc.getQueueJobs("billing-runs", "waiting", 500);

    expect(result.jobs.length).toBeLessThanOrEqual(100);
  });

  it("refuses a queue that is not registered", async () => {
    await expect(svc.getQueueJobs("not-a-queue", "waiting")).rejects.toMatchObject({
      code: "UNKNOWN_QUEUE",
      statusCode: 404,
    });
  });

  it("says unreachable rather than hanging when Redis does not answer", async () => {
    hangingQueue = "billing-runs";

    const result = await svc.getQueueJobs("billing-runs", "waiting", 20, { timeoutMs: 50 });

    expect(result.reachable).toBe(false);
    expect(result.jobs).toEqual([]);
  });
});
