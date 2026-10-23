/**
 * What `GET /api/v1/platform/queues` answers with.
 *
 * One call serves all three Cluster pages — Overview, Workers, Queues —
 * because the verdict needs both halves: "nothing is running" is a fact
 * about workers *and* about what is queued behind them. Splitting the
 * endpoint would mean two calls to answer one question.
 */

export interface QueueFailure {
  jobId: string | null;
  jobName: string;
  failedAt: string | null;
  reason: string | null;
  utilityId: string | null;
  utilityName: string | null;
}

export interface QueueHealth {
  name: string;
  counts: {
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    /**
     * Retained by `removeOnComplete` — 24h, 1000 max — and the only
     * evidence a quiet cron queue is working: its handler logs nothing
     * on an empty tick, deliberately, at up to 8,640 ticks a day.
     */
    completed: number;
  };
  dlqDepth: number;
  /** Attached worker processes; null where Redis would not list clients. */
  workers: number | null;
  workerAgeSeconds: number | null;
  paused: boolean;
  recentFailures: QueueFailure[];
}

/** One worker process, wherever in the deployment it runs. */
export interface WorkerView {
  id: string;
  /** The API node that spawned it. */
  node: string;
  pid: number;
  queues: string[];
  startedAt: string;
  healthPort: number;
  /** Where its output went, including a failure during boot. */
  logFile: string;
  /** Holding its BullMQ connections right now — readable from any node. */
  attached: boolean;
  /** Whether the node serving this page can stop it. */
  stoppable: boolean;
}

/** An API node, as Redis's client list reports it. */
export interface ConnectedNode {
  host: string;
  ageSeconds: number;
}

/** What a stop came back with: how it was delivered, and whether it drained. */
export interface StopResult {
  id: string;
  node: string;
  pid: number | null;
  stopping: boolean;
  method: "drain" | "signal" | "already-gone";
  drained: boolean;
}

export type JobState = "waiting" | "active" | "delayed" | "failed" | "completed" | "dlq";

export interface QueueJob {
  /** Which queue it is in — the whole point of a merged list. */
  queue: string;
  jobId: string | null;
  jobName: string;
  utilityId: string | null;
  utilityName: string | null;
  enqueuedAt: string | null;
  runsAt: string | null;
  repeats: string | null;
  attemptsMade: number;
  reason: string | null;
  /** Whether this queue's jobs name one tenant or sweep across all of them. */
  tenancy: "all-tenants" | "per-tenant";
  /** What is already wrong with this job; null when nothing is. */
  invalid: string | null;
  /** When it last finished: succeeded, or stopped trying. */
  finishedAt: string | null;
  durationMs: number | null;
  result: Record<string, string | number | boolean> | null;
}

export interface QueueJobsResult {
  /** The queue asked for, or `all`. */
  queue: string;
  state: JobState;
  reachable: boolean;
  jobs: QueueJob[];
  /** Whether a further page exists, answered by fetching one extra. */
  hasMore: boolean;
}

export interface ClusterReport {
  /** False when Redis did not answer — not an empty deployment. */
  reachable: boolean;
  checkedAt: string;
  queues: QueueHealth[];
  totals: { waiting: number; active: number; failed: number; dlq: number };
  /**
   * When the serving node's sources were last written, or null where
   * there are none — a built deployment has no sources to be stale
   * against. Compared with a worker's `startedAt`, it is the only way
   * this page can say that a worker is holding code older than the disk.
   */
  sourceChangedAt: string | null;
  /** Whether the node serving this page may start or stop a worker. */
  controllable: boolean;
  /** Which node answered, since a start lands there and nowhere else. */
  thisNode: string;
  workers: WorkerView[];
  /** Every connected API node; null when Redis would not list clients. */
  nodes: ConnectedNode[] | null;
}

/**
 * Whether a worker started before the last change to the sources.
 *
 * Null `sourceChangedAt` means there is nothing to compare — production,
 * or an unreadable tree — and silence is the right answer, not a guess.
 */
export function isStale(startedAt: string, sourceChangedAt: string | null): boolean {
  if (!sourceChangedAt) return false;
  return new Date(startedAt).getTime() < new Date(sourceChangedAt).getTime();
}
