/**
 * The two limits on how much of a queue runs at once.
 *
 * `concurrency` is two different limits wearing one word, and an
 * operator needs both:
 *
 * - **per node** bounds one worker process — its heap, its CPU, its own
 *   `pg.Pool` of 10 connections. It is a statement about an instance
 *   size, so it stays true however many nodes are running.
 * - **the cluster limit** bounds the shared resource: total concurrent
 *   load on one database. It is a statement about the database, so it
 *   also stays true however many nodes are running.
 *
 * Neither is derived from the other, and neither is derived from the
 * node count. What runs is `min(cluster, workers × perNode)`, which is
 * why a cluster limit of 4 with per node 1 on three nodes runs **3** —
 * the number reads as a limit and limits nothing until a fourth node
 * joins. That is reported rather than rejected; see `effectiveLimit`.
 *
 * Why not one field, constrained to a multiple of the node count, with
 * per node derived as `G/n`: it raises per-node load exactly when the
 * fleet shrinks. A node dies, `n` goes 3→2, and every survivor
 * recomputes upward from `G/3` to `G/2` — so a node lost to load hands
 * more concurrent work to the machines next in line. Full argument, and
 * the second reason, in `docs/specs/27-job-scheduling.md` §6 SCH-CONC-5.
 */
import { QUEUE_DEFAULTS, getQueue, type QueueName } from "./queues.js";
import { queueRedisConnection } from "./queue-redis.js";
import { logger } from "./logger.js";

/**
 * Where a per-node limit is stored, beside `platform:workers`.
 *
 * The cluster limit needs no store of ours: BullMQ keeps it in the
 * queue's own `meta` hash, the field next to `paused`, and that hash is
 * what the `moveToActive` script reads. One copy, and it is the copy
 * that enforces.
 */
export const PER_NODE_LIMIT_KEY = "platform:queue-concurrency";

/** The largest either limit may be set to. */
const MAX_CONCURRENCY = 1_000;

export interface QueueLimits {
  /** Max in-flight jobs on one worker process. */
  perNode: number;
  /** The cluster-wide ceiling, or null when none is set. */
  cluster: number | null;
}

function invalid(value: number): Error {
  return Object.assign(
    new Error(
      `A concurrency limit must be a whole number between 1 and ${MAX_CONCURRENCY}; got ${value}. ` +
        "To remove a limit, clear it — zero would stop the queue, which is what pause is for.",
    ),
    { statusCode: 400, code: "INVALID_CONCURRENCY" },
  );
}

function assertSettable(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) throw invalid(value);
}

/**
 * Both limits for one queue.
 *
 * `null` for the cluster limit means no ceiling, which is the default
 * and today's behaviour — deliberately not 0, which would stop the queue
 * dead. A per-node limit falls back to `QUEUE_DEFAULTS`, so a queue
 * nobody has configured behaves exactly as it did before this setting
 * existed.
 */
export async function readQueueLimits(name: QueueName): Promise<QueueLimits> {
  const [storedPerNode, cluster] = await Promise.all([
    queueRedisConnection.hget(PER_NODE_LIMIT_KEY, name),
    getQueue(name).getGlobalConcurrency(),
  ]);

  const parsed = storedPerNode === null ? NaN : Number(storedPerNode);
  return {
    perNode: Number.isInteger(parsed) && parsed >= 1 ? parsed : QUEUE_DEFAULTS[name].concurrency,
    cluster: cluster ?? null,
  };
}

/** Store a per-node limit, or `null` to fall back to the code default. */
export async function setPerNodeLimit(name: QueueName, perNode: number | null): Promise<void> {
  if (perNode === null) {
    await queueRedisConnection.hdel(PER_NODE_LIMIT_KEY, name);
    return;
  }
  assertSettable(perNode);
  await queueRedisConnection.hset(PER_NODE_LIMIT_KEY, name, String(perNode));
}

/**
 * Set the cluster-wide ceiling, or `null` to remove it.
 *
 * Honoured passively: the gate is `LLEN active >= concurrency` inside
 * BullMQ's `moveToActive` script, so every node picks the new value up
 * on its next fetch. No process has to be told, which is the same reason
 * `Queue.pause()` needs no command path.
 */
export async function setClusterLimit(name: QueueName, cluster: number | null): Promise<void> {
  const queue = getQueue(name);
  if (cluster === null) {
    await queue.removeGlobalConcurrency();
    return;
  }
  assertSettable(cluster);
  await queue.setGlobalConcurrency(cluster);
}

/**
 * What will actually run, given who is attached.
 *
 * Null when the worker count is unknown — a managed Redis that refuses
 * `CLIENT LIST` costs us that number, and a cap printed as a figure
 * would be a fabrication. Zero attached workers is not unknown: it is
 * the ordinary state of a dev stack, and it means nothing in the queue
 * will run.
 */
export function effectiveLimit(limits: QueueLimits, workers: number | null): number | null {
  if (workers === null) return null;
  const capacity = workers * limits.perNode;
  return limits.cluster === null ? capacity : Math.min(limits.cluster, capacity);
}

/** Enough of a `Worker` to read its queue and set its limit. */
interface Limitable {
  readonly name: string;
  concurrency: number;
}

function isQueueName(name: string): name is QueueName {
  return name in QUEUE_DEFAULTS;
}

/**
 * Apply the stored per-node limits to this process's workers.
 *
 * Called once at boot, after the workers are built. A `Worker`'s
 * concurrency is a constructor option, so unlike the cluster limit it
 * cannot be honoured passively — it has to reach a live object, and
 * BullMQ's setter is the way (it assigns `_concurrency`, which the fetch
 * loop reads, so lowering it stops fetching while jobs already running
 * finish).
 *
 * Boot is therefore when a change takes effect, which the console says
 * in those words. A poll of the hash would buy live edits for an
 * interval of staleness; it is not built, because the cluster limit is
 * the lever that has to act immediately during an incident and it
 * already does. See `docs/specs/27-job-scheduling.md` open question 6.
 */
export async function applyPerNodeLimits(workers: readonly Limitable[]): Promise<void> {
  for (const worker of workers) {
    if (!isQueueName(worker.name)) continue;
    const { perNode } = await readQueueLimits(worker.name);
    if (perNode === worker.concurrency) continue;
    worker.concurrency = perNode;
    logger.info(
      { component: "worker", queue: worker.name, perNode },
      "Applied a stored per-node concurrency limit",
    );
  }
}
