import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestToken, createPlatformToken } from "../setup.js";

/**
 * Who may read the queue summary, and that it is a read.
 *
 * The same boundary Bull Board was moved behind (D4): queue contents are
 * not tenant-scoped — job payloads carry utility ids, account ids, run
 * ids and file names — so a tenant admin holding every permission a
 * tenant can grant still has no business here. Being the platform actor
 * is the authority.
 *
 * The route offers no verbs. Retry, promote and remove stay in Bull
 * Board, where it is one operator acting on one job rather than a button
 * on a summary page.
 */

const report = {
  reachable: true,
  checkedAt: "2026-10-20T10:00:00.000Z",
  queues: [
    {
      name: "billing-runs",
      counts: { waiting: 0, active: 0, delayed: 0, failed: 1 },
      dlqDepth: 2,
      recentFailures: [],
    },
  ],
  totals: { waiting: 0, active: 0, failed: 1, dlq: 2 },
};

const getQueueHealth = vi.fn(async () => report);
vi.mock("../../services/queue-health.service.js", () => ({
  getQueueHealth: (...args: unknown[]) => getQueueHealth(...(args as [])),
}));

const actOnQueueJob = vi.fn();
vi.mock("../../services/queue-actions.service.js", () => ({
  QUEUE_ACTIONS: ["retry", "promote", "replay"],
  actOnQueueJob: (...args: unknown[]) => actOnQueueJob(...(args as [])),
}));

const getQueueJobs = vi.fn();
vi.mock("../../services/queue-jobs.service.js", () => ({
  QUEUE_JOB_STATES: ["waiting", "active", "delayed", "failed", "dlq"],
  getQueueJobs: (...args: unknown[]) => getQueueJobs(...(args as [])),
}));

const setPerNodeLimit = vi.fn(async () => undefined);
const setClusterLimit = vi.fn(async () => undefined);
vi.mock("../../lib/queue-limits.js", () => ({
  setPerNodeLimit: (...args: unknown[]) => setPerNodeLimit(...(args as [])),
  setClusterLimit: (...args: unknown[]) => setClusterLimit(...(args as [])),
}));

const pauseQueue = vi.fn(async () => ({
  by: "Ops",
  byId: "test-platform-001",
  at: "2026-10-30T09:00:00.000Z",
  reason: "vendor API is down",
}));
const resumeQueue = vi.fn(async () => undefined);
vi.mock("../../lib/queue-pause.js", () => ({
  pauseQueue: (...args: unknown[]) => pauseQueue(...(args as [])),
  resumeQueue: (...args: unknown[]) => resumeQueue(...(args as [])),
}));

const removeScheduler = vi.fn(async () => undefined);
vi.mock("../../lib/schedulers.js", () => ({
  SCHEDULER_REGISTRY: new Set(["suspension-cron"]),
  removeScheduler: (...args: unknown[]) => removeScheduler(...(args as [])),
}));

let app: import("fastify").FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  const { prisma } = await import("../../lib/prisma.js");
  // An active platform row is what `getPlatformActor` requires.
  vi.mocked(prisma.cisUser.findFirst).mockResolvedValue({
    id: "test-platform-001",
    utilityId: null,
    email: "platform@example.com",
    name: "Ops",
    isActive: true,
  } as never);
  app = await (await import("../../app.js")).buildApp();
  await app.ready();
});

/**
 * Taking out a cron no build knows about.
 *
 * Boot stopped deleting these on 2026-10-30, because a node booting
 * during a rolling deploy deleted the cron the newer node had just
 * armed. Removal is a deliberate act now, which means there has to be
 * somewhere to do it.
 */
