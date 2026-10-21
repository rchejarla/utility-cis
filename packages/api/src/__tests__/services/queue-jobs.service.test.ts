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
/** Every `getJobs` call, so the range and the sort order can be asserted. */
const getJobsCalls: [unknown, number, number, boolean][] = [];

const queueFor = (name: string) => ({
  getJobs: vi.fn(async (states: unknown, start: number, end: number, asc: boolean) => {
    getJobsCalls.push([states, start, end, asc]);
    if (hangingQueue === name) return new Promise<never>(() => {});
    return jobsByQueue[name] ?? [];
  }),
});

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "audit-retention"],
  QUEUE_TENANCY: { "billing-runs": "per-tenant", "audit-retention": "all-tenants" },
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
  getJobsCalls.length = 0;
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

/** Both of the things a billing-run job names are present. */
function everythingExists() {
  vi.mocked(prisma.utility.findMany).mockResolvedValue([
    { id: TENANT, name: "City of Testville" },
  ] as never);
  vi.mocked(prisma.billingRun.findMany).mockResolvedValue([{ id: "run-1" }] as never);
}

describe("getQueueJobs", () => {
  it("lists what is waiting, with the tenant named", async () => {
    jobsByQueue["billing-runs"] = [job()];
    everythingExists();

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

  /*
   * What has already run, which is the only evidence a quiet cron queue
   * is working at all.
   *
   * `notification-send` had completed 255 jobs in its retention window
   * while `worker.log` held not one line about any of them, because the
   * handler logs only a non-empty tick — deliberately, at 8,640 ticks a
   * day. So "is the notification pipeline alive" had no answer anywhere
   * except sampling the delayed set twice by hand and watching the due
   * time advance.
   */
  it("lists what has run, with when and how long it took", async () => {
    jobsByQueue["audit-retention"] = [
      job({
        name: "sweep-expired-audits",
        data: {},
        timestamp: Date.parse("2026-10-21T04:00:00.000Z"),
        processedOn: Date.parse("2026-10-21T04:00:01.000Z"),
        finishedOn: Date.parse("2026-10-21T04:00:01.250Z"),
        returnvalue: { deleted: 12, batches: 1, timedOut: false },
      }),
    ];

    const result = await svc.getQueueJobs("audit-retention", "completed");

    expect(result.jobs[0]).toMatchObject({
      finishedAt: "2026-10-21T04:00:01.250Z",
      durationMs: 250,
      result: { deleted: 12, batches: 1, timedOut: false },
    });
  });

  it("returns only the scalar fields of a result", async () => {
    /*
     * `returnvalue` is whatever the handler returned. Today every one of
     * them returns aggregate counts, which is exactly what an operator
     * wants — but it is a generic field, and the rule that this service
     * never returns a payload exists because a future handler could put
     * ids in it. Enforced rather than assumed.
     */
    jobsByQueue["billing-runs"] = [
      job({
        finishedOn: Date.parse("2026-10-21T04:00:01.000Z"),
        processedOn: Date.parse("2026-10-21T04:00:00.000Z"),
        returnvalue: {
          status: "COMPLETED",
          billedCount: 412,
          dryRun: false,
          accountIds: ["acct-9", "acct-10"],
          detail: { customerEmail: "jane@example.com" },
        },
      }),
    ];

    const result = await svc.getQueueJobs("billing-runs", "completed");

    expect(result.jobs[0].result).toEqual({
      status: "COMPLETED",
      billedCount: 412,
      dryRun: false,
    });
    expect(JSON.stringify(result)).not.toContain("acct-9");
    expect(JSON.stringify(result)).not.toContain("jane@example.com");
  });

  it("asks Redis for newest-first and does not reorder what comes back", async () => {
    /*
     * Ordering is BullMQ's job, and it must be, because a local sort can
     * only order one page. With `asc=false` its Lua reads a completed set
     * with ZREVRANGE — verified in `getRanges-1.lua` — so page two is the
     * next-oldest twenty, still descending. An in-page sort on top of
     * that is a no-op that would quietly become wrong the day the
     * underlying order changed, so the flag is passed explicitly and the
     * service passes the result through.
     */
    jobsByQueue["audit-retention"] = [
      job({ id: "newest", finishedOn: Date.parse("2026-10-21T04:00:00.000Z"), data: {} }),
      job({ id: "older", finishedOn: Date.parse("2026-10-20T04:00:00.000Z"), data: {} }),
    ];

    const result = await svc.getQueueJobs("audit-retention", "completed");

    expect(result.jobs.map((j) => j.jobId)).toEqual(["newest", "older"]);
    const [, , , asc] = getJobsCalls[0];
    expect(asc).toBe(false);
  });

  it("takes a page from further in when given an offset", async () => {
    jobsByQueue["billing-runs"] = [job({ id: "21" })];

    const result = await svc.getQueueJobs("billing-runs", "waiting", 20, { offset: 20 });

    /*
     * 20..40 inclusive — twenty-one, one past the page. Whether that
     * extra one arrives is how `hasMore` is answered, which beats a
     * count: these sets move under us, so a total that was true a second
     * ago is not a total.
     */
    const [, start, end] = getJobsCalls[0];
    expect(start).toBe(20);
    expect(end).toBe(40);
    // And the extra one is not shown.
    expect(result.jobs).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });

  it("says there is another page when one more job came back than asked for", async () => {
    jobsByQueue["billing-runs"] = Array.from({ length: 4 }, (_, i) => job({ id: String(i) }));

    const result = await svc.getQueueJobs("billing-runs", "waiting", 3);

    expect(result.jobs.map((j) => j.jobId)).toEqual(["0", "1", "2"]);
    expect(result.hasMore).toBe(true);
  });

  it("reads every queue when the name is `all`", async () => {
    /*
     * `all` rather than a second endpoint, and the same sentinel
     * `WORKER_QUEUES` already uses for every queue. "Where are all the
     * failures" is a question about the deployment, not about a queue,
     * and making the operator try eight in turn is not an answer.
     */
    jobsByQueue["billing-runs"] = [
      job({ id: "b1", finishedOn: Date.parse("2026-10-21T10:00:00.000Z") }),
    ];
    jobsByQueue["audit-retention"] = [
      job({ id: "a1", data: {}, finishedOn: Date.parse("2026-10-21T11:00:00.000Z") }),
    ];

    const result = await svc.getQueueJobs("all", "failed");

    expect(result.queue).toBe("all");
    // Merged newest-first across queues, and each job says which it is in.
    expect(result.jobs.map((j) => `${j.queue}:${j.jobId}`)).toEqual([
      "audit-retention:a1",
      "billing-runs:b1",
    ]);
  });

  it("names the queue on every job, so a merged list can say where each came from", async () => {
    jobsByQueue["billing-runs"] = [job()];

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].queue).toBe("billing-runs");
  });

  it("does not call a completed job invalid for a record that has since gone", async () => {
    // It already ran. The run it names may well have been cleaned up
    // since, and calling that a problem would be backwards.
    jobsByQueue["billing-runs"] = [
      job({ finishedOn: Date.parse("2026-10-21T04:00:00.000Z") }),
    ];
    vi.mocked(prisma.billingRun.findMany).mockResolvedValue([] as never);

    const result = await svc.getQueueJobs("billing-runs", "completed");

    expect(result.jobs[0].invalid).toBeNull();
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

  /*
   * A parked job can already be impossible, and listing it as "waiting"
   * says the opposite.
   *
   * Found in the dev stack: 80 waiting billing-run jobs naming runs that
   * do not exist (`billing_run` is empty) and 22 waiting import jobs
   * naming tenant …0000aa, which is not a row in `utility`. Every one of
   * them will fail the instant a worker picks it up — the tenant FK is
   * ON DELETE RESTRICT, so nothing can even be written for a tenant that
   * is gone. The operator cannot see any of this: the payload is
   * deliberately withheld, so "whose work is this and can it run" is a
   * question only the API can answer.
   */
  it("marks a job whose tenant no longer exists", async () => {
    jobsByQueue["billing-runs"] = [job()];
    vi.mocked(prisma.utility.findMany).mockResolvedValue([] as never);

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].utilityName).toBeNull();
    expect(result.jobs[0].invalid).toMatch(/tenant no longer exists/i);
  });

  it("marks a job whose billing run no longer exists", async () => {
    jobsByQueue["billing-runs"] = [job()];
    vi.mocked(prisma.utility.findMany).mockResolvedValue([
      { id: TENANT, name: "City of Testville" },
    ] as never);
    vi.mocked(prisma.billingRun.findMany).mockResolvedValue([] as never);

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].invalid).toMatch(/billing run/i);
    expect(result.jobs[0].invalid).toMatch(/no longer exists/i);
  });

  it("does not put the record's id in the problem it reports", async () => {
    // Same line as the payload: the problem is a sentence, not an id.
    jobsByQueue["billing-runs"] = [job()];
    vi.mocked(prisma.utility.findMany).mockResolvedValue([
      { id: TENANT, name: "City of Testville" },
    ] as never);
    vi.mocked(prisma.billingRun.findMany).mockResolvedValue([] as never);

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].invalid).not.toContain("run-1");
  });

  it("marks a per-tenant job that names no tenant at all", async () => {
    jobsByQueue["billing-runs"] = [job({ data: {} })];

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].invalid).toMatch(/no tenant/i);
  });

  it("says nothing is wrong when the tenant and the record are both there", async () => {
    jobsByQueue["billing-runs"] = [job()];
    everythingExists();

    const result = await svc.getQueueJobs("billing-runs", "waiting");

    expect(result.jobs[0].invalid).toBeNull();
  });

  it("calls a cross-tenant sweep what it is, not a job missing its tenant", async () => {
    /*
     * The five cron queues are enqueued only by `worker.ts` and each runs
     * one cross-tenant sweep — `sweepSuspensionsAllTenants`,
     * `sweepExpiredSchedulerAudits` and so on. A blank tenant there is
     * correct and a blank tenant on `billing-runs` is a broken job; they
     * rendered identically, which is what made the list read as nonsense.
     */
    jobsByQueue["audit-retention"] = [
      job({ name: "sweep-expired-audits", data: {}, opts: { delay: 1000 } }),
    ];

    const result = await svc.getQueueJobs("audit-retention", "delayed");

    expect(result.jobs[0]).toMatchObject({ tenancy: "all-tenants", invalid: null });
    expect(result.jobs[0].utilityId).toBeNull();
  });

  it("asks the database once for the whole page of jobs", async () => {
    // Twenty jobs must not be twenty round trips; this is the reason the
    // check is affordable on every open at all.
    jobsByQueue["billing-runs"] = Array.from({ length: 20 }, (_, i) =>
      job({ id: String(i), data: { utilityId: TENANT, runId: `run-${i}` } }),
    );
    everythingExists();

    await svc.getQueueJobs("billing-runs", "waiting");

    expect(prisma.utility.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.billingRun.findMany).toHaveBeenCalledTimes(1);
  });
});
