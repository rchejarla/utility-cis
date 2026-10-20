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

const getQueueJobs = vi.fn();
vi.mock("../../services/queue-jobs.service.js", () => ({
  QUEUE_JOB_STATES: ["waiting", "active", "delayed", "failed", "dlq"],
  getQueueJobs: (...args: unknown[]) => getQueueJobs(...(args as [])),
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
