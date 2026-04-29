import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the BullMQ Queue class so unit tests don't need Redis. We
// capture every constructor + add call so we can assert what the
// helper layer is doing.
const queueAdd = vi.fn();
const queueClose = vi.fn().mockResolvedValue(undefined);
const queueCtorSpy = vi.fn();

vi.mock("bullmq", () => {
  return {
    Queue: vi.fn().mockImplementation((name: string, opts: Record<string, unknown>) => {
      queueCtorSpy(name, opts);
      return {
        name,
        opts,
        add: queueAdd,
        close: queueClose,
      };
    }),
  };
});

// Stub the queue-redis connection — we never connect during these
// tests; the Queue mock above ignores the connection object anyway.
vi.mock("../../lib/queue-redis.js", () => ({
  queueRedisConnection: { kind: "fake-redis" },
}));

import {
  QUEUE_NAMES,
  ALL_QUEUE_NAMES,
  QUEUE_DEFAULTS,
  getQueue,
  getDlqQueue,
  dlqNameFor,
  enqueueSafely,
  closeAllQueues,
} from "../../lib/queues.js";

beforeEach(async () => {
  // Drain the factory cache from any prior test BEFORE resetting
  // mock counters — otherwise queueClose's history starts non-zero.
  await closeAllQueues();
  queueAdd.mockReset();
  queueClose.mockReset().mockResolvedValue(undefined);
  queueCtorSpy.mockReset();
});

describe("QUEUE_NAMES + ALL_QUEUE_NAMES", () => {
  it("exposes the seven expected queue names", () => {
    expect(QUEUE_NAMES).toEqual({
      suspensionTransitions: "suspension-transitions",
      notificationSend: "notification-send",
      slaBreachSweep: "sla-breach-sweep",
      delinquencyDispatch: "delinquency-dispatch",
      delinquencyTenant: "delinquency-tenant",
      auditRetention: "audit-retention",
      imports: "imports",
    });
  });

  it("ALL_QUEUE_NAMES is the value list of QUEUE_NAMES", () => {
    expect(new Set(ALL_QUEUE_NAMES)).toEqual(new Set(Object.values(QUEUE_NAMES)));
    expect(ALL_QUEUE_NAMES).toHaveLength(7);
  });
});

describe("QUEUE_DEFAULTS", () => {
  it("has a defaults entry for every queue", () => {
    for (const name of ALL_QUEUE_NAMES) {
      expect(QUEUE_DEFAULTS[name]).toBeDefined();
      expect(QUEUE_DEFAULTS[name].concurrency).toBeGreaterThan(0);
      expect(QUEUE_DEFAULTS[name].defaultJobOptions.attempts).toBeGreaterThan(0);
    }
  });

  it("delinquency-tenant=5, imports=4, others=1", () => {
    expect(QUEUE_DEFAULTS["delinquency-tenant"].concurrency).toBe(5);
    expect(QUEUE_DEFAULTS.imports.concurrency).toBe(4);
    for (const name of ALL_QUEUE_NAMES) {
      if (name === "delinquency-tenant" || name === "imports") continue;
      expect(QUEUE_DEFAULTS[name].concurrency).toBe(1);
    }
  });

  it("each queue's defaultJobOptions includes age-based retention", () => {
    for (const name of ALL_QUEUE_NAMES) {
      const opts = QUEUE_DEFAULTS[name].defaultJobOptions;
      expect(opts.removeOnComplete).toMatchObject({ age: expect.any(Number) });
      expect(opts.removeOnFail).toMatchObject({ age: expect.any(Number) });
    }
  });

  it("suspension uses exponential backoff at 30s base; notification at 5s base", () => {
    expect(QUEUE_DEFAULTS["suspension-transitions"].defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 30_000,
    });
    expect(QUEUE_DEFAULTS["notification-send"].defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 5_000,
    });
  });

  it("delinquency-dispatch uses fixed 60s backoff (cron, low retry)", () => {
    expect(QUEUE_DEFAULTS["delinquency-dispatch"].defaultJobOptions).toMatchObject({
      attempts: 2,
      backoff: { type: "fixed", delay: 60_000 },
    });
  });
});

describe("dlqNameFor", () => {
  it("prefixes the queue name with 'dlq-'", () => {
    expect(dlqNameFor("suspension-transitions")).toBe("dlq-suspension-transitions");
    expect(dlqNameFor("notification-send")).toBe("dlq-notification-send");
    expect(dlqNameFor("sla-breach-sweep")).toBe("dlq-sla-breach-sweep");
    expect(dlqNameFor("delinquency-dispatch")).toBe("dlq-delinquency-dispatch");
    expect(dlqNameFor("delinquency-tenant")).toBe("dlq-delinquency-tenant");
    expect(dlqNameFor("audit-retention")).toBe("dlq-audit-retention");
  });
});

