import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Starting and stopping the worker, from the console that can see it.
 *
 * The worker is a separate Node process. `start_dev.bat` says so and
 * does not start it, so the ordinary state of a dev stack is eight
 * queues filling up with nothing attached — which the counts cannot
 * distinguish from healthy. This closes that by spawning it.
 *
 * Three facts, all verified against the running stack rather than
 * assumed, because each one decides a piece of the design:
 *
 *   - `node --import tsx --env-file=.env src/worker.ts` starts the
 *     worker as **one** process. Going through `pnpm` or `npx` instead
 *     builds a wrapper tree whose top pid is not the worker: killing it
 *     leaves the worker running, which happened to me earlier in this
 *     session and left an orphan attached to Redis.
 *
 *   - The pid is recorded in Redis, not in a module variable, because
 *     `tsx watch` restarts the API on every file save. An in-memory
 *     handle is lost several times an hour, and then Stop cannot work
 *     while the page still reports a worker it can no longer reach.
 *
 *   - On Windows `process.kill(pid, "SIGTERM")` terminates immediately;
 *     the worker's own drain handler never runs. Verified by watching
 *     for the "Shutdown initiated" line that never arrived. Which is why
 *     a stop is **asked for over the worker's own HTTP server** rather
 *     than signalled: that is the same path on Windows and Linux, and it
 *     reaches the drain this process already had. The signal remains as
 *     the fallback for a worker whose HTTP server cannot be reached,
 *     where an abrupt stop beats no stop.
 */

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));

const store = new Map<string, string>();

vi.mock("../../lib/cache-redis.js", () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    status: "ready",
  },
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let controlAllowed = true;

vi.mock("../../config.js", () => ({
  config: { NODE_ENV: "development", WORKER_CONTROL_ENABLED: false, WORKER_HTTP_PORT: 3002 },
  workerControlAllowed: () => controlAllowed,
}));

/** The worker's HTTP server, as the drain request reaches it. */
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const OPERATOR = "00000000-0000-4000-8000-aaaa0000e001";
const actor = { id: OPERATOR, name: "Pat Operator", source: `platform:${OPERATOR}` };

