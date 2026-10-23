import { spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, workerControlAllowed } from "../config.js";
import { redis } from "../lib/cache-redis.js";
import { logger } from "../lib/logger.js";
import { connectedApiNodes, connectedWorkerIds, type ConnectedNode } from "../lib/connected-clients.js";
import { ALL_QUEUE_NAMES, type QueueName } from "../lib/queues.js";
import type { LifecycleActor } from "./provisioning.service.js";

/**
 * The worker processes this deployment is running, and the two things
 * this node can do to its own.
 *
 * The worker is a separate Node process — `src/worker.ts`, with its own
 * health server and its own drain — and `start_dev.bat` deliberately
 * does not start one. So the ordinary state of a dev stack is eight
 * queues filling up with nothing attached, which the counts alone cannot
 * tell apart from healthy.
 *
 * **A registry, not a slot.** The first version kept one record under
 * one key, which had an accident in it: a second API node's start was
 * refused because the *first* node's record existed, so a whole cluster
 * could only ever have one console-started worker. Records are keyed by
 * worker id now, with the node on the record.
 *
 * **Still one worker per node, and that is a constraint.**
 * `startHealthServer` binds `WORKER_HTTP_PORT` with no `error` handler,
 * so a second worker on the same host exits 1 on EADDRINUSE — verified.
 * Refusing it with a sentence beats spawning a process that dies a
 * moment later.
 *
 * **What this is not.** It does not run workers inside the API process,
 * which would put a billing run — thousands of accounts through the rate
 * engine on one event loop — in the way of HTTP traffic. And it does not
 * scale a deployment: a worker spawned by an API container is a process
 * the orchestrator knows nothing about, which is why
 * `workerControlAllowed()` makes production opt in explicitly.
 *
 * Facts measured against the running stack, each of which decided a
 * piece of this:
 *
 *   - **One process, not a tree.** `node --import tsx src/worker.ts`
 *     starts the worker directly, so `child.pid` is the worker. `pnpm`
 *     or `npx` wraps it, and killing the wrapper leaves the worker
 *     attached to Redis — which happened while building this.
 *
 *   - **The record lives in Redis**, because `tsx watch` restarts the API
 *     on every file save. A module-level handle is lost several times an
 *     hour, after which Stop cannot work while the page still claims a
 *     worker. The spawn is detached for the same reason.
 *
 *   - **A stop is asked for, not signalled.** Windows has no POSIX
 *     signals; `process.kill` there is an unconditional termination that
 *     skips the 60s drain, the DLQ teardown and the Redis quit. See
 *     `signalDrains`.
 *
 *   - **Liveness comes from Redis**, because a pid means nothing on
 *     another node. Each worker names its BullMQ connections with its own
 *     id, so `connectedWorkerIds()` answers "is it alive" from anywhere.
 */

const REGISTRY_KEY = "platform:workers";

/** What was started, where, and how to reach it. */
export interface WorkerRecord {
  id: string;
  /** The API host that spawned it. */
  node: string;
  pid: number;
  /** The queues it serves; empty means all of them. */
  queues: QueueName[];
  startedAt: string;
  /**
   * The port its health server listens on, recorded at spawn so that
   * changing `WORKER_HTTP_PORT` afterwards cannot leave a running worker
   * unreachable.
   */
  healthPort: number;
  /** Where its output went, so a worker that died at boot can be read. */
  logFile: string;
}

export interface WorkerView extends WorkerRecord {
  /** Holding its BullMQ connections right now — readable from any node. */
  attached: boolean;
  /** Whether *this* node can stop it. Only its own, until commands route. */
  stoppable: boolean;
}

export interface WorkerControlStatus {
  /**
   * When this node's TypeScript sources were last written, or null where
   * there are none to look at.
   *
   * A worker is the only process in the stack that does not reload. The
   * API runs `tsx watch`; a worker runs as a single `--import tsx`
   * process on purpose, so the recorded pid is the worker's own and a
   * stop cannot orphan it — see the three facts in
   * `worker-process.service.test.ts`. The consequence is that a change
   * to rating or run logic does not reach the next run, and the run
   * reports the old behaviour as current. Four billing runs in one
   * evening were read as fresh bugs before the worker turned out to be
   * holding code from twenty minutes earlier.
   *
   * Reported rather than fixed by reloading, because the restart is one
   * click and the information was the part that was missing. A caller
   * compares it with each worker's `startedAt`.
   */
  sourceChangedAt: string | null;
  /** Whether this node may start or stop a worker at all. */
  controllable: boolean;
  /** Which node answered, so an arbitrary placement is visible. */
  thisNode: string;
  workers: WorkerView[];
  /** Every connected API node; null when Redis would not list clients. */
  nodes: ConnectedNode[] | null;
}

