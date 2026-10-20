import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";

/**
 * The worker's own HTTP server, and the shutdown it can be asked for.
 *
 * Why a route and not a signal: Windows has no POSIX signals. Node
 * emulates `process.kill(pid, "SIGTERM")` there as an unconditional
 * termination — verified against a running worker, whose "Shutdown
 * initiated" line never appeared — so the 60s drain, the DLQ monitor
 * teardown and the Redis quit are all skipped, and an in-flight job
 * loses its lock mid-run.
 *
 * The worker already runs this server for Kubernetes probes, so asking
 * it to stop over the same channel costs one route and behaves
 * identically on Windows and Linux. `docker stop` and a k8s pod eviction
 * still arrive as SIGTERM, and that handler stays exactly as it was.
 *
 * It is a shutdown endpoint on a port that binds every interface, so it
 * takes a loopback-only guard: the console that uses it runs on the same
 * host by construction, and a stop is refused across hosts anyway.
 */

vi.mock("../../lib/queue-redis.js", () => ({
  queueRedisConnection: { ping: vi.fn(async () => "PONG") },
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let lib: typeof import("../../lib/health-server.js");
let server: Server | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await import("../../lib/health-server.js");
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** Starts on an ephemeral port and returns it. */
async function listen(opts: Parameters<typeof lib.startHealthServer>[1] = {}): Promise<number> {
  server = lib.startHealthServer(0, opts);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

describe("isLoopbackAddress", () => {
  it("accepts the addresses a request from this host arrives with", () => {
    // IPv4, IPv6, and the IPv4-mapped form Node reports on a dual-stack
    // listener — which is what a localhost fetch actually looks like here.
    expect(lib.isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(lib.isLoopbackAddress("::1")).toBe(true);
    expect(lib.isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects anything else, including an address it cannot read", () => {
    expect(lib.isLoopbackAddress("10.0.0.5")).toBe(false);
    expect(lib.isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(lib.isLoopbackAddress(undefined)).toBe(false);
    // Not a prefix match: this is a routable address that merely starts
    // with the same characters.
    expect(lib.isLoopbackAddress("127.0.0.1.example.com")).toBe(false);
  });
});

describe("the shutdown route", () => {
  it("runs the handler the worker registered and answers before draining", async () => {
    // 202, not 200: the drain can take up to a minute, and the caller
    // must not hold a request open for it.
    const onShutdown = vi.fn();
    const port = await listen({ onShutdown });

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });

    expect(res.status).toBe(202);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("is not there at all when no handler was registered", async () => {
    // The API process runs no health server, but nothing should be able
    // to ask a process to stop that has not said how.
    const port = await listen();

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });

    expect(res.status).toBe(404);
  });

  it("refuses a GET, so a browser or a probe cannot stop the worker", async () => {
    const onShutdown = vi.fn();
    const port = await listen({ onShutdown });

    const res = await fetch(`http://127.0.0.1:${port}/shutdown`);

    expect(res.status).toBe(405);
    expect(onShutdown).not.toHaveBeenCalled();
  });
});

describe("the probes", () => {
  it("still answers liveness", async () => {
    const port = await listen({ onShutdown: vi.fn() });

    const res = await fetch(`http://127.0.0.1:${port}/health/live`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "alive" });
  });

  it("still refuses a POST to a probe", async () => {
    // Allowing POST for /shutdown must not open it everywhere.
    const port = await listen({ onShutdown: vi.fn() });

    const res = await fetch(`http://127.0.0.1:${port}/health/live`, { method: "POST" });

    expect(res.status).toBe(405);
  });
});