describe("getQueue", () => {
  it("constructs a Queue with the expected defaults on first call", () => {
    const q = getQueue("suspension-transitions");
    expect(q.name).toBe("suspension-transitions");
    expect(queueCtorSpy).toHaveBeenCalledTimes(1);
    const [name, opts] = queueCtorSpy.mock.calls[0];
    expect(name).toBe("suspension-transitions");
    expect(opts.connection).toEqual({ kind: "fake-redis" });
    expect(opts.defaultJobOptions.attempts).toBe(3);
    expect(opts.defaultJobOptions.backoff).toEqual({
      type: "exponential",
      delay: 30_000,
    });
  });

  it("memoizes — repeated calls for the same queue return the same instance", () => {
    const q1 = getQueue("notification-send");
    const q2 = getQueue("notification-send");
    expect(q1).toBe(q2);
    expect(queueCtorSpy).toHaveBeenCalledTimes(1);
  });

  it("constructs distinct instances per queue name", () => {
    const a = getQueue("suspension-transitions");
    const b = getQueue("notification-send");
    expect(a).not.toBe(b);
    expect(queueCtorSpy).toHaveBeenCalledTimes(2);
  });
});

describe("getDlqQueue", () => {
  it("creates a queue named dlq-<sourceName>", () => {
    const dlq = getDlqQueue("delinquency-tenant");
    expect(dlq.name).toBe("dlq-delinquency-tenant");
  });

  it("uses no-retry defaults — DLQ jobs are awaiting manual replay", () => {
    getDlqQueue("suspension-transitions");
    const lastCall = queueCtorSpy.mock.calls[queueCtorSpy.mock.calls.length - 1];
    const opts = lastCall[1];
    expect(opts.defaultJobOptions.attempts).toBe(1);
    // Retention still applies — DLQ shouldn't grow unbounded either.
    expect(opts.defaultJobOptions.removeOnComplete).toBeDefined();
    expect(opts.defaultJobOptions.removeOnFail).toBeDefined();
  });

  it("memoizes — repeated calls for the same source queue return the same DLQ instance", () => {
    const a = getDlqQueue("suspension-transitions");
    const b = getDlqQueue("suspension-transitions");
    expect(a).toBe(b);
  });
});

describe("enqueueSafely", () => {
  it("returns the new job id on success", async () => {
    queueAdd.mockResolvedValueOnce({ id: "job-123" });
    const id = await enqueueSafely("suspension-transitions", "transition-suspensions", {});
    expect(id).toBe("job-123");
    expect(queueAdd).toHaveBeenCalledWith("transition-suspensions", {}, undefined);
  });

  it("forwards JobsOptions when supplied (e.g., deterministic jobId for idempotency)", async () => {
    queueAdd.mockResolvedValueOnce({ id: "job-456" });
    const opts = { jobId: "delinquency:tenant-a:2026042503", priority: 1 };
    await enqueueSafely(
      "delinquency-tenant",
      "evaluate",
      { utilityId: "tenant-a" },
      opts,
    );
    expect(queueAdd).toHaveBeenCalledWith("evaluate", { utilityId: "tenant-a" }, opts);
  });

  it("returns null when Redis enqueue throws — does not propagate", async () => {
    queueAdd.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:6379"));
    const id = await enqueueSafely("suspension-transitions", "transition-suspensions", {});
    expect(id).toBeNull();
  });

  it("returns null when the new job has no id (defensive)", async () => {
    queueAdd.mockResolvedValueOnce({ id: undefined });
    const id = await enqueueSafely("suspension-transitions", "transition-suspensions", {});
    expect(id).toBeNull();
  });
});

describe("closeAllQueues", () => {
  it("closes every cached queue and DLQ instance", async () => {
    getQueue("suspension-transitions");
    getQueue("notification-send");
    getDlqQueue("suspension-transitions");

    await closeAllQueues();

    expect(queueClose).toHaveBeenCalledTimes(3);
  });

  it("clears the cache so the next getQueue call constructs fresh instances", async () => {
    getQueue("suspension-transitions");
    expect(queueCtorSpy).toHaveBeenCalledTimes(1);

    await closeAllQueues();

    getQueue("suspension-transitions");
    expect(queueCtorSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores per-queue close errors so one bad queue doesn't block the rest", async () => {
    getQueue("suspension-transitions");
    getQueue("notification-send");
    queueClose
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("redis is on fire"));

    await expect(closeAllQueues()).resolves.toBeUndefined();
    expect(queueClose).toHaveBeenCalledTimes(2);
  });
});
