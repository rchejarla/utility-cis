import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, workerControlAllowed } from "../config.js";
import { redis } from "../lib/cache-redis.js";
import { logger } from "../lib/logger.js";
import { ALL_QUEUE_NAMES, type QueueName } from "../lib/queues.js";
import type { LifecycleActor } from "./provisioning.service.js";

/**
 * Starts and stops the worker process on this API host.
 *
 * The worker is a separate Node process — `src/worker.ts`, with its own
 * health server and its own SIGTERM drain — and `start_dev.bat`
 * deliberately does not start it. So the ordinary state of a dev stack
 * is eight queues filling up with nothing attached to work them, which
 * the counts alone cannot tell apart from healthy. The console can see
 * that now; this lets it do something about it.
 *
 * **What this is not.** It does not run workers inside the API process,
 * which would put a billing run — thousands of accounts through the rate
 * engine, `concurrency: 1` for that reason — on the same event loop as
 * HTTP traffic. And it does not scale a deployment: a worker spawned by
 * an API container is a process the orchestrator knows nothing about,
 * which is why `workerControlAllowed()` makes production opt in
 * explicitly rather than inherit this.
 *
 * Three things verified against the running stack rather than assumed,
 * each of which decided a piece of this:
 *
 *   - **One process, not a tree.** `node --import tsx src/worker.ts`
 *     starts the worker directly, so `child.pid` is the worker. Going
 *     through `pnpm` or `npx` wraps it, and killing the wrapper leaves
 *     the worker attached to Redis — which happened while building this.
 *
 *   - **The pid lives in Redis.** `tsx watch` restarts the API on every
 *     file save; a module-level handle is lost several times an hour,
 *     after which Stop cannot work while the page still claims a worker.
 *     The spawn is detached for the same reason: the worker should
 *     outlive the API reload that follows the next keystroke.
 *
 *   - **A signal cannot stop it on both platforms.** Windows has no
 *     POSIX signals, and Node emulates `process.kill(pid, "SIGTERM")`
 *     there as an unconditional termination: the worker's 60s drain, its
 *     DLQ teardown and its Redis quit are all skipped, and an in-flight
 *     job loses its lock mid-run. So a stop is **asked for over the
 *     worker's own HTTP server**, which is the same path on Windows and
 *     Linux and reaches the drain the worker already had. The signal
 *     stays as the fallback for a worker that no longer answers, where
 *     an abrupt stop beats none — and `signalDrains` is what lets the
 *     operator be told which of the two they got.
 */

const RECORD_KEY = "platform:worker-process";

/** What was started, and by which host — the only state this keeps. */
interface WorkerRecord {
  pid: number;
  host: string;
  startedAt: string;
  queues: QueueName[];
  /**
   * The port its health server is listening on, recorded at spawn so
   * that changing `WORKER_HTTP_PORT` afterwards cannot leave a running
   * worker unreachable.
   */
  healthPort: number;
  /** Where its output went, so a worker that died at boot can be read. */
  logFile: string;
}

export interface WorkerProcessStatus {
  /** Whether this host may start or stop a worker at all. */
  controllable: boolean;
  /** Running, as far as this host can tell. */
  running: boolean;
  /** A stop has been asked for and the worker is still finishing. */
  stopping: boolean;
  pid: number | null;
  host: string | null;
  startedAt: string | null;
  /** The queues it was started for; empty means all of them. */
  queues: QueueName[] | null;
  /** Where to read its output, including a failure during boot. */
  logFile: string | null;
}

/** How a stop was delivered: the drain request, or the blunt fallback. */
export type StopMethod = "drain" | "signal" | "already-gone";

