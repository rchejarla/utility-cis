import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Stopping a queue taking work, and saying who stopped it.
 *
 * A pause is a key in Redis that every worker on every node already
 * honours before taking a job — not a message to a process — which is
 * why this needs no part of spec 24's command path.
 *
 * The record beside it is the point of `SCH-PAUSE-5`: a queue found
 * paused on a Monday with no record of why is worse than one nobody
 * could pause. It cannot be an `audit_log` row, which wants a
 * `utility_id` and a uuid `entity_id` — a queue is neither.
 *
 * `docs/specs/27-job-scheduling.md` §2.
 */

const paused = new Set<string>();
const stored: Record<string, string> = {};

const pause = vi.fn(async (name: string) => void paused.add(name));
const resume = vi.fn(async (name: string) => void paused.delete(name));

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "imports"],
  QUEUE_DEFAULTS: {
    "billing-runs": { concurrency: 1, defaultJobOptions: {} },
    imports: { concurrency: 4, defaultJobOptions: {} },
  },
  getQueue: vi.fn((name: string) => ({
    pause: vi.fn(() => pause(name)),
    resume: vi.fn(() => resume(name)),
  })),
}));

vi.mock("../../lib/queue-redis.js", () => ({
  queueRedisConnection: {
    hget: vi.fn(async (_key: string, field: string) => stored[field] ?? null),
    hset: vi.fn(async (_key: string, field: string, value: string) => {
      stored[field] = value;
      return 1;
    }),
    hdel: vi.fn(async (_key: string, field: string) => {
      delete stored[field];
      return 1;
    }),
  },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let lib: typeof import("../../lib/queue-pause.js");

const ACTOR = { id: "op-1", name: "Ops" };

beforeEach(async () => {
  vi.clearAllMocks();
  paused.clear();
  for (const key of Object.keys(stored)) delete stored[key];
  lib = await import("../../lib/queue-pause.js");
});

describe("pausing a queue", () => {
  it("pauses it in Redis, where every node already looks", async () => {
    await lib.pauseQueue("imports", ACTOR, "vendor API is down");

    expect(pause).toHaveBeenCalledWith("imports");
  });

  it("records who paused it, when, and why", async () => {
    await lib.pauseQueue("imports", ACTOR, "vendor API is down");

    const record = await lib.readPauseRecord("imports");
    expect(record).toMatchObject({ by: "Ops", reason: "vendor API is down" });
    expect(Date.parse(record!.at)).not.toBeNaN();
  });

  it("refuses a pause with no reason given", async () => {
    // The reason is the whole value of the record. A blank one leaves
    // exactly the state this exists to prevent.
    await expect(lib.pauseQueue("imports", ACTOR, "   ")).rejects.toMatchObject({
      code: "PAUSE_REASON_REQUIRED",
    });
    expect(pause).not.toHaveBeenCalled();
  });

  it("keeps the first reason when a paused queue is paused again", async () => {
    // The operator who stopped it is the one worth naming; a second
    // press would otherwise rewrite the record with a later timestamp
    // and lose why it was stopped in the first place.
    await lib.pauseQueue("imports", ACTOR, "vendor API is down");
    await lib.pauseQueue("imports", { id: "op-2", name: "Someone else" }, "checking");

    expect(await lib.readPauseRecord("imports")).toMatchObject({
      by: "Ops",
      reason: "vendor API is down",
    });
  });
});

describe("resuming a queue", () => {
  it("resumes it and clears the record", async () => {
    await lib.pauseQueue("imports", ACTOR, "vendor API is down");

    await lib.resumeQueue("imports", ACTOR);

    expect(resume).toHaveBeenCalledWith("imports");
    expect(await lib.readPauseRecord("imports")).toBeNull();
  });

  it("resumes a queue that has no record, rather than refusing", async () => {
    // A queue paused before this record existed, or paused straight in
    // Redis. Refusing to resume it would make the record a lock on the
    // one action an operator needs during an incident.
    paused.add("imports");

    await lib.resumeQueue("imports", ACTOR);

    expect(resume).toHaveBeenCalledWith("imports");
  });
});

describe("reading the record", () => {
  it("is null for a queue nobody paused", async () => {
    expect(await lib.readPauseRecord("billing-runs")).toBeNull();
  });

  it("is null rather than a throw when the stored value is unreadable", async () => {
    // Hand-edited, or written by an older shape. The queue is still
    // paused and the page must still render — the record is the detail,
    // not the fact.
    stored["billing-runs"] = "{not json";

    expect(await lib.readPauseRecord("billing-runs")).toBeNull();
  });
});
