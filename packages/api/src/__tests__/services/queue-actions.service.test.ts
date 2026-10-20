import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The three verbs, in the console that can record who used them.
 *
 * Bull Board has these already and cannot be opened from a browser —
 * `authMiddleware` reads only the `authorization` header, so a tab
 * navigating to /admin/queues is refused. Rather than add a second
 * authentication path for a UI whose buttons delete jobs, the verbs move
 * here, where the page's own bearer token carries them and the actor is
 * known.
 *
 * **What can be audited is narrower than it looks.** `audit_log`
 * requires a `utility_id` AND a uuid `entity_id`, and a BullMQ job id is
 * "80" or "repeat:audit-retention-cron:1792296000000". So an action is
 * recorded only where the payload names a tenant and an entity:
 * `billing-runs` carries `runId`, `imports` carries `batchId`. The
 * sweeps carry neither, `delinquency-tenant` names a tenant but no
 * entity — those actions happen and say they were not recorded, which is
 * the honest answer rather than a row attributed to the wrong thing.
 */

const state: Record<string, string> = {};
const jobs: Record<string, Record<string, unknown> | undefined> = {};
const retry = vi.fn();
const promote = vi.fn();
const remove = vi.fn();
const add = vi.fn();

function jobObject(id: string, queue: string) {
  const data = jobs[`${queue}:${id}`];
  if (!data) return null;
  return {
    id,
    name: "process-billing-run",
    data,
    getState: vi.fn(async () => state[`${queue}:${id}`] ?? "waiting"),
    retry,
    promote,
    remove,
  };
}

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "imports", "audit-retention", "delinquency-tenant"],
  dlqNameFor: (n: string) => `dlq-${n}`,
  getQueue: vi.fn((n: string) => ({
    getJob: vi.fn(async (id: string) => jobObject(id, n)),
    add,
  })),
  getDlqQueue: vi.fn((n: string) => ({
    getJob: vi.fn(async (id: string) => jobObject(id, `dlq-${n}`)),
    add,
  })),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TENANT = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-00000000r001".replace("r", "a");
const OPERATOR = "00000000-0000-4000-8000-aaaa0000e001";
const actor = { id: OPERATOR, name: "Pat Operator", source: `platform:${OPERATOR}` };

let svc: typeof import("../../services/queue-actions.service.js");
let prisma: typeof import("../../lib/prisma.js").prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of Object.keys(state)) delete state[k];
  for (const k of Object.keys(jobs)) delete jobs[k];
  svc = await import("../../services/queue-actions.service.js");
  prisma = (await import("../../lib/prisma.js")).prisma;
});

describe("actOnQueueJob", () => {
  it("retries a failed job and records it against the run", async () => {
    jobs["billing-runs:80"] = { utilityId: TENANT, runId: RUN };
    state["billing-runs:80"] = "failed";

    const result = await svc.actOnQueueJob("billing-runs", "80", "retry", actor);

    expect(retry).toHaveBeenCalled();
    expect(result).toMatchObject({
      audited: true,
      auditedAs: { entityType: "BillingRun", entityId: RUN },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("refuses to retry a job that has not failed", async () => {
    // BullMQ throws its own error for this; refusing first says why in
    // words an operator can act on.
    jobs["billing-runs:80"] = { utilityId: TENANT, runId: RUN };
    state["billing-runs:80"] = "waiting";

    await expect(svc.actOnQueueJob("billing-runs", "80", "retry", actor)).rejects.toMatchObject({
      code: "WRONG_STATE",
      statusCode: 409,
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it("promotes a delayed job, which is how an overdue repeatable is run", async () => {
    jobs["audit-retention:repeat:1"] = {};
    state["audit-retention:repeat:1"] = "delayed";

    const result = await svc.actOnQueueJob("audit-retention", "repeat:1", "promote", actor);

    expect(promote).toHaveBeenCalled();
    // A sweep names no tenant, so there is nothing to record it against.
    expect(result.audited).toBe(false);
  });

  it("refuses to promote a job that is not delayed", async () => {
    jobs["audit-retention:x"] = {};
    state["audit-retention:x"] = "completed";

    await expect(
      svc.actOnQueueJob("audit-retention", "x", "promote", actor),
    ).rejects.toMatchObject({ code: "WRONG_STATE" });
  });

  it("replays a dead-lettered job back onto its own queue, then drops the copy", async () => {
    jobs["dlq-imports:9"] = { utilityId: TENANT, batchId: RUN };

    const result = await svc.actOnQueueJob("imports", "9", "replay", actor);

    expect(add).toHaveBeenCalled();
    // The dead-letter copy goes only after the replay was accepted, so a
    // failure to re-enqueue cannot lose the job.
    expect(remove).toHaveBeenCalled();
    expect(result).toMatchObject({
      audited: true,
      auditedAs: { entityType: "ImportBatch", entityId: RUN },
    });
  });

  it("says plainly when an action could not be recorded", async () => {
    // delinquency-tenant names a tenant but no entity, and
    // `audit_log.entity_id` is a uuid column — so there is nothing to
    // attribute the row to.
    jobs["delinquency-tenant:3"] = { utilityId: TENANT };
    state["delinquency-tenant:3"] = "failed";

    const result = await svc.actOnQueueJob("delinquency-tenant", "3", "retry", actor);

    expect(retry).toHaveBeenCalled();
    expect(result.audited).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an unknown queue", async () => {
    await expect(svc.actOnQueueJob("nope", "1", "retry", actor)).rejects.toMatchObject({
      code: "UNKNOWN_QUEUE",
      statusCode: 404,
    });
  });

  it("refuses a job that is not there", async () => {
    await expect(
      svc.actOnQueueJob("billing-runs", "404", "retry", actor),
    ).rejects.toMatchObject({ code: "JOB_NOT_FOUND", statusCode: 404 });
  });
});
