import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Starting and stopping workers, as a registry rather than a single slot.
 *
 * The shipped version kept one record under one Redis key, which had an
 * accident in it: a second API node's start was refused because the
 * *first* node's record existed, so a cluster could only ever have one
 * console-started worker anywhere. Keyed by worker id now, with the node
 * on the record, so each node manages its own.
 *
 * Still at most one per node, and that is a constraint rather than a
 * policy: `startHealthServer` binds `WORKER_HTTP_PORT` with no error
 * handler, so a second worker on the same host exits 1 on EADDRINUSE —
 * verified. Refusing it with a sentence beats spawning a process that
 * dies a moment later.
 *
 * Three facts behind the rest of the design, each measured against the
 * running stack:
 *
 *   - `node --import tsx --env-file=.env src/worker.ts` starts the worker
 *     as **one** process, so the recorded pid is the worker's. Going via
 *     `pnpm` or `npx` wraps it in a tree whose top pid is not the worker,
 *     and killing that leaves an orphan attached to Redis.
 *
 *   - The record lives in Redis because `tsx watch` restarts the API on
 *     every file save; an in-memory handle is lost several times an hour,
 *     after which Stop cannot work while the page still claims a worker.
 *
 *   - A stop is **asked for over the worker's own HTTP server**, not
 *     signalled: Windows has no POSIX signals, and `process.kill` there
 *     is an unconditional termination that skips the 60s drain entirely.
 *     The signal remains the fallback for a worker that stopped
 *     answering.
 *
 * And liveness now comes from Redis (`connectedWorkerIds`), because a pid
 * means nothing on another node — which is what lets this page tell the
 * truth about a cluster.
 */

const spawn = vi.fn();

vi.mock("node:child_process", () => ({ spawn }));

const store = new Map<string, string>();

vi.mock("../../lib/cache-redis.js", () => ({
  redis: {
    hgetall: vi.fn(async () => Object.fromEntries(store)),
    hset: vi.fn(async (_k: string, field: string, value: string) => {
      store.set(field, value);
      return 1;
    }),
    hdel: vi.fn(async (_k: string, field: string) => {
      store.delete(field);
      return 1;
    }),
    status: "ready",
  },
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  cacheDel: vi.fn(async () => undefined),
}));

/** Which worker ids Redis reports as attached, and which nodes are up. */
let attachedIds: Set<string> | null;
let apiNodes: { host: string; ageSeconds: number }[] | null;