/** How a stop was delivered: the drain request, or the blunt fallback. */
export type StopMethod = "drain" | "signal" | "already-gone";

export interface StopResult {
  id: string;
  node: string;
  pid: number | null;
  /** A stop was asked for and the worker is still finishing. */
  stopping: boolean;
  method: StopMethod;
  /**
   * Whether in-flight jobs got to finish. True for a drain request;
   * platform-dependent for the signal fallback.
   */
  drained: boolean;
}

export class WorkerControlError extends Error {
  constructor(
    readonly code:
      | "WORKER_CONTROL_DISABLED"
      | "UNKNOWN_QUEUE"
      | "ALREADY_RUNNING"
      | "NO_SUCH_WORKER"
      | "OTHER_NODE"
      | "SPAWN_FAILED",
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkerControlError";
  }
}

/**
 * Whether a *signal* lets the worker finish what it is holding.
 *
 * On Windows, Node maps every signal to an immediate termination: the
 * worker's SIGTERM handler — which closes each Worker with a 60s drain,
 * stops the DLQ monitor and quits Redis — does not run. An in-flight job
 * loses its lock instead and is picked up again after
 * `WORKER_LOCK_DURATION_MS`, survivable precisely because the handlers
 * are required to be idempotent.
 *
 * This is why the signal is only the fallback, and how the operator is
 * told that the stop they performed was abrupt.
 */
export function signalDrains(platform: string = process.platform): boolean {
  return platform !== "win32";
}

export function thisNodeName(): string {
  return hostname();
}

/**
 * How long a record this node cannot verify may go unattached before it
 * is treated as gone.
 *
 * A foreign pid is not checkable, so the only evidence is the absence of
 * the worker's Redis connections — which is also what a worker looks
 * like for the first moment of its life. Hence a grace period, and it
 * applies *only* to records this node cannot verify: for its own, the pid
 * is authoritative and there is nothing to wait for.
 */
const FOREIGN_GRACE_MS = 120_000;

/** Bounds accepting the drain request, not the drain itself. */
const DRAIN_REQUEST_TIMEOUT_MS = 2_000;

/** Where `packages/api` is, from this file rather than from the cwd. */
function apiRoot(): string {
  // src/services/<this> in development, dist/services/<this> once built;
  // two levels up is the package root either way.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * The fixed command. No shell, no operator input: the queue selection
 * travels in the environment, validated against the registry first.
 */
function workerCommand(): { args: string[]; cwd: string } {
  const cwd = apiRoot();
  return config.NODE_ENV === "production"
    ? { args: ["--env-file=.env", "dist/worker.js"], cwd }
    : { args: ["--import", "tsx", "--env-file=.env", "src/worker.ts"], cwd };
}

/**
 * The newest mtime under the API's `src`, or null outside development.
 *
 * Production has `dist` and no sources to be stale against, and stat-ing
 * a tree that is not there would be a lie rather than an omission. Walks
 * rather than caches: a few hundred stats on a console request nobody
 * polls is cheaper than a cache that can be wrong about the one thing
 * this exists to report.
 */
function newestSourceChange(): Date | null {
  if (config.NODE_ENV === "production") return null;
  const root = path.join(apiRoot(), "src");
  let newest = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const { mtimeMs } = statSync(full);
        if (mtimeMs > newest) newest = mtimeMs;
      }
    }
  };
  try {
    walk(root);
  } catch {
    // A missing or unreadable tree is "nothing to compare", not an error
    // worth failing a status read over.
    return null;
  }
  return newest > 0 ? new Date(newest) : null;
}

async function readRegistry(): Promise<WorkerRecord[]> {
  const raw = (await redis.hgetall(REGISTRY_KEY)) ?? {};
  const records: WorkerRecord[] = [];
  for (const [id, value] of Object.entries(raw)) {
    try {
      records.push(JSON.parse(value) as WorkerRecord);
    } catch {
      logger.warn({ component: "worker-control", id }, "discarding an unreadable worker record");
      await redis.hdel(REGISTRY_KEY, id);
    }
  }
  return records;
}

