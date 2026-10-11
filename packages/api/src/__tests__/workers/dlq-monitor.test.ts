import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit coverage for the DLQ monitor's connection lifecycle.
 *
 * Both behaviours here are about a connection BullMQ was handed rather
 * than one it created: `queueRedisConnection.duplicate()` copies options
 * but no listeners, and BullMQ treats a supplied connection as not-owned.
 * So the monitor is responsible for the error listener and for closing
 * the socket — neither of which it did before, and neither of which has
 * a visible symptom until Redis blips in production.
 */

const quit = vi.fn<() => Promise<string>>();
const disconnect = vi.fn();
const duplicate = vi.fn(() => ({ quit, disconnect }));

vi.mock("../../lib/queue-redis.js", () => ({
  queueRedisConnection: { duplicate },
}));

const warn = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/queues.js", () => ({
  getQueue: vi.fn(),
  getDlqQueue: vi.fn(),
  ALL_QUEUE_NAMES: ["suspension-transitions"],
}));

vi.mock("../../lib/telemetry.js", () => ({
  dlqDepthGauge: { add: vi.fn(), record: vi.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const instances: any[] = [];

vi.mock("bullmq", () => ({
  QueueEvents: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handlers = new Map<string, (...args: any[]) => unknown>();
    closed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(
      public name: string,
      public opts: any,
    ) {
      instances.push(this);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(event: string, fn: (...args: any[]) => unknown) {
      this.handlers.set(event, fn);
      return this;
    }
    async close() {
      this.closed = true;
    }
  },
}));

const { startDlqMonitor, stopDlqMonitor } = await import("../../workers/dlq-monitor.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const QUEUES = ["suspension-transitions"] as any;

describe("dlq-monitor connection lifecycle", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.clearAllMocks();
    quit.mockResolvedValue("OK");
  });

  it("handles connection errors instead of letting them go unhandled", async () => {
    await startDlqMonitor(QUEUES);
    try {
      const events = instances[0];
      const onError = events.handlers.get("error");

      // No listener here means an EventEmitter 'error' becomes an
      // uncaught exception and kills the process.
      expect(onError).toBeTypeOf("function");
      expect(() => onError(new Error("ECONNREFUSED"))).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: "dlq-monitor" }),
        expect.stringContaining("connection error"),
      );
    } finally {
      await stopDlqMonitor();
    }
  });

  it("closes the duplicated connection on shutdown, not just the events", async () => {
    await startDlqMonitor(QUEUES);
    expect(duplicate).toHaveBeenCalledTimes(1);

    await stopDlqMonitor();

    expect(instances[0].closed).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("falls back to disconnect when quit fails", async () => {
    quit.mockRejectedValue(new Error("already closed"));
    await startDlqMonitor(QUEUES);

    await stopDlqMonitor();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