vi.mock("../../lib/connected-clients.js", () => ({
  connectedWorkerIds: vi.fn(async () => attachedIds),
  connectedApiNodes: vi.fn(async () => apiNodes),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let controlAllowed = true;

vi.mock("../../config.js", () => ({
  config: { NODE_ENV: "development", WORKER_CONTROL_ENABLED: false, WORKER_HTTP_PORT: 3002 },
  workerControlAllowed: () => controlAllowed,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const OPERATOR = "00000000-0000-4000-8000-aaaa0000e001";
const actor = { id: OPERATOR, name: "Pat Operator", source: `platform:${OPERATOR}` };

let svc: typeof import("../../services/worker-process.service.js");
/** Pids this host will claim are alive. */
let alive: Set<number>;
let thisNode: string;

/** A record as another node would have written it. */
function foreignRecord(over: Record<string, unknown> = {}) {
  return {
    id: "9c02ab11",
    node: "api-9b21",
    pid: 881,
    queues: [],
    startedAt: new Date(Date.now() - 600_000).toISOString(),
    healthPort: 3002,
    logFile: "/srv/app/worker.log",
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  store.clear();
  controlAllowed = true;
  alive = new Set<number>();
  attachedIds = new Set<string>();
  apiNodes = [{ host: "test-node", ageSeconds: 900 }];

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
  thisNode = svc.thisNodeName();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startWorkerProcess", () => {
  it("starts one process and records it under its own id", async () => {
    const started = await svc.startWorkerProcess([], actor);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    // Node directly, so the recorded pid is the worker's own.
    expect(command).toBe(process.execPath);
    expect(args.join(" ")).toMatch(/worker\.(ts|js)$/);

    expect(started).toMatchObject({ pid: 4242, node: thisNode, attached: false });
    expect(started.id).toBeTruthy();
    expect(store.has(started.id)).toBe(true);
  });

  it("tells the worker its own id, so Redis can report it from any node", async () => {
    // The worker passes WORKER_ID to every BullMQ Worker as its `name`,
    // which is what puts `:w:<id>` in the connection name.
    const started = await svc.startWorkerProcess([], actor);

    const opts = spawn.mock.calls[0][2];
    expect(opts.env.WORKER_ID).toBe(started.id);
    // And names itself a worker rather than an API node in CLIENT LIST.
    expect(opts.env.PROCESS_ROLE).toBe("worker");
  });

  it("serves every queue when none is named", async () => {
    await svc.startWorkerProcess([], actor);

    expect(spawn.mock.calls[0][2].env.WORKER_QUEUES).toBe("all");
  });

  it("passes a named subset through the environment, never a command line", async () => {
    const started = await svc.startWorkerProcess(["imports", "billing-runs"], actor);

    const opts = spawn.mock.calls[0][2];
    expect(opts.env.WORKER_QUEUES).toBe("imports,billing-runs");
    expect(opts.shell).not.toBe(true);
    expect(started.queues).toEqual(["imports", "billing-runs"]);
  });

  it("refuses a queue name that is not in the registry", async () => {
    await expect(svc.startWorkerProcess(["imports; rm -rf /"], actor)).rejects.toMatchObject({
      code: "UNKNOWN_QUEUE",
      statusCode: 400,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a second worker on this node, because the health port collides", async () => {
    alive.add(4242);
    const first = await svc.startWorkerProcess([], actor);
    attachedIds = new Set([first.id]);

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "ALREADY_RUNNING",
      statusCode: 409,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("is not blocked by a worker running on a different node", async () => {
    /*
     * The bug this replaces: one record under one key meant the first
     * node to start a worker stopped every other node from starting one,
     * anywhere in the cluster. A node's health port is its own.
     */
    const other = foreignRecord();
    store.set(other.id, JSON.stringify(other));
    attachedIds = new Set([other.id]);

    const started = await svc.startWorkerProcess([], actor);

    expect(started.node).toBe(thisNode);
    expect(store.size).toBe(2);
  });

  it("starts again once the worker recorded here has died", async () => {
    const first = await svc.startWorkerProcess([], actor);
    attachedIds = new Set();
    spawn.mockReturnValue({ pid: 5151, unref: vi.fn() });

    const second = await svc.startWorkerProcess([], actor);

    expect(second.pid).toBe(5151);
    expect(second.id).not.toBe(first.id);
  });

  it("refuses when worker control is not enabled on this node", async () => {
    controlAllowed = false;

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "WORKER_CONTROL_DISABLED",
      statusCode: 403,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records nothing when the spawn does not produce a process", async () => {
    spawn.mockReturnValue({ pid: undefined, unref: vi.fn() });

    await expect(svc.startWorkerProcess([], actor)).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    });
    expect(store.size).toBe(0);
  });

  it("sends the worker's output to a file, so a boot failure can be read", async () => {
    // This discarded stdio first. A worker that dies during boot — a bad
    // DATABASE_URL, a stale generated Prisma client — then leaves no
    // trace, and the console can only say it is not running.
    const started = await svc.startWorkerProcess([], actor);

    const stdio = spawn.mock.calls[0][2].stdio;
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
    expect(started.logFile).toMatch(/worker\.log$/);
  });
});

describe("stopWorkerProcess", () => {
  it("asks the worker to drain over its own HTTP server, not with a signal", async () => {
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    attachedIds = new Set([started.id]);

    const result = await svc.stopWorkerProcess(started.id, actor);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:3002/shutdown");
    expect(init).toMatchObject({ method: "POST" });
    expect(process.kill).not.toHaveBeenCalledWith(4242, "SIGTERM");
    expect(result.method).toBe("drain");
  });

  it("reports the stop as in progress while the worker is still draining", async () => {
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    attachedIds = new Set([started.id]);

    const result = await svc.stopWorkerProcess(started.id, actor);

    expect(result).toMatchObject({ stopping: true, pid: 4242 });
    // The record stays; the status read is what notices it has gone.
    expect(store.has(started.id)).toBe(true);
  });

  it("falls back to a signal when the worker's HTTP server cannot be reached", async () => {
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await svc.stopWorkerProcess(started.id, actor);

    expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(result.method).toBe("signal");
  });

  it("asks the port the worker was actually started on", async () => {
    // Recorded at spawn, so changing WORKER_HTTP_PORT afterwards cannot
    // leave a running worker unreachable.
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    store.set(started.id, JSON.stringify({ ...JSON.parse(store.get(started.id)!), healthPort: 3999 }));

    await svc.stopWorkerProcess(started.id, actor);

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3999/shutdown");
  });

  it("refuses an id it has no record of", async () => {
    await expect(svc.stopWorkerProcess("not-a-worker", actor)).rejects.toMatchObject({
      code: "NO_SUCH_WORKER",
      statusCode: 404,
    });
  });

  it("refuses to signal a worker belonging to another node", async () => {
    /*
     * One Redis, several nodes: `process.kill` would signal whatever
     * holds that pid on *this* machine, which is a different process
     * entirely. Reaching another node is what the pub/sub step of the
     * design is for; until then this refuses rather than guesses.
     */
    const other = foreignRecord();
    store.set(other.id, JSON.stringify(other));
    attachedIds = new Set([other.id]);

    await expect(svc.stopWorkerProcess(other.id, actor)).rejects.toMatchObject({
      code: "OTHER_NODE",
      statusCode: 409,
    });
    expect(process.kill).not.toHaveBeenCalledWith(881, "SIGTERM");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getWorkerControlStatus", () => {
  it("says which node answered, so an arbitrary placement is visible", async () => {
    const status = await svc.getWorkerControlStatus();

    expect(status.thisNode).toBe(thisNode);
    expect(status.controllable).toBe(true);
  });

  it("lists every node that is connected, not only those running a worker", async () => {
    // "Which nodes have no worker" is the useful question, and a node is
    // invisible if it is only learned about through its workers.
    apiNodes = [
      { host: "api-7f3c", ageSeconds: 3600 },
      { host: "api-9b21", ageSeconds: 120 },
    ];

    const status = await svc.getWorkerControlStatus();

    expect(status.nodes?.map((n) => n.host)).toEqual(["api-7f3c", "api-9b21"]);
  });

  it("says the node list is unknown rather than empty when Redis will not say", async () => {
    apiNodes = null;

    expect((await svc.getWorkerControlStatus()).nodes).toBeNull();
  });

  it("calls a worker attached when Redis reports its id, wherever it runs", async () => {
    const other = foreignRecord();
    store.set(other.id, JSON.stringify(other));
    attachedIds = new Set([other.id]);

    const status = await svc.getWorkerControlStatus();

    expect(status.workers).toHaveLength(1);
    expect(status.workers[0]).toMatchObject({
      id: other.id,
      node: "api-9b21",
      attached: true,
      // Not ours to signal, so the page must not offer it.
      stoppable: false,
    });
  });

  it("marks a worker on this node stoppable", async () => {
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    attachedIds = new Set([started.id]);

    const status = await svc.getWorkerControlStatus();

    expect(status.workers[0]).toMatchObject({ stoppable: true, attached: true });
  });

  it("forgets a worker on this node whose process has gone", async () => {
    // Authoritative here: the pid is checkable, so there is no waiting
    // on a threshold.
    const started = await svc.startWorkerProcess([], actor);
    attachedIds = new Set();

    const status = await svc.getWorkerControlStatus();

    expect(status.workers).toEqual([]);
    expect(store.has(started.id)).toBe(false);
  });

  it("keeps a worker on this node that has not attached yet", async () => {
    // A freshly spawned worker takes a moment to connect. Its pid is
    // alive, which beats the absence of a Redis client it has not opened.
    alive.add(4242);
    const started = await svc.startWorkerProcess([], actor);
    attachedIds = new Set();

    const status = await svc.getWorkerControlStatus();

    expect(status.workers.map((w) => w.id)).toEqual([started.id]);
    expect(status.workers[0].attached).toBe(false);
  });

  it("forgets a worker on another node once it has been detached for long enough", async () => {
    /*
     * A foreign pid cannot be checked, so the only evidence is the
     * absence of its Redis connections — which is also what a worker
     * looks like for the first second of its life. Hence a grace period,
     * and it exists only for records this node cannot verify.
     */
    const stale = foreignRecord({ startedAt: new Date(Date.now() - 600_000).toISOString() });
    store.set(stale.id, JSON.stringify(stale));
    attachedIds = new Set();

    const status = await svc.getWorkerControlStatus();

    expect(status.workers).toEqual([]);
    expect(store.has(stale.id)).toBe(false);
  });

  it("keeps a just-started worker on another node that has not attached yet", async () => {
    const fresh = foreignRecord({ startedAt: new Date().toISOString() });
    store.set(fresh.id, JSON.stringify(fresh));
    attachedIds = new Set();

    const status = await svc.getWorkerControlStatus();

    expect(status.workers.map((w) => w.id)).toEqual([fresh.id]);
  });

  it("keeps every record when attachment cannot be read at all", async () => {
    // No evidence is not evidence of absence: deleting records because
    // Redis refuses CLIENT LIST would throw away the only state there is.
    const other = foreignRecord();
    store.set(other.id, JSON.stringify(other));
    attachedIds = null;

    const status = await svc.getWorkerControlStatus();

    expect(status.workers.map((w) => w.id)).toEqual([other.id]);
    expect(status.workers[0].attached).toBe(false);
  });

  it("says so when this node may not control a worker", async () => {
    controlAllowed = false;

    expect(await svc.getWorkerControlStatus()).toMatchObject({ controllable: false });
  });
});

describe("signalDrains", () => {
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