export interface StopResult extends WorkerProcessStatus {
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
      | "NOT_STARTED_HERE"
      | "OTHER_HOST"
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
 * `WORKER_LOCK_DURATION_MS`, which is survivable precisely because the
 * handlers are required to be idempotent.
 *
 * This is why the signal is only the fallback. It still applies when the
 * drain request cannot be delivered, and it is how the operator is told
 * that the stop they just performed was abrupt.
 */
export function signalDrains(platform: string = process.platform): boolean {
  return platform !== "win32";
}

/**
 * How long to wait for the worker to accept a drain request.
 *
 * Bounds the acceptance, not the drain: the worker answers 202 and then
 * takes as long as its in-flight jobs need. Short, because an
 * unanswering worker should fall through to the signal quickly rather
 * than hold the operator's click.
 */
const DRAIN_REQUEST_TIMEOUT_MS = 2_000;

/** Where `packages/api` is, from this file rather than from the cwd. */
function apiRoot(): string {
  // src/services/<this> in development, dist/services/<this> once built;
  // two levels up is the package root either way.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/**
 * The fixed command. No shell, no operator input: the queue selection
 * travels in the environment, and `WORKER_QUEUES` is validated against
 * the registry before it gets there.
 */
function workerCommand(): { args: string[]; cwd: string } {
  const cwd = apiRoot();
  return config.NODE_ENV === "production"
    ? { args: ["--env-file=.env", "dist/worker.js"], cwd }
    : { args: ["--import", "tsx", "--env-file=.env", "src/worker.ts"], cwd };
}

async function readRecord(): Promise<WorkerRecord | null> {
  const raw = await redis.get(RECORD_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkerRecord;
  } catch {
    logger.warn({ component: "worker-control" }, "discarding an unreadable worker record");
    await redis.del(RECORD_KEY);
    return null;
  }
}

/** Whether a pid on *this* host is still there. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statusOf(
  record: WorkerRecord | null,
  running: boolean,
  stopping = false,
): WorkerProcessStatus {
  return {
    controllable: workerControlAllowed(),
    running,
    stopping,
    pid: running && record ? record.pid : null,
    host: running && record ? record.host : null,
    startedAt: running && record ? record.startedAt : null,
    queues: running && record ? record.queues : null,
    logFile: running && record ? record.logFile : null,
  };
}

/**
 * The record, checked against reality.
 *
 * A record from another host cannot be liveness-checked here — that pid
 * means something else on this machine — so it is reported as running
 * and left for the host that owns it to stop.
 */
async function currentStatus(): Promise<{ record: WorkerRecord | null; running: boolean }> {
  const record = await readRecord();
  if (!record) return { record: null, running: false };

  const running = record.host === hostname() ? isAlive(record.pid) : true;
  return { record, running };
}

/**
 * The worker, as this host can see it.
 *
 * Also where a finished drain is noticed: a stop asks and returns while
 * the worker is still winding down, so the record outlives the process
 * by design and is cleared here once the pid is gone. That keeps the
 * reported state the process table's, never an intention's.
 */
export async function getWorkerProcessStatus(): Promise<WorkerProcessStatus> {
  const { record, running } = await currentStatus();
  if (record && !running) await redis.del(RECORD_KEY);
  return statusOf(record, running);
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
): Promise<WorkerProcessStatus> {
  if (!workerControlAllowed()) {
    throw new WorkerControlError(
      "WORKER_CONTROL_DISABLED",
      403,
      "This host does not allow starting a worker from the console. A worker started by an API container is a process the orchestrator does not manage; set WORKER_CONTROL_ENABLED to allow it anyway.",
    );
  }

  const selected = validateQueues(queues);

  const { running, record } = await currentStatus();
  if (running && record) {
    throw new WorkerControlError(
      "ALREADY_RUNNING",
      409,
      `A worker is already running on ${record.host} as pid ${record.pid}.`,
    );
  }

  const { args, cwd } = workerCommand();

  /*
   * Its output goes to a file, appended.
   *
   * Not inherited, because the worker is meant to outlive the API
   * process that spawned it and would be writing into a dead one's
   * handles. And not discarded, which is what this did first: a worker
   * that dies during boot — a bad DATABASE_URL, a missing generated
   * Prisma client — then leaves no trace at all, and the console that
   * started it can only report that it is no longer running.
   */
  const logFile = path.join(cwd, "worker.log");
  const logFd = openSync(logFile, "a");

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
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

  const started: WorkerRecord = {
    pid: child.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    queues: selected,
    healthPort: config.WORKER_HTTP_PORT,
    logFile,
  };
  await redis.set(RECORD_KEY, JSON.stringify(started));

  /*
   * Logged, not audited. `audit_log` needs a `utility_id` and a uuid
   * `entity_id`, and this action is about a host rather than a tenant —
   * the same wall the queue verbs hit on the sweeps.
   */
  logger.info(
    { component: "worker-control", actor: actor.id, pid: child.pid, queues: selected },
    "worker process started from the platform console",
  );

  return statusOf(started, true);
}

/**
 * Asks the worker to drain, over the server it already runs.
 *
 * Returns false when it could not be delivered — the worker is wedged,
 * its HTTP server never came up, or the port is wrong — and the caller
 * falls through to the signal. A refusal (403 from a non-loopback
 * caller, 404 from a process that registered no handler) counts as
 * undelivered too, because in both cases nothing is draining.
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

export async function stopWorkerProcess(actor: LifecycleActor): Promise<StopResult> {
  if (!workerControlAllowed()) {
    throw new WorkerControlError(
      "WORKER_CONTROL_DISABLED",
      403,
      "This host does not allow stopping a worker from the console.",
    );
  }

  const record = await readRecord();
  if (!record) {
    throw new WorkerControlError(
      "NOT_STARTED_HERE",
      409,
      "No worker was started from this console. One started from a terminal is attached to the same Redis and visible in the counts, but its pid is not known here — stop it where it was started.",
    );
  }

  if (record.host !== hostname()) {
    throw new WorkerControlError(
      "OTHER_HOST",
      409,
      `That worker was started on ${record.host}, and a pid is only meaningful on its own host. Stop it from there.`,
    );
  }

  if (!isAlive(record.pid)) {
    logger.info(
      { component: "worker-control", actor: actor.id, pid: record.pid },
      "worker process had already gone; clearing the record",
    );
    await redis.del(RECORD_KEY);
    return { ...statusOf(null, false), method: "already-gone", drained: true };
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
    { component: "worker-control", actor: actor.id, pid: record.pid, method },
    "worker process stop requested from the platform console",
  );

  /*
   * The record is left in place while the worker winds down — a drain
   * can take up to a minute per worker — and `getWorkerProcessStatus`
   * clears it once the pid is gone. Reporting "stopped" here would have
   * the page contradict the process table.
   */
  const stillThere = isAlive(record.pid);
  if (!stillThere) await redis.del(RECORD_KEY);

  return {
    ...statusOf(record, stillThere, stillThere),
    method,
    drained: asked || signalDrains(),
  };
}