/** Whether a pid on *this* node is still there. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is this record still a worker, and by what evidence?
 *
 * Attachment is the strongest signal and works from anywhere. Failing
 * that, a pid check on our own node. Failing both, a record we cannot
 * verify gets a grace period before being written off.
 */
function stillRunning(
  record: WorkerRecord,
  attached: Set<string> | null,
  now: number,
): boolean {
  // No evidence is not evidence of absence: if Redis will not list its
  // clients, deleting records would throw away the only state there is.
  if (attached === null) return true;
  if (attached.has(record.id)) return true;

  if (record.node === thisNodeName()) return isAlive(record.pid);

  return now - Date.parse(record.startedAt) < FOREIGN_GRACE_MS;
}

/**
 * Every worker, as this node can see it — and the one place a record
 * that has stopped being a worker is forgotten.
 *
 * Cleanup lives on the read because a stop returns while the worker is
 * still draining, by design: the record outlives the process, and this
 * is what notices.
 */
export async function getWorkerControlStatus(): Promise<WorkerControlStatus> {
  const [records, attached, nodes] = await Promise.all([
    readRegistry(),
    connectedWorkerIds(),
    connectedApiNodes(),
  ]);

  const now = Date.now();
  const workers: WorkerView[] = [];
  for (const record of records) {
    if (!stillRunning(record, attached, now)) {
      await redis.hdel(REGISTRY_KEY, record.id);
      continue;
    }
    workers.push({
      ...record,
      attached: attached?.has(record.id) ?? false,
      stoppable: record.node === thisNodeName(),
    });
  }

  return {
    sourceChangedAt: newestSourceChange()?.toISOString() ?? null,
    controllable: workerControlAllowed(),
    thisNode: thisNodeName(),
    workers,
    nodes,
  };
}

function validateQueues(requested: readonly string[]): QueueName[] {
  const known = ALL_QUEUE_NAMES as readonly string[];
  for (const name of requested) {
    if (!known.includes(name)) {
      throw new WorkerControlError(
        "UNKNOWN_QUEUE",
        400,
        `No queue named "${name}". Adding a queue means adding it to QUEUE_NAMES.`,
      );
    }
  }
  return [...requested] as QueueName[];
}

export async function startWorkerProcess(
  queues: readonly string[],
  actor: LifecycleActor,
): Promise<WorkerView> {
  if (!workerControlAllowed()) {
    throw new WorkerControlError(
      "WORKER_CONTROL_DISABLED",
      403,
      "This node does not allow starting a worker from the console. A worker started by an API container is a process the orchestrator does not manage; set WORKER_CONTROL_ENABLED to allow it anyway.",
    );
  }

  const selected = validateQueues(queues);

  /*
   * One per node, because the health port is one port. Checked through
   * the status read, so a record whose process has gone is cleaned up
   * here rather than blocking a start forever.
   */
  const { workers } = await getWorkerControlStatus();
  const here = workers.find((w) => w.node === thisNodeName());
  if (here) {
    throw new WorkerControlError(
      "ALREADY_RUNNING",
      409,
      `A worker is already running on ${here.node} as pid ${here.pid}. A second one on the same node would fail to bind port ${config.WORKER_HTTP_PORT}.`,
    );
  }

  const id = randomUUID();
  const { args, cwd } = workerCommand();

  /*
   * Its output goes to a file, appended.
   *
   * Not inherited, because the worker outlives the API process that
   * spawned it and would be writing into a dead one's handles. And not
   * discarded, which is what this did first: a worker that dies during
   * boot then leaves no trace at all, and the console that started it
   * can only report that it is no longer running.
   */
  const logFile = path.join(cwd, "worker.log");
  const logFd = openSync(logFile, "a");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        // The worker hands this to every BullMQ Worker as its `name`,
        // which is what puts `:w:<id>` in the connection name and makes
        // the worker visible from any node.
        WORKER_ID: id,
        PROCESS_ROLE: "worker",
        // "all" is what `resolveWorkerQueues` reads as every queue.
        WORKER_QUEUES: selected.length > 0 ? selected.join(",") : "all",
      },
      // Detached and unreferenced, so the worker survives the API reload
      // that `tsx watch` performs on the next file save.
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    // The child holds its own duplicate of the descriptor.
    closeSync(logFd);
  }

  if (!child.pid) {
    throw new WorkerControlError("SPAWN_FAILED", 500, "The worker process did not start.");
  }
  child.unref();

  const record: WorkerRecord = {
    id,
    node: thisNodeName(),
    pid: child.pid,
    queues: selected,
    startedAt: new Date().toISOString(),
    healthPort: config.WORKER_HTTP_PORT,
    logFile,
  };
  await redis.hset(REGISTRY_KEY, id, JSON.stringify(record));

  /*
   * Logged, not audited. `audit_log` needs a `utility_id` and a uuid
   * `entity_id`, and this action is about a host rather than a tenant —
   * the same wall the queue job verbs hit on the sweeps.
   */
  logger.info(
    { component: "worker-control", actor: actor.id, id, pid: child.pid, queues: selected },
    "worker process started from the platform console",
  );

  // Not attached yet: it has not opened its connections.
  return { ...record, attached: false, stoppable: true };
}