describe("DELETE /api/v1/platform/queues/:name/schedulers/:id", () => {
  const url = (id: string, q = "billing-runs") =>
    `/api/v1/platform/queues/${q}/schedulers/${encodeURIComponent(id)}`;

  it("removes an orphan for the platform operator", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: url("billing-dispatch-cron"),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(removeScheduler).toHaveBeenCalledWith(
      "billing-runs",
      "billing-dispatch-cron",
      expect.anything(),
    );
  });

  it("refuses a tenant admin", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: url("billing-dispatch-cron"),
      headers: { authorization: `Bearer ${createTestToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(removeScheduler).not.toHaveBeenCalled();
  });

  it("refuses a queue that is not one", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: url("billing-dispatch-cron", "not-a-queue"),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(removeScheduler).not.toHaveBeenCalled();
  });
});

/**
 * The incident lever.
 *
 * A pause is a key in Redis that every worker already honours, so this
 * needs no part of spec 24's command path — the same fact that ruled it
 * out of *worker* control, read the other way.
 */
describe("POST /api/v1/platform/queues/:name/pause", () => {
  const url = (q = "billing-runs") => `/api/v1/platform/queues/${q}/pause`;

  it("pauses the queue for the platform operator, with their reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
      payload: { reason: "vendor API is down" },
    });

    expect(res.statusCode).toBe(200);
    expect(pauseQueue).toHaveBeenCalledWith(
      "billing-runs",
      expect.objectContaining({ id: "test-platform-001" }),
      "vendor API is down",
    );
  });

  it("refuses a pause with no reason", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(pauseQueue).not.toHaveBeenCalled();
  });

  it("refuses a queue that is not one", async () => {
    const res = await app.inject({
      method: "POST",
      url: url("not-a-queue"),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
      payload: { reason: "because" },
    });

    expect(res.statusCode).toBe(400);
    expect(pauseQueue).not.toHaveBeenCalled();
  });

  it("refuses a tenant admin, whatever they hold", async () => {
    const res = await app.inject({
      method: "POST",
      url: url(),
      headers: { authorization: `Bearer ${createTestToken()}` },
      payload: { reason: "vendor API is down" },
    });

    expect(res.statusCode).toBe(403);
    expect(pauseQueue).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/platform/queues/:name/resume", () => {
  it("resumes without asking for a reason", async () => {
    // Stopping work needs explaining; starting it again is the queue
    // doing its job. A required field here would sit between an operator
    // and the end of an incident.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/resume",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(resumeQueue).toHaveBeenCalledWith(
      "billing-runs",
      expect.objectContaining({ id: "test-platform-001" }),
    );
  });

  it("refuses a tenant admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/resume",
      headers: { authorization: `Bearer ${createTestToken()}` },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(resumeQueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/platform/queues", () => {
  it("serves the summary to the platform operator", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/queues",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ reachable: true, totals: { dlq: 2 } });
  });

  it("refuses a tenant admin, whatever they hold", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/queues",
      headers: { authorization: `Bearer ${createTestToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getQueueHealth).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/platform/queues" });

    expect(res.statusCode).toBe(401);
  });

  it("answers 200 with reachable false when Redis is down", async () => {
    // Not a 503: the page renders, and says the queues could not be
    // read. An operator seeing an error cannot tell that apart from
    // "nothing is queued".
    getQueueHealth.mockResolvedValueOnce({
      ...report,
      reachable: false,
      queues: [],
      totals: { waiting: 0, active: 0, failed: 0, dlq: 0 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/queues",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).reachable).toBe(false);
  });
});

/**
 * Setting how much of a queue runs at once.
 *
 * Two numbers, neither derived from the other: per node bounds one
 * process, the cluster limit bounds the database. The route takes
 * whichever the operator sent and leaves the other alone, because
 * sending one field must not silently reset the one not mentioned.
 */
describe("PUT /api/v1/platform/queues/:name/concurrency", () => {
  const url = (q = "billing-runs") => `/api/v1/platform/queues/${q}/concurrency`;

  const put = (payload: Record<string, number | null>, token = createPlatformToken()) =>
    app.inject({
      method: "PUT",
      url: url(),
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it("sets both limits for the platform operator", async () => {
    const res = await put({ perNode: 2, cluster: 4 });

    expect(res.statusCode).toBe(200);
    expect(setPerNodeLimit).toHaveBeenCalledWith("billing-runs", 2);
    expect(setClusterLimit).toHaveBeenCalledWith("billing-runs", 4);
  });

  it("leaves a limit alone when the body does not mention it", async () => {
    const res = await put({ cluster: 6 });

    expect(res.statusCode).toBe(200);
    expect(setClusterLimit).toHaveBeenCalledWith("billing-runs", 6);
    expect(setPerNodeLimit).not.toHaveBeenCalled();
  });

  it("clears a limit on an explicit null, which is not the same as omitting it", async () => {
    // Null removes the ceiling; omitted means "don't touch". Collapsing
    // the two would make a form that posts only what changed reset
    // everything it left out.
    const res = await put({ cluster: null });

    expect(res.statusCode).toBe(200);
    expect(setClusterLimit).toHaveBeenCalledWith("billing-runs", null);
  });

  it("accepts a cluster limit above what the fleet can reach", async () => {
    // 4 against three single-job nodes runs 3. Not an error: it binds the
    // day a fourth node joins, and refusing it would also refuse it
    // halfway through every rolling deploy.
    const res = await put({ perNode: 1, cluster: 4 });

    expect(res.statusCode).toBe(200);
    expect(setClusterLimit).toHaveBeenCalledWith("billing-runs", 4);
  });

  it("refuses zero, which would stop the queue rather than uncap it", async () => {
    const res = await put({ perNode: 0 });

    expect(res.statusCode).toBe(400);
    expect(setPerNodeLimit).not.toHaveBeenCalled();
  });

  it("refuses a queue that is not one", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/platform/queues/not-a-queue/concurrency",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
      payload: { cluster: 2 },
    });

    expect(res.statusCode).toBe(400);
    expect(setClusterLimit).not.toHaveBeenCalled();
  });

  it("refuses a tenant admin, whatever they hold", async () => {
    const res = await put({ cluster: 2 }, createTestToken());

    expect(res.statusCode).toBe(403);
    expect(setClusterLimit).not.toHaveBeenCalled();
  });
});

/**
 * Looking inside a count.
 *
 * Same authority as the summary — being the platform actor — and still
 * no verbs. The state is validated rather than passed through: an
 * unknown one would otherwise reach BullMQ and come back as an empty
 * list, which reads as "nothing waiting" when the truth is "that is not
 * a state".
 */
describe("GET /api/v1/platform/queues/:name/jobs", () => {
  const url = (q: string) => `/api/v1/platform/queues/${q}/jobs?state=waiting`;

  it("lists the jobs to the platform operator", async () => {
    getQueueJobs.mockResolvedValueOnce({
      queue: "billing-runs",
      state: "waiting",
      reachable: true,
      jobs: [
        {
          jobId: "7",
          jobName: "process-billing-run",
          utilityId: "u-1",
          utilityName: "City of Testville",
          enqueuedAt: "2026-10-20T09:00:00.000Z",
          runsAt: null,
          repeats: null,
          attemptsMade: 0,
          reason: null,
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: url("billing-runs"),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).jobs[0].utilityName).toBe("City of Testville");
  });

  it("refuses a tenant admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: url("billing-runs"),
      headers: { authorization: `Bearer ${createTestToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(getQueueJobs).not.toHaveBeenCalled();
  });

  it("refuses a state that is not one", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/queues/billing-runs/jobs?state=pending",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(getQueueJobs).not.toHaveBeenCalled();
  });

  it("requires the state to be named at all", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/platform/queues/billing-runs/jobs",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(400);
  });

  it("passes an unknown queue through to the service's 404", async () => {
    getQueueJobs.mockRejectedValueOnce(
      Object.assign(new Error('No queue named "nope".'), {
        code: "UNKNOWN_QUEUE",
        statusCode: 404,
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: url("nope"),
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(404);
  });
});

/**
 * The verbs, which is the one part of this that changes anything.
 *
 * A POST, so it carries the operator's bearer token exactly like every
 * other call the console makes — no cookie, and therefore no CSRF
 * question for a control that re-runs work. The actor goes through to
 * the service, because the point of moving these out of Bull Board is
 * that the row says who.
 */
describe("POST /api/v1/platform/queues/:name/jobs/:id/:action", () => {
  it("retries a job as the operator who asked", async () => {
    actOnQueueJob.mockResolvedValueOnce({
      queue: "billing-runs",
      jobId: "80",
      action: "retry",
      audited: true,
      auditedAs: { entityType: "BillingRun", entityId: "run-1" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/jobs/80/retry",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).audited).toBe(true);
    expect(actOnQueueJob).toHaveBeenCalledWith(
      "billing-runs",
      "80",
      "retry",
      expect.objectContaining({ id: "test-platform-001", source: "platform:test-platform-001" }),
    );
  });

  it("refuses a tenant admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/jobs/80/retry",
      headers: { authorization: `Bearer ${createTestToken()}` },
    });

    expect(res.statusCode).toBe(403);
    expect(actOnQueueJob).not.toHaveBeenCalled();
  });

  it("refuses a verb it does not have", async () => {
    // Pause, drain and clean are deliberately absent, and an unknown
    // one must not reach the service as a string.
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/jobs/80/drain",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(400);
    expect(actOnQueueJob).not.toHaveBeenCalled();
  });

  it("passes the service's refusal through with its own status", async () => {
    actOnQueueJob.mockRejectedValueOnce(
      Object.assign(new Error("Job 80 is waiting; retry applies to a job that is failed"), {
        code: "WRONG_STATE",
        statusCode: 409,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/platform/queues/billing-runs/jobs/80/retry",
      headers: { authorization: `Bearer ${createPlatformToken()}` },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.message).toMatch(/retry applies/);
  });
});
