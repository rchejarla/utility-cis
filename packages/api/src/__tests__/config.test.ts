import { describe, it, expect } from "vitest";
import { configSchema, truthyString, parseWorkerQueues } from "../config.js";

/**
 * Tests for the pure parsing/validation primitives in config.ts.
 *
 * Notably, we do not test the side-effecting `loadConfig()` /
 * `process.exit(1)` path here — that runs once at module load and is
 * verified manually by booting the worker with bad env. Testing it
 * automatically would require module-isolation tricks (vi.resetModules,
 * mocking process.exit) that don't pay back the complexity. The real
 * value is in catching schema mistakes, and `configSchema` is testable
 * directly.
 */

describe("truthyString", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["1", true],
  ])("coerces %j to true", (input, expected) => {
    const result = truthyString.parse(input);
    expect(result).toBe(expected);
  });

  it.each([
    ["false", false],
    ["FALSE", false],
    ["0", false],
    ["", false],
    ["yes", false], // intentionally not accepted — keep the contract narrow
    ["no", false],
    ["random", false],
  ])("coerces %j to false", (input, expected) => {
    const result = truthyString.parse(input);
    expect(result).toBe(expected);
  });

  it("treats undefined as false", () => {
    expect(truthyString.parse(undefined)).toBe(false);
  });

  it("passes through actual booleans unchanged", () => {
    expect(truthyString.parse(true)).toBe(true);
    expect(truthyString.parse(false)).toBe(false);
  });
});

describe("configSchema", () => {
  /**
   * Build a minimum-viable input. `process.env` is `Record<string,
   * string | undefined>`, so we mirror that here — strings only, and
   * any field can be omitted.
   */
  function minValid(): Record<string, string | undefined> {
    return {
      DATABASE_URL: "postgres://localhost/test",
    };
  }

  it("accepts the minimal viable env and fills sensible defaults", () => {
    const result = configSchema.safeParse(minValid());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.NODE_ENV).toBe("development");
    expect(result.data.REDIS_URL).toBe("redis://localhost:6379");
    expect(result.data.LOG_LEVEL).toBe("info");
    expect(result.data.WORKER_HTTP_PORT).toBe(3002);
    expect(result.data.WORKER_QUEUES).toBe("all");
    expect(result.data.DISABLE_SCHEDULERS).toBe(false);
    expect(result.data.BULL_BOARD_ENABLED).toBe(false);
  });

  it("accepts missing DATABASE_URL with empty-string default", () => {
    // DATABASE_URL is permissive at config load — Prisma surfaces a
    // clear runtime error at first query if it's empty/wrong. Strict
    // boot-time validation crashed test environments that mock Prisma.
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.DATABASE_URL).toBe("");
  });

  it("accepts empty DATABASE_URL", () => {
    const result = configSchema.safeParse({ DATABASE_URL: "" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.DATABASE_URL).toBe("");
  });

  it("preserves a real DATABASE_URL when provided", () => {
    const result = configSchema.safeParse({ DATABASE_URL: "postgres://x:y@host:5432/db" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.DATABASE_URL).toBe("postgres://x:y@host:5432/db");
  });

  it("rejects invalid NODE_ENV", () => {
    const result = configSchema.safeParse({ ...minValid(), NODE_ENV: "staging" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "NODE_ENV")).toBe(true);
  });

  it("rejects invalid LOG_LEVEL", () => {
    const result = configSchema.safeParse({ ...minValid(), LOG_LEVEL: "verbose" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path[0] === "LOG_LEVEL")).toBe(true);
  });

  it("rejects WORKER_HTTP_PORT out of range", () => {
    const tooHigh = configSchema.safeParse({ ...minValid(), WORKER_HTTP_PORT: "99999" });
    expect(tooHigh.success).toBe(false);

    const tooLow = configSchema.safeParse({ ...minValid(), WORKER_HTTP_PORT: "0" });
    expect(tooLow.success).toBe(false);
  });

  it("coerces WORKER_HTTP_PORT from string", () => {
    const result = configSchema.safeParse({ ...minValid(), WORKER_HTTP_PORT: "3050" });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.WORKER_HTTP_PORT).toBe(3050);
  });

  it("propagates truthyString coercion to bool-style env flags", () => {
    const result = configSchema.safeParse({
      ...minValid(),
      DISABLE_SCHEDULERS: "true",
      BULL_BOARD_ENABLED: "TRUE",
      ENABLE_DEV_AUTH_ENDPOINTS: "1",
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.DISABLE_SCHEDULERS).toBe(true);
    expect(result.data.BULL_BOARD_ENABLED).toBe(true);
    expect(result.data.ENABLE_DEV_AUTH_ENDPOINTS).toBe(true);
  });
});

describe("parseWorkerQueues", () => {
  it("returns null for the 'all' sentinel", () => {
    expect(parseWorkerQueues("all")).toBeNull();
  });

  it("returns null for case variants of 'all'", () => {
    expect(parseWorkerQueues("ALL")).toBeNull();
    expect(parseWorkerQueues("All")).toBeNull();
  });

  it("returns null for empty / whitespace input", () => {
    expect(parseWorkerQueues("")).toBeNull();
    expect(parseWorkerQueues("   ")).toBeNull();
  });

  it("returns single-element array for one queue", () => {
    expect(parseWorkerQueues("delinquency-tenant")).toEqual(["delinquency-tenant"]);
  });

  it("splits comma-separated queues", () => {
    expect(parseWorkerQueues("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("trims whitespace around each queue name", () => {
    expect(parseWorkerQueues("a, b ,  c")).toEqual(["a", "b", "c"]);
  });

  it("filters empty entries from doubled commas", () => {
    expect(parseWorkerQueues("a,,b")).toEqual(["a", "b"]);
    expect(parseWorkerQueues(",a,b,")).toEqual(["a", "b"]);
  });

  it("returns null when only commas / whitespace are provided", () => {
    expect(parseWorkerQueues(",,,")).toBeNull();
    expect(parseWorkerQueues(" , , ")).toBeNull();
  });

  it("preserves queue names with hyphens", () => {
    expect(parseWorkerQueues("suspension-transitions,notification-send")).toEqual([
      "suspension-transitions",
      "notification-send",
    ]);
  });
});
