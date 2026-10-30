import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The two limits on how much of a queue runs at once.
 *
 * They bound different resources and neither can be computed from the
 * other: **per node** bounds one process — its heap, its CPU, its own
 * `pg.Pool` — and the **cluster limit** bounds the shared resource, the
 * total concurrent load on one database. What actually runs is the
 * smaller of the cluster limit and `attached workers × per node`.
 *
 * The arithmetic is the whole point of testing this at all, because the
 * trap is silent in both directions. A cluster limit of 4 with per node
 * 1 on three nodes runs 3, not 4 — the number reads as a limit and
 * limits nothing. And a cluster limit set *below* capacity throttles a
 * queue that otherwise looks merely slow.
 *
 * `docs/specs/27-job-scheduling.md` §6.
 */

const globalConcurrency: Record<string, number | null> = {};
const stored: Record<string, string> = {};

const setGlobalConcurrency = vi.fn(async (name: string, n: number) => {
  globalConcurrency[name] = n;
});
const removeGlobalConcurrency = vi.fn(async (name: string) => {
  globalConcurrency[name] = null;
});

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["billing-runs", "imports"],
  QUEUE_DEFAULTS: {
    "billing-runs": { concurrency: 1, defaultJobOptions: {} },
    imports: { concurrency: 4, defaultJobOptions: {} },
  },
  getQueue: vi.fn((name: string) => ({
    getGlobalConcurrency: vi.fn(async () => globalConcurrency[name] ?? null),
    setGlobalConcurrency: vi.fn((n: number) => setGlobalConcurrency(name, n)),
    removeGlobalConcurrency: vi.fn(() => removeGlobalConcurrency(name)),
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

let lib: typeof import("../../lib/queue-limits.js");

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(globalConcurrency)) delete globalConcurrency[key];
  for (const key of Object.keys(stored)) delete stored[key];
  lib = await import("../../lib/queue-limits.js");
});

describe("reading a queue's limits", () => {
  it("falls back to the code default when an operator has set nothing", async () => {
    const limits = await lib.readQueueLimits("imports");

    // `QUEUE_DEFAULTS` stays the fallback: a queue nobody has configured
    // behaves exactly as it did before this setting existed.
    expect(limits.perNode).toBe(4);
    expect(limits.cluster).toBeNull();
  });

  it("reads a stored per-node limit over the default", async () => {
    await lib.setPerNodeLimit("billing-runs", 2);

    expect((await lib.readQueueLimits("billing-runs")).perNode).toBe(2);
  });

  it("treats an unset cluster limit as no limit rather than as zero", async () => {
    await lib.setClusterLimit("imports", 8);
    expect((await lib.readQueueLimits("imports")).cluster).toBe(8);

    await lib.setClusterLimit("imports", null);

    // Null and 0 must not collapse: 0 would stop the queue dead, which is
    // what pause is for, and is the opposite of "no ceiling".
    expect((await lib.readQueueLimits("imports")).cluster).toBeNull();
    expect(removeGlobalConcurrency).toHaveBeenCalledWith("imports");
  });

  it("clears a per-node limit back to the default rather than storing a zero", async () => {
    await lib.setPerNodeLimit("imports", 2);

    await lib.setPerNodeLimit("imports", null);

    expect((await lib.readQueueLimits("imports")).perNode).toBe(4);
  });

  it("refuses a limit below one, which BullMQ would reject at the worker", async () => {
    await expect(lib.setPerNodeLimit("imports", 0)).rejects.toMatchObject({
      code: "INVALID_CONCURRENCY",
    });
    await expect(lib.setClusterLimit("imports", 0)).rejects.toMatchObject({
      code: "INVALID_CONCURRENCY",
    });
  });
});

describe("what actually runs", () => {
  it("tops out at the fleet's capacity when the cluster limit is above it", () => {
    // Three nodes willing to hold one each cannot reach four, so the
    // cluster limit is not binding — it binds the day a fourth node joins.
    expect(lib.effectiveLimit({ perNode: 1, cluster: 4 }, 3)).toBe(3);
  });

  it("reaches the cluster limit exactly once the nodes will hold it", () => {
    // Same 4, same three nodes, per node raised to 2: capacity is 6, so
    // the cluster limit is what binds. 4 need not divide by 3.
    expect(lib.effectiveLimit({ perNode: 2, cluster: 4 }, 3)).toBe(4);
  });

  it("is the fleet's capacity when no cluster limit is set", () => {
    expect(lib.effectiveLimit({ perNode: 2, cluster: null }, 3)).toBe(6);
  });

  it("is nothing at all when no worker is attached", () => {
    // Not "unknown": zero workers is the ordinary state of a dev stack,
    // and it means nothing in the queue will run.
    expect(lib.effectiveLimit({ perNode: 2, cluster: 4 }, 0)).toBe(0);
  });

  it("is unknown when the worker count is unknown", () => {
    // A managed Redis that refuses CLIENT LIST costs us the worker count,
    // and a cap presented as a number would be a fabrication.
    expect(lib.effectiveLimit({ perNode: 2, cluster: 4 }, null)).toBeNull();
  });
});

describe("applying a per-node limit to a running worker", () => {
  it("sets each worker's concurrency from the store", async () => {
    await lib.setPerNodeLimit("billing-runs", 3);
    const worker = { name: "billing-runs", concurrency: 1 };

    await lib.applyPerNodeLimits([worker]);

    expect(worker.concurrency).toBe(3);
  });

  it("leaves a worker alone when the stored limit is already its own", async () => {
    // The setter is a plain assignment, so this costs nothing either way —
    // but a log line per worker per boot saying it changed nothing is the
    // kind of noise that makes a real change invisible.
    const worker = { name: "imports", concurrency: 4 };

    await lib.applyPerNodeLimits([worker]);

    expect(worker.concurrency).toBe(4);
  });

  it("ignores a worker on a queue it does not know", async () => {
    const worker = { name: "dlq-imports", concurrency: 1 };

    await lib.applyPerNodeLimits([worker]);

    expect(worker.concurrency).toBe(1);
  });
});