let svc: typeof import("../../services/worker-process.service.js");
/** Pids this host will claim are alive. */
let alive: Set<number>;

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  controlAllowed = true;
  alive = new Set<number>();

  spawn.mockReturnValue({ pid: 4242, unref: vi.fn() });
  fetchMock.mockResolvedValue({ ok: true, status: 202 });
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (!alive.has(pid)) {
      const err = new Error("no such process") as Error & { code: string };
      err.code = "ESRCH";
      throw err;
    }
    return true;
  }) as never);

  svc = await import("../../services/worker-process.service.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startWorkerProcess", () => {
  it("starts the worker as a single process and records what it started", async () => {
    const status = await svc.startWorkerProcess([], actor);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    // Node directly, so the pid recorded is the worker's own.
    expect(command).toBe(process.execPath);
    expect(args.join(" ")).toMatch(/worker\.(ts|js)$/);

    expect(status).toMatchObject({ running: true, pid: 4242 });
    expect(status.startedAt).toBeTruthy();
  });

  it("serves every queue when none is named", async () => {
    await svc.startWorkerProcess([], actor);

    const opts = spawn.mock.calls[0][2];
    expect(opts.env.WORKER_QUEUES).toBe("all");
  });

  it("passes a named subset through the environment, never the command line", async () => {
    // Nothing an operator sends becomes part of an argv, and there is no
    // shell: the command is fixed and the selection travels as a value.
    const status = await svc.startWorkerProcess(["imports", "billing-runs"], actor);

    const opts = spawn.mock.calls[0][2];
    expect(opts.env.WORKER_QUEUES).toBe("imports,billing-runs");
    expect(opts.shell).not.toBe(true);
    expect(status.queues).toEqual(["imports", "billing-runs"]);
  });

  it("sends its output to a file, so a worker that dies at boot can be read", async () => {
    /*
     * This discarded stdio first. A worker that fails during boot — a
     * bad DATABASE_URL, a stale generated Prisma client — then leaves no
     * trace anywhere, and the console that started it can only report
     * that it is no longer running. Inheriting is not the answer either:
     * the worker outlives the API process on purpose.
     */
    const status = await svc.startWorkerProcess([], actor);

    const opts = spawn.mock.calls[0][2];
    expect(opts.stdio[0]).toBe("ignore");
    // Both streams to the same descriptor, so interleaving is preserved.
    expect(typeof opts.stdio[1]).toBe("number");
    expect(opts.stdio[2]).toBe(opts.stdio[1]);
    expect(status.logFile).toMatch(/worker\.log$/);
  });

  it("refuses a queue name that is not in the registry", async () => {
    await expect(svc.startWorkerProcess(["imports; rm -rf /"], actor)).rejects.toMatchObject({
      code: "UNKNOWN_QUEUE",
      statusCode: 400,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses to start a second worker while the one it started is alive", async () => {
    alive.add(4242);
    await svc.startWorkerProcess([], actor);

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "ALREADY_RUNNING",
      statusCode: 409,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("starts again once the recorded worker has died", async () => {
    // The record outlives the process — it is in Redis so that Stop
    // survives an API restart — so liveness is checked, never assumed.
    await svc.startWorkerProcess([], actor);
    spawn.mockReturnValue({ pid: 5151, unref: vi.fn() });

    const status = await svc.startWorkerProcess([], actor);

    expect(status.pid).toBe(5151);
  });

  it("refuses when worker control is not enabled on this host", async () => {
    controlAllowed = false;

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "WORKER_CONTROL_DISABLED",
      statusCode: 403,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports the spawn failing rather than recording a worker that is not there", async () => {
    spawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    });
    expect(await svc.getWorkerProcessStatus()).toMatchObject({ running: false, pid: null });
  });
});

describe("stopWorkerProcess", () => {
  it("asks the worker to drain over its own HTTP server, not with a signal", async () => {
    /*
     * The whole point: this is the one stop path that works the same on
     * Windows and Linux. A signal would be an unconditional termination
     * on Windows, skipping the 60s drain the worker already implements.
     */
    alive.add(4242);
    await svc.startWorkerProcess([], actor);

    const status = await svc.stopWorkerProcess(actor);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3002/shutdown");
    expect(init).toMatchObject({ method: "POST" });
    expect(process.kill).not.toHaveBeenCalledWith(4242, "SIGTERM");
    expect(status.method).toBe("drain");
  });

  it("reports the stop as in progress while the worker is still draining", async () => {
    // The drain can take up to a minute. Reporting "stopped" while it
    // runs would have the page contradict the process list.
    alive.add(4242);
    await svc.startWorkerProcess([], actor);

    const status = await svc.stopWorkerProcess(actor);

    expect(status).toMatchObject({ running: true, stopping: true, pid: 4242 });
    // The record stays, so the next status read is the thing that
    // notices it has gone.
    expect(store.get("platform:worker-process")).toBeTruthy();
  });

  it("forgets the worker once the drain has finished", async () => {
    alive.add(4242);
    await svc.startWorkerProcess([], actor);
    await svc.stopWorkerProcess(actor);

    alive.delete(4242);
    const status = await svc.getWorkerProcessStatus();

    expect(status).toMatchObject({ running: false, stopping: false, pid: null });
    expect(store.get("platform:worker-process")).toBeUndefined();
  });

  it("falls back to a signal when the worker's HTTP server cannot be reached", async () => {
    // A wedged worker that no longer answers still has to be stoppable;
    // an abrupt stop beats none. The caller is told which it got.
    alive.add(4242);
    await svc.startWorkerProcess([], actor);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const status = await svc.stopWorkerProcess(actor);

    expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(status.method).toBe("signal");
  });

  it("falls back when the worker answers the drain request with a refusal", async () => {
    alive.add(4242);
    await svc.startWorkerProcess([], actor);
    fetchMock.mockResolvedValue({ ok: false, status: 404 });

    const status = await svc.stopWorkerProcess(actor);

    expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(status.method).toBe("signal");
  });

  it("asks the port the worker was actually started on", async () => {
    // Recorded at spawn, so changing WORKER_HTTP_PORT afterwards cannot
    // leave a running worker unreachable.
    alive.add(4242);
    await svc.startWorkerProcess([], actor);
    const record = JSON.parse(store.get("platform:worker-process") as string);
    expect(record.healthPort).toBe(3002);

    store.set(
      "platform:worker-process",
      JSON.stringify({ ...record, healthPort: 3999 }),
    );
    await svc.stopWorkerProcess(actor);

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3999/shutdown");
  });

  it("refuses to stop a worker it did not start", async () => {
    // A worker started from a terminal is attached to the same Redis and
    // is visible in the queue counts, but its pid is not ours to signal.
    await expect(svc.stopWorkerProcess(actor)).rejects.toMatchObject({
      code: "NOT_STARTED_HERE",
      statusCode: 409,
    });
  });

  it("refuses to signal a pid recorded by another host", async () => {
    // One Redis, several API replicas: `process.kill` would signal
    // whatever happens to hold that pid on *this* machine, which is a
    // different process entirely.
    alive.add(4242);
    await svc.startWorkerProcess([], actor);
    const record = JSON.parse(store.get("platform:worker-process") as string);
    store.set(
      "platform:worker-process",
      JSON.stringify({ ...record, host: "some-other-host" }),
    );

    await expect(svc.stopWorkerProcess(actor)).rejects.toMatchObject({
      code: "OTHER_HOST",
      statusCode: 409,
    });
    expect(process.kill).not.toHaveBeenCalledWith(4242, "SIGTERM");
  });

  it("clears a record whose process has already gone", async () => {
    await svc.startWorkerProcess([], actor);

    const status = await svc.stopWorkerProcess(actor);

    expect(status.running).toBe(false);
    expect(store.get("platform:worker-process")).toBeUndefined();
    // Nothing to ask and nothing to signal: it is already gone.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("signalDrains", () => {
  // Only the fallback path is platform-dependent now, and this is what
  // lets the page say whether the stop it just performed drained.
  it("is false on Windows, where a signal cannot be handled", () => {
    // Verified against a running worker: the process vanished and its
    // "Shutdown initiated" line never appeared.
    expect(svc.signalDrains("win32")).toBe(false);
  });

  it("is true where SIGTERM reaches the worker's own handler", () => {
    expect(svc.signalDrains("linux")).toBe(true);
    expect(svc.signalDrains("darwin")).toBe(true);
  });
});

describe("getWorkerProcessStatus", () => {
  it("says nothing is running before anything is started", async () => {
    expect(await svc.getWorkerProcessStatus()).toMatchObject({
      running: false,
      pid: null,
      controllable: true,
    });
  });

  it("says so when this host may not control a worker", async () => {
    controlAllowed = false;

    expect(await svc.getWorkerProcessStatus()).toMatchObject({ controllable: false });
  });
});