/**
 * Asks the worker to drain, over the server it already runs.
 *
 * False when the request could not be delivered — the worker is wedged,
 * its HTTP server never came up, the port is wrong — and the caller falls
 * through to the signal. A refusal counts as undelivered too, because in
 * both cases nothing is draining.
 */
async function requestDrain(record: WorkerRecord): Promise<boolean> {
  const url = `http://127.0.0.1:${record.healthPort}/shutdown`;
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(DRAIN_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(
        { component: "worker-control", status: res.status, url },
        "worker refused the drain request",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, component: "worker-control", url }, "could not reach the worker to drain it");
    return false;
  }
}

export async function stopWorkerProcess(
  id: string,
  actor: LifecycleActor,
): Promise<StopResult> {
  if (!workerControlAllowed()) {
    throw new WorkerControlError(
      "WORKER_CONTROL_DISABLED",
      403,
      "This node does not allow stopping a worker from the console.",
    );
  }

  const record = (await readRegistry()).find((w) => w.id === id);
  if (!record) {
    throw new WorkerControlError(
      "NO_SUCH_WORKER",
      404,
      `No worker ${id} is recorded. One started from a terminal is attached to the same Redis and visible in the queue counts, but it has no record here — stop it where it was started.`,
    );
  }

  if (record.node !== thisNodeName()) {
    /*
     * A pid is only meaningful on its own host, and the drain request
     * goes to loopback. Reaching another node is what the pub/sub step of
     * the design is for; until then this refuses rather than signalling
     * whatever happens to hold that pid here.
     */
    throw new WorkerControlError(
      "OTHER_NODE",
      409,
      `Worker ${id} runs on ${record.node}, and this is ${thisNodeName()}. A process id only means something on its own host, so stop it from there.`,
    );
  }

  if (!isAlive(record.pid)) {
    logger.info(
      { component: "worker-control", actor: actor.id, id, pid: record.pid },
      "worker process had already gone; clearing the record",
    );
    await redis.hdel(REGISTRY_KEY, id);
    return {
      id,
      node: record.node,
      pid: null,
      stopping: false,
      method: "already-gone",
      drained: true,
    };
  }

  /*
   * Ask first, signal only if the asking fails. The request is the one
   * path that drains on both platforms; the signal is a last resort that
   * on Windows cuts in-flight jobs off mid-run.
   */
  const asked = await requestDrain(record);
  const method: StopMethod = asked ? "drain" : "signal";
  if (!asked) process.kill(record.pid, "SIGTERM");

  logger.info(
    { component: "worker-control", actor: actor.id, id, pid: record.pid, method },
    "worker process stop requested from the platform console",
  );

  /*
   * The record is left in place while the worker winds down — a drain can
   * take up to a minute per worker — and the status read clears it once
   * the worker is gone. Reporting "stopped" here would have the page
   * contradict the process table.
   */
  const stillThere = isAlive(record.pid);
  if (!stillThere) await redis.hdel(REGISTRY_KEY, id);

  return {
    id,
    node: record.node,
    pid: stillThere ? record.pid : null,
    stopping: stillThere,
    method,
    drained: asked || signalDrains(),
  };
}
