import { spawn } from "node:child_process";
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
 *   - **A stop on Windows is abrupt.** `process.kill(pid, "SIGTERM")`
 *     terminates immediately there; the drain handler never runs. See
 *     `stopIsGraceful`.
 */

const RECORD_KEY = "platform:worker-process";

/** What was started, and by which host — the only state this keeps. */
interface WorkerRecord {
  pid: number;
  host: string;
  startedAt: string;
  queues: QueueName[];
}

export interface WorkerProcessStatus {
  /** Whether this host may start or stop a worker at all. */
  controllable: boolean;
  /** Running, as far as this host can tell. */
  running: boolean;
  pid: number | null;
  host: string | null;
  startedAt: string | null;
  /** The queues it was started for; empty means all of them. */
  queues: QueueName[] | null;
  /** Whether a stop would drain in-flight jobs or cut them off. */
  stopDrains: boolean;
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
 * Whether stopping the worker lets it finish what it is holding.
 *
 * On Windows, Node maps every signal to an immediate termination: the
 * worker's SIGTERM handler — which closes each Worker with a 60s drain,
 * stops the DLQ monitor and quits Redis — does not run. An in-flight job
 * loses its lock instead and is picked up again after
 * `WORKER_LOCK_DURATION_MS`, which is survivable precisely because the
 * handlers are required to be idempotent. It is still not the same act,
 * so the operator is told which one they got.
 */
export function stopIsGraceful(platform: string = process.platform): boolean {
  return platform !== "win32";
}

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

function statusOf(record: WorkerRecord | null, running: boolean): WorkerProcessStatus {
  return {
    controllable: workerControlAllowed(),
    running,
    pid: running && record ? record.pid : null,
    host: running && record ? record.host : null,
    startedAt: running && record ? record.startedAt : null,
    queues: running && record ? record.queues : null,
    stopDrains: stopIsGraceful(),
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

export async function getWorkerProcessStatus(): Promise<WorkerProcessStatus> {
  const { record, running } = await currentStatus();
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
  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      // "all" is what `resolveWorkerQueues` reads as every queue.
      WORKER_QUEUES: selected.length > 0 ? selected.join(",") : "all",
    },
    // Detached and unreferenced, so the worker survives the API reload
    // that `tsx watch` performs on the next file save. stdio goes
    // nowhere: the worker logs to its own stream, and inheriting would
    // tie it to an API process it is meant to outlive.
    detached: true,
    stdio: "ignore",
  });

  if (!child.pid) {
    throw new WorkerControlError("SPAWN_FAILED", 500, "The worker process did not start.");
  }
  child.unref();

  const started: WorkerRecord = {
    pid: child.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    queues: selected,
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

export async function stopWorkerProcess(actor: LifecycleActor): Promise<WorkerProcessStatus> {
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

  if (isAlive(record.pid)) {
    process.kill(record.pid, "SIGTERM");
    logger.info(
      {
        component: "worker-control",
        actor: actor.id,
        pid: record.pid,
        drained: stopIsGraceful(),
      },
      "worker process stopped from the platform console",
    );
  } else {
    logger.info(
      { component: "worker-control", actor: actor.id, pid: record.pid },
      "worker process had already gone; clearing the record",
    );
  }

  await redis.del(RECORD_KEY);
  return statusOf(null, false);
}
