"use client";

import { Fragment, useState, useEffect } from "react";
import { API_URL, apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Whether anything in the background is stuck, whose it is, and whether
 * anyone is working it.
 *
 * Bull Board lists every job and is the right tool for reading a payload.
 * It cannot answer the question an operator arrives with, because it has
 * no notion of a tenant and no summary: a dead-lettered billing run
 * looks like any other row, and finding it means knowing to look.
 *
 * So this page is a verdict first. Three things it learned the hard way:
 *
 *   - **Counts alone cannot say "healthy".** Workers are a separate
 *     process and `start_dev.bat` does not start one, so the ordinary
 *     state of a dev stack is queues filling up with nothing attached.
 *     This page once said "All clear" over 102 jobs that could never run.
 *
 *   - **The worker fact belongs at the top, once.** One process serves
 *     all eight queues, so eight per-queue labels repeated a single fact
 *     and pushed the counts off the screen. Hence one status card and one
 *     table, rather than eight cards.
 *
 *   - **A parked job can already be impossible.** The payload is withheld
 *     on purpose, so only the API can say whether a job's tenant and
 *     record still exist — see the Problem column.
 */

interface QueueFailure {
  jobId: string | null;
  jobName: string;
  failedAt: string | null;
  reason: string | null;
  utilityId: string | null;
  utilityName: string | null;
}

interface QueueHealth {
  name: string;
  counts: { waiting: number; active: number; delayed: number; failed: number };
  dlqDepth: number;
  /** Attached worker processes; null where Redis would not list its clients. */
  workers: number | null;
  workerAgeSeconds: number | null;
  paused: boolean;
  recentFailures: QueueFailure[];
}

/** One worker process, wherever in the deployment it runs. */
interface WorkerView {
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
interface ConnectedNode {
  host: string;
  ageSeconds: number;
}

/** What a stop came back with: how it was delivered, and whether it drained. */
interface StopResult {
  id: string;
  node: string;
  pid: number | null;
  stopping: boolean;
  method: "drain" | "signal" | "already-gone";
  drained: boolean;
}

type JobState = "waiting" | "active" | "delayed" | "failed" | "dlq";

interface QueueJob {
  jobId: string | null;
  jobName: string;
  utilityId: string | null;
  utilityName: string | null;
  enqueuedAt: string | null;
  runsAt: string | null;
  repeats: string | null;
  attemptsMade: number;
  reason: string | null;
  tenancy: "all-tenants" | "per-tenant";
  invalid: string | null;
}

interface QueueJobsResult {
  queue: string;
  state: JobState;
  reachable: boolean;
  jobs: QueueJob[];
}

interface QueueHealthReport {
  reachable: boolean;
  checkedAt: string;
  queues: QueueHealth[];
  totals: { waiting: number; active: number; failed: number; dlq: number };
  /** Whether the node serving this page may start or stop a worker. */
  controllable: boolean;
  /** Which node answered, since a start lands there and nowhere else. */
  thisNode: string;
  workers: WorkerView[];
  /** Every connected API node; null when Redis would not list clients. */
  nodes: ConnectedNode[] | null;
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

const BULL_BOARD_URL = `${API_URL}/admin/queues`;

/** Twenty is a screenful; past that this is the wrong tool. */
const JOBS_PER_OPEN = 20;

/**
 * Below this, how long ago a worker attached is worth printing.
 *
 * A worker that reattaches every few seconds is crash-looping, and reads
 * as a healthy "1 worker" without this. An hours-old connection's exact
 * age tells nobody anything, so it stays out.
 */
const RECENTLY_ATTACHED_SECONDS = 300;

/**
 * A due time in the past, said in a word.
 *
 * The whole signal is "due two days ago", and a bare timestamp makes the
 * reader do the subtraction — which is how a stalled scheduler goes
 * unnoticed. Seen while building this: audit-retention's repeatable sat
 * due 2026-10-18 while the date was the 20th, because no worker process
 * was up to run it and reschedule.
 */
function isOverdue(runsAt: string): boolean {
  return new Date(runsAt).getTime() < Date.now();
}

/** Trouble first; the rest keep the registry's order. */
function troubledFirst(queues: QueueHealth[]): QueueHealth[] {
  const score = (q: QueueHealth) =>
    q.counts.failed > 0 || q.dlqDepth > 0 || q.paused ? 0 : 1;
  return [...queues].sort((a, b) => score(a) - score(b));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function shortAge(seconds: number): string {
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

/**
 * The tenant a job or failure belongs to.
 *
 * Four different facts, and three of them used to render the same way.
 * A bare uuid is indistinguishable from a tenant name nobody
 * recognises; and a blank tenant means "every tenant" on one of the five
 * cron sweeps and "this job has lost its owner" on `billing-runs`,
 * which read identically as an empty cell. `tenancy` is what tells those
 * two apart, and the failure rows below do not carry it — they fall back
 * to the sweep reading, which is what a cross-tenant failure is.
 */
function Tenant({
  utilityId,
  utilityName,
  tenancy,
}: {
  utilityId: string | null;
  utilityName: string | null;
  tenancy?: "all-tenants" | "per-tenant";
}) {
  if (utilityName) {
    return <strong style={{ color: "var(--text-primary)" }}>{utilityName}</strong>;
  }
  if (utilityId) {
    return (
      <span style={{ color: "var(--warning)" }} title={utilityId}>
        {/* Both ends, because the seeded and test tenants differ only in
            their last few characters — the leading eight are zeroes on
            every one of them, so a head-only truncation told them
            apart not at all. */}
        {`Unknown tenant ${utilityId.slice(0, 8)}…${utilityId.slice(-4)}`}
      </span>
    );
  }
  if (tenancy === "per-tenant") {
    // Every job on this queue names a tenant. This one does not, so it
    // is malformed rather than shared.
    return <span style={{ color: "var(--danger)" }}>None named</span>;
  }
  return (
    <span
      style={{ color: "var(--text-muted)" }}
      title="A scheduled sweep: one job, running across every tenant"
    >
      All tenants
    </span>
  );
}

/**
 * A count in its column, clickable when there is anything behind it.
 *
 * Zero is not a button: there is nothing to open, and a row of five
 * controls that mostly do nothing trains the eye to ignore them. The
 * state's name rides along for a screen reader, where the column header
 * is not adjacent the way it is on screen.
 */
function Count({
  label,
  value,
  loud,
  open,
  onOpen,
}: {
  label: string;
  value: number;
  loud?: boolean;
  open: boolean;
  onOpen: () => void;
}) {
  if (value === 0) {
    return (
      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>
        0<span className="sr-only"> {label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      style={{
        background: "transparent",
        border: "none",
        borderBottom: open ? "1px solid var(--accent-primary)" : "1px dotted var(--border)",
        padding: 0,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: 600,
        color: loud ? "var(--danger)" : "var(--accent-primary)",
        cursor: "pointer",
      }}
    >
      {value}
      <span className="sr-only"> {label}</span>
    </button>
  );
}

/** Who is attached to one queue, in its own column. */
function WorkerCell({ queue }: { queue: QueueHealth }) {
  if (queue.workers === null) {
    /* A managed Redis refuses CLIENT LIST. "No workers" would send an
       operator chasing a worker that is running fine. */
    return <span style={{ fontSize: 12, color: "var(--text-muted)" }}>unknown</span>;
  }
  if (queue.workers === 0) {
    return <span style={{ fontSize: 12, color: "var(--warning)" }}>none</span>;
  }

  const recent =
    queue.workerAgeSeconds !== null && queue.workerAgeSeconds < RECENTLY_ATTACHED_SECONDS
      ? ` · attached ${shortAge(queue.workerAgeSeconds)} ago`
      : "";

  return (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
      <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
        {queue.workers}
      </span>
      {recent}
    </span>
  );
}

/** One job-sized action, or a worker-sized one. */
function Verb({
  label,
  busy,
  onClick,
  loud,
  ariaLabel,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
  loud?: boolean;
  /**
   * What the button is called when the row it sits in is not available
   * to say it. Several rows each hold a "Stop", and "Stop" alone does not
   * tell a screen reader which node it belongs to.
   */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={busy}
      style={{
        padding: "4px 12px",
        borderRadius: "var(--radius)",
        border: `1px solid ${loud ? "var(--danger)" : "var(--border)"}`,
        background: "transparent",
        color: loud ? "var(--danger)" : "var(--text-primary)",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: busy ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? "…" : label}
    </button>
  );
}

type ActionName = "retry" | "promote" | "replay";

/**
 * The verb a state admits, in one place so the column header and the
 * cell cannot drift apart. Nothing for a waiting or active job: neither
 * needs pushing, and a button that only ever answers 409 is noise.
 */
function verbFor(state: JobState): { label: string; action: ActionName } | null {
  if (state === "failed") return { label: "Retry", action: "retry" };
  if (state === "delayed") return { label: "Run now", action: "promote" };
  if (state === "dlq") return { label: "Replay", action: "replay" };
  return null;
}

const ALL_STATES: readonly JobState[] = ["waiting", "active", "delayed", "failed", "dlq"];

interface JobColumn {
  header: string;
  /** The states this column means something in. */
  states: readonly JobState[];
  align?: "right";
  render: (job: QueueJob) => React.ReactNode;
}

const DASH = <span style={{ color: "var(--text-muted)" }}>—</span>;

/**
 * The job list's columns, declared once.
 *
 * It was a bare row of values — a tenant, a job name, two timestamps and
 * a number, in a flex row with no headers — and the first thing asked of
 * it was what those columns were. Header and cell come from the same
 * entry here so a state can never grow a labelled column it does not
 * fill, or fill one it does not label.
 */
const JOB_COLUMNS: readonly JobColumn[] = [
  {
    header: "Tenant",
    states: ALL_STATES,
    render: (job) => (
      <Tenant utilityId={job.utilityId} utilityName={job.utilityName} tenancy={job.tenancy} />
    ),
  },
  {
    header: "Job",
    states: ALL_STATES,
    render: (job) => (
      <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>
        {job.jobName}
        {job.jobId ? ` #${job.jobId}` : ""}
      </span>
    ),
  },
  {
    header: "Queued",
    states: ALL_STATES,
    render: (job) => (job.enqueuedAt ? new Date(job.enqueuedAt).toLocaleString() : DASH),
  },
  {
    header: "Due",
    states: ["delayed"],
    render: (job) =>
      job.runsAt ? (
        <span
          style={{ color: isOverdue(job.runsAt) ? "var(--warning)" : "var(--text-secondary)" }}
        >
          {new Date(job.runsAt).toLocaleString()}
          {isOverdue(job.runsAt) ? " — overdue" : ""}
        </span>
      ) : (
        DASH
      ),
  },
  {
    header: "Repeats",
    states: ["delayed"],
    // A repeatable job is the scheduler at rest; a delayed one without a
    // pattern is a retry backing off, and they read identically as a count.
    render: (job) =>
      job.repeats ? (
        <span style={{ fontFamily: "monospace", color: "var(--accent-primary)" }}>
          {job.repeats}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>one-off</span>
      ),
  },
  {
    header: "Attempts",
    states: ALL_STATES,
    align: "right",
    render: (job) => (job.attemptsMade > 0 ? job.attemptsMade : DASH),
  },
  {
    header: "Reason",
    states: ["failed", "dlq"],
    render: (job) =>
      job.reason ?? <span style={{ color: "var(--text-muted)" }}>No reason recorded</span>,
  },
];

/**
 * What is already wrong with a job, in any state — added to the columns
 * only when at least one job in the list has something wrong with it.
 *
 * Conditional because a column of dashes teaches the reader to ignore
 * the column, and most lists have nothing to put in it. When it does
 * appear, every row that can never run is named on its own line instead
 * of the operator having to cross-check payloads they are not shown.
 */
const PROBLEM_COLUMN: JobColumn = {
  header: "Problem",
  states: ALL_STATES,
  render: (job) =>
    job.invalid ? <span style={{ color: "var(--danger)" }}>{job.invalid}</span> : DASH,
};

const cellStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 12,
  borderTop: "1px solid var(--border-subtle)",
  verticalAlign: "top",
};

function Th({
  children,
  align,
  width,
}: {
  children?: React.ReactNode;
  align?: "right";
  width?: number;
}) {
  return (
    <th
      scope="col"
      style={{
        padding: "8px 14px",
        textAlign: align ?? "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
        width,
      }}
    >
      {children}
    </th>
  );
}

export default function PlatformQueuesPage() {
  const [report, setReport] = useState<QueueHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which single count is open: at most one, so the page stays a page. */
  const [open, setOpen] = useState<{ queue: string; state: JobState } | null>(null);
  const [jobs, setJobs] = useState<QueueJobsResult | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  /** Per job: what the last verb used on it came back with. */
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);
  const [workerBusy, setWorkerBusy] = useState(false);
  const [workerSaid, setWorkerSaid] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiClient
      .get<QueueHealthReport>("/api/v1/platform/queues")
      .then((data) => {
        if (live) setReport(data);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Failed to load queues");
      });
    return () => {
      live = false;
    };
  }, []);

  function toggle(queue: string, state: JobState) {
    if (open?.queue === queue && open.state === state) {
      setOpen(null);
      setJobs(null);
      return;
    }
    setOpen({ queue, state });
    setJobs(null);
    setJobsError(null);
    apiClient
      .get<QueueJobsResult>(`/api/v1/platform/queues/${queue}/jobs`, {
        state,
        limit: String(JOBS_PER_OPEN),
      })
      .then(setJobs)
      .catch((err) => setJobsError(err instanceof Error ? err.message : "Failed to load jobs"));
  }

  /**
   * The verb, and what it reports back.
   *
   * The counts behind this are a snapshot, so a job can move between the
   * list being drawn and the button being pressed — a 409 saying so is
   * the normal case, not an error worth a toast. It is shown on the row
   * it belongs to.
   */
  async function act(queue: string, job: QueueJob, action: ActionName) {
    const key = `${queue}:${job.jobId}`;
    setActing(key);
    setOutcome((o) => ({ ...o, [key]: "" }));
    try {
      const res = await apiClient.post<{ audited: boolean }>(
        `/api/v1/platform/queues/${queue}/jobs/${job.jobId}/${action}`,
        {},
      );
      const done = action === "retry" ? "Retried" : action === "promote" ? "Promoted" : "Replayed";
      setOutcome((o) => ({
        ...o,
        // The audit half is said out loud: a sweep names no tenant, and
        // `audit_log` needs one, so some of these actions genuinely
        // cannot be put on the record.
        [key]: res.audited ? `${done} — recorded` : `${done} — not recorded`,
      }));
    } catch (err) {
      setOutcome((o) => ({ ...o, [key]: err instanceof Error ? err.message : "Failed" }));
    } finally {
      setActing(null);
    }
  }

  /**
   * Start a worker on the node serving this page.
   *
   * No node parameter, because nothing portable starts a process on
   * another machine — the request lands wherever the load balancer sent
   * it, and the button says which node that is rather than implying a
   * choice. One worker per node is a constraint, not a policy: a second
   * one would fail to bind the health port.
   *
   * The whole queue set, every time. The endpoint does take a subset —
   * the same selection `WORKER_QUEUES` already offers a replica — which
   * is how the billing-runs split would be expressed when it is needed.
   */
  async function startWorker() {
    setWorkerBusy(true);
    setWorkerSaid(null);
    try {
      const started = await apiClient.post<WorkerView>("/api/v1/platform/workers/start", {
        queues: [],
      });
      setReport((r) => (r ? { ...r, workers: [...r.workers, started] } : r));
      setWorkerSaid(`Started — pid ${started.pid} on ${started.node}`);
    } catch (err) {
      setWorkerSaid(err instanceof Error ? err.message : "Failed");
    } finally {
      setWorkerBusy(false);
    }
  }

  /** Stop one worker, named by its own id. */
  async function stopWorker(id: string) {
    setWorkerBusy(true);
    setWorkerSaid(null);
    try {
      const result = await apiClient.post<StopResult>(
        `/api/v1/platform/workers/${id}/stop`,
        {},
      );

      if (!result.drained) {
        /* The fallback fired: the worker never answered its own HTTP
           server, so it got a signal — which on Windows cuts in-flight
           jobs off, to be retried once their locks expire. */
        setWorkerSaid(
          "Stopped abruptly — the worker could not be reached to drain, so anything in flight will be retried after its lock expires.",
        );
      } else {
        setWorkerSaid(
          result.stopping
            ? "Draining — it will finish its in-flight jobs and then exit."
            : "Stopped.",
        );
      }

      // Gone only when the process has actually left; a drain can take a
      // minute, and the next status read is what notices.
      if (!result.stopping) {
        setReport((r) => (r ? { ...r, workers: r.workers.filter((w) => w.id !== id) } : r));
      }
    } catch (err) {
      setWorkerSaid(err instanceof Error ? err.message : "Failed");
    } finally {
      setWorkerBusy(false);
    }
  }

  const queues = report?.queues ?? [];
  const workers = report?.workers ?? [];
  /** A worker this node spawned, if any. At most one — the health port. */
  const ourWorker = workers.find((w) => w.node === report?.thisNode);
  /**
   * One row per node: every node Redis reports as connected, plus any
   * node that holds a worker record.
   *
   * The union matters. A node that has dropped off the client list still
   * has its worker in the registry, and that is precisely when it must
   * stay on screen rather than vanish — so such a row is marked rather
   * than omitted.
   */
  const nodeRows = [
    ...new Set([...(report?.nodes ?? []).map((n) => n.host), ...workers.map((w) => w.node)]),
  ].map((host) => ({
    host,
    connected: report?.nodes?.some((n) => n.host === host) ?? false,
    // At most one per node: a second would fail to bind the health port.
    worker: workers.find((w) => w.node === host),
  }));
  const unattendedNodes = nodeRows.filter((r) => !r.worker).length;
  const unattended = queues.filter((q) => q.workers === 0);
  const unknownWorkers = queues.filter((q) => q.workers === null);
  const paused = queues.filter((q) => q.paused);
  const attachedSomewhere = queues.some((q) => (q.workers ?? 0) > 0);
  const failing = (report?.totals.failed ?? 0) > 0 || (report?.totals.dlq ?? 0) > 0;
  const allUnattended = queues.length > 0 && unattended.length === queues.length;
  /**
   * What a newly started worker would pick up at once, per queue.
   *
   * Named rather than totalled. "5 queued jobs will start running" tells
   * the reader nothing they can act on — which queues, and therefore
   * what kind of work, is the whole content of the warning.
   */
  const queuedOnStart = queues
    .map((q) => ({ name: q.name, jobs: q.counts.waiting + q.counts.delayed }))
    .filter((q) => q.jobs > 0);
  const failures = troubledFirst(queues).flatMap((q) =>
    q.recentFailures.map((f) => ({ queue: q.name, failure: f })),
  );

  return (
    <div>
      <PageHeader
        title="Queues"
        subtitle="Background work across every tenant on this deployment"
      />

      {error && (
        <div
          style={{
            ...card,
            borderColor: "var(--danger)",
            padding: "12px 14px",
            marginBottom: 20,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {report && (
        <div style={{ ...card, marginBottom: 20, padding: "14px", fontSize: 13 }}>
              {!report.reachable ? (
                /* Never "all clear": an unanswered Redis and an idle one
                   produce the same zeroes, and only one of them is good
                   news. */
                <>
                  <strong style={{ color: "var(--warning)" }}>
                    The queues could not be read.
                  </strong>{" "}
                  Redis did not answer in time, so nothing here is known — this is not the same
                  as nothing being queued.
                </>
              ) : failing ? (
                <>
                  <strong style={{ color: "var(--danger)" }}>Needs attention.</strong>{" "}
                  {report.totals.failed} failed and {report.totals.dlq} dead-lettered across{" "}
                  {report.queues.length} queues.
                </>
              ) : allUnattended ? (
                /* The counts say nothing is wrong, and nothing can run.
                   This is the ordinary state of a dev stack, and it
                   looked identical to healthy until the worker count
                   arrived. */
                <>
                  <strong style={{ color: "var(--warning)" }}>Nothing is running.</strong> No
                  worker process is attached to any of the {report.queues.length} queues
                  {report.totals.waiting > 0
                    ? `, and ${report.totals.waiting} ${plural(report.totals.waiting, "job is", "jobs are")} waiting.`
                    : "."}
                </>
              ) : unattended.length > 0 ? (
                <>
                  <strong style={{ color: "var(--warning)" }}>Partly unattended.</strong>{" "}
                  {unattended.length} of {report.queues.length} queues{" "}
                  {plural(unattended.length, "has", "have")} no worker attached:{" "}
                  {unattended.map((q) => q.name).join(", ")}.
                </>
              ) : paused.length > 0 ? (
                <>
                  <strong style={{ color: "var(--danger)" }}>
                    {plural(paused.length, "A queue is paused.", "Queues are paused.")}
                  </strong>{" "}
                  {paused.map((q) => q.name).join(", ")} {plural(paused.length, "is", "are")}{" "}
                  paused, so nothing in {plural(paused.length, "it", "them")} will run however
                  many workers are attached.
                </>
              ) : (
                <>
                  <strong style={{ color: "var(--success)" }}>All clear.</strong> Nothing failed
                  or dead-lettered across {report.queues.length} queues
                  {report.totals.active + report.totals.waiting > 0
                    ? `, ${report.totals.active} running and ${report.totals.waiting} waiting.`
                    : "."}
                </>
              )}

              {/* The two facts are independent: a failure must not bury
                  the reason its retry will not run either. */}
              {report.reachable && failing && unattended.length > 0 && (
                <div style={{ marginTop: 6, color: "var(--warning)" }}>
                  No worker is attached to {unattended.map((q) => q.name).join(", ")}, so
                  nothing there will run — a retry included.
                </div>
              )}

              {report.reachable && unknownWorkers.length > 0 && (
                <div style={{ marginTop: 6, color: "var(--text-muted)" }}>
                  Worker attachment could not be read for {unknownWorkers.length} of{" "}
                  {report.queues.length} queues — this Redis does not allow listing its clients.
                </div>
              )}
        </div>
      )}

      {/*
       * The nodes, and the worker on each.
       *
       * A table at any node count, rather than a sentence for one node
       * and a table for several: one layout to learn, and a single code
       * path. Its own card, because five columns do not fit the 340px
       * column this lived in — where it rendered as an unlabelled run of
       * values, which is the same fault the job list had before it got
       * headers.
       *
       * One row per node, never a tree. A deployment may have a worker
       * per API node, and the version that kept one record let the first
       * node that started one block every other node from starting any.
       */}
      {report && (
        <div style={{ ...card, marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "baseline",
              justifyContent: "space-between",
              flexWrap: "wrap",
              padding: "10px 14px",
              background: "var(--bg-elevated)",
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "var(--text-muted)",
              }}
            >
              Worker processes
            </span>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {nodeRows.length} {plural(nodeRows.length, "node", "nodes")} ·{" "}
              {workers.length} {plural(workers.length, "worker", "workers")}
              {unattendedNodes > 0 && (
                <span style={{ color: "var(--warning)" }}>
                  {" "}
                  · {unattendedNodes} with none
                </span>
              )}
            </span>
          </div>

          {report.nodes === null ? (
            /* A managed Redis refuses CLIENT LIST, which is where the
               node list comes from. "No nodes" is never true of a
               deployment that is serving this page, so the table is
               replaced rather than drawn empty. */
            <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
              The API nodes could not be listed — this Redis does not allow reading its clients.
              Any worker below is still reported from its own record.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <Th>Node</Th>
                    <Th>Worker</Th>
                    <Th>State</Th>
                    <Th>Since</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {nodeRows.map(({ host, connected, worker }) => {
                    const here = host === report.thisNode;
                    return (
                      <tr key={host}>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          <span
                            style={{ fontFamily: "monospace", color: "var(--text-primary)" }}
                          >
                            {host}
                          </span>
                          {here && (
                            /* A start lands on whichever node the load
                               balancer picked, so which one that is has to
                               be visible rather than surprising. */
                            <span style={{ color: "var(--accent-primary)", marginLeft: 8 }}>
                              serving this page
                            </span>
                          )}
                          {!connected && (
                            /* Holds a worker record but is not in the
                               client list: the node has gone while its
                               worker's record remains, which is exactly
                               when it must not vanish from the table. */
                            <span style={{ color: "var(--danger)", marginLeft: 8 }}>
                              not connected
                            </span>
                          )}
                        </td>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          {worker ? (
                            <span style={{ fontFamily: "monospace" }}>pid {worker.pid}</span>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          {!worker ? (
                            <span style={{ color: "var(--warning)" }}>no worker</span>
                          ) : worker.attached ? (
                            <span style={{ color: "var(--success)" }}>attached</span>
                          ) : (
                            /* Either still opening its connections, or
                               gone on a node whose pid this one cannot
                               check. Both are worth seeing; neither is
                               "running". */
                            <span style={{ color: "var(--warning)" }}>not attached</span>
                          )}
                        </td>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          {worker ? new Date(worker.startedAt).toLocaleString() : DASH}
                        </td>
                        <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          {worker && worker.stoppable ? (
                            <Verb
                              label="Stop"
                              ariaLabel={`Stop worker on ${host}`}
                              loud
                              busy={workerBusy}
                              onClick={() => stopWorker(worker.id)}
                            />
                          ) : worker ? (
                            /* A pid means nothing off its host, so a
                               button here could only ever answer 409.
                               Routing the command through Redis is the
                               next step of the design; until then this
                               says where to go. */
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                              stop it from {host}
                            </span>
                          ) : here && report.controllable ? (
                            <Verb
                              label="Start"
                              ariaLabel={`Start worker on ${host}`}
                              busy={workerBusy}
                              onClick={startWorker}
                            />
                          ) : (
                            DASH
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/*
           * The notes, under the table and naming the node they are
           * about. They used to sit below every node at once, so with
           * three nodes the log path of the one worker read as if it
           * belonged to a node that had none.
           */}
          <div
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border-subtle)",
              display: "grid",
              gap: 4,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {!report.controllable ? (
              <div>
                Workers are a separate deployment here, so starting one from this console is
                disabled — scale the worker deployment instead.
              </div>
            ) : ourWorker ? (
              <>
                {/* Asked over the worker's own HTTP server, which is the
                    one stop path that drains on both Windows and Linux —
                    a signal on Windows is an unconditional termination
                    that skips the handler entirely. */}
                <div>Stopping asks the worker to finish what it is holding first.</div>
                <div style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  {ourWorker.node}&rsquo;s log: {ourWorker.logFile}
                </div>
              </>
            ) : attachedSomewhere && workers.length === 0 ? (
              <div>
                A worker is attached but was not started from here — it has no record, so there
                is nothing for this console to stop.
              </div>
            ) : (
              <>
                <div>
                  Start acts on {report.thisNode}, the node serving this page — nothing portable
                  starts a process on another machine. It serves all {report.queues.length}{" "}
                  {plural(report.queues.length, "queue", "queues")} and outlives this API
                  process, so a reload will not stop it.
                </div>
                {queuedOnStart.length > 0 && (
                  /*
                   * What pressing it will set off, in the only terms that
                   * are actionable: which queues, and how much in each.
                   * Whether that matters depends entirely on which queue.
                   */
                  <div style={{ color: "var(--warning)" }}>
                    Work already queued starts running at once:{" "}
                    <span style={{ fontFamily: "monospace" }}>
                      {queuedOnStart.map((q) => `${q.name} ${q.jobs}`).join(", ")}
                    </span>
                    . Click a count in the table below to see the jobs first.
                  </div>
                )}
              </>
            )}

            {workerSaid && (
              <div
                style={{
                  color: /^(Started|Stopped\.|Draining)/.test(workerSaid)
                    ? "var(--success)"
                    : "var(--danger)",
                }}
              >
                {workerSaid}
              </div>
            )}
          </div>
        </div>
      )}

      {report?.reachable && (
        <div style={{ ...card, marginBottom: 20, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <Th>Queue</Th>
                <Th>Workers</Th>
                <Th align="right">Waiting</Th>
                <Th align="right">Active</Th>
                <Th align="right">Delayed</Th>
                <Th align="right">Failed</Th>
                <Th align="right">Dead-lettered</Th>
              </tr>
            </thead>
            <tbody>
              {troubledFirst(report.queues).map((q) => {
                const isOpen = open?.queue === q.name;
                const verb = isOpen && open ? verbFor(open.state) : null;
                const columns =
                  isOpen && open
                    ? [
                        ...JOB_COLUMNS.filter((c) => c.states.includes(open.state)),
                        ...(jobs?.jobs.some((j) => j.invalid) ? [PROBLEM_COLUMN] : []),
                      ]
                    : [];

                return (
                  /* The queue's row and its expanded drill-down are two
                     <tr>s, so the key belongs on the fragment holding
                     both — React cannot see one on a child of a bare
                     fragment. */
                  <Fragment key={q.name}>
                    <tr>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        <span
                          style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 500 }}
                        >
                          {q.name}
                        </span>
                        {q.paused && (
                          <span style={{ color: "var(--danger)", marginLeft: 8 }}>paused</span>
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        <WorkerCell queue={q} />
                      </td>
                      {(
                        [
                          ["waiting", q.counts.waiting, false],
                          ["active", q.counts.active, false],
                          ["delayed", q.counts.delayed, false],
                          ["failed", q.counts.failed, true],
                          ["dlq", q.dlqDepth, true],
                        ] as [JobState, number, boolean][]
                      ).map(([state, value, loud]) => (
                        <td key={state} style={{ ...cellStyle, textAlign: "right" }}>
                          <Count
                            label={state === "dlq" ? "dead-lettered" : state}
                            value={value}
                            loud={loud}
                            open={isOpen && open?.state === state}
                            onOpen={() => toggle(q.name, state)}
                          />
                        </td>
                      ))}
                    </tr>

                    {isOpen && open && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            borderTop: "1px solid var(--accent-primary)",
                            background: "var(--bg-elevated)",
                            padding: 0,
                          }}
                        >
                          {jobsError && (
                            <div
                              style={{ padding: "8px 14px", fontSize: 12, color: "var(--danger)" }}
                            >
                              {jobsError}
                            </div>
                          )}
                          {!jobs && !jobsError && (
                            <div
                              style={{
                                padding: "8px 14px",
                                fontSize: 12,
                                color: "var(--text-muted)",
                              }}
                            >
                              Reading {open.state === "dlq" ? "dead-lettered" : open.state} jobs…
                            </div>
                          )}
                          {jobs && !jobs.reachable && (
                            <div
                              style={{
                                padding: "8px 14px",
                                fontSize: 12,
                                color: "var(--warning)",
                              }}
                            >
                              Could not be read — Redis did not answer.
                            </div>
                          )}
                          {jobs?.reachable && jobs.jobs.length === 0 && (
                            <div
                              style={{
                                padding: "8px 14px",
                                fontSize: 12,
                                color: "var(--text-muted)",
                              }}
                            >
                              {/* The count came from a snapshot a moment
                                  earlier, so an empty list here means the
                                  jobs moved on, not that the count lied. */}
                              Nothing there now — the jobs moved on since the count was taken.
                            </div>
                          )}
                          {jobs?.reachable && jobs.jobs.length > 0 && (
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                              <caption
                                style={{
                                  captionSide: "top",
                                  padding: "8px 14px 0",
                                  textAlign: "left",
                                  fontSize: 12,
                                  color: "var(--text-muted)",
                                }}
                              >
                                {jobs.jobs.length}{" "}
                                {open.state === "dlq" ? "dead-lettered" : open.state}{" "}
                                {plural(jobs.jobs.length, "job", "jobs")} in {q.name}
                              </caption>
                              <thead>
                                <tr>
                                  {columns.map((c) => (
                                    <Th key={c.header} align={c.align}>
                                      {c.header}
                                    </Th>
                                  ))}
                                  {verb && <Th align="right">Action</Th>}
                                </tr>
                              </thead>
                              <tbody>
                                {jobs.jobs.map((j) => {
                                  const key = `${q.name}:${j.jobId}`;
                                  const said = outcome[key];
                                  return (
                                    <tr key={`${j.jobId}-${j.enqueuedAt}`}>
                                      {columns.map((c) => (
                                        <td
                                          key={c.header}
                                          style={{
                                            ...cellStyle,
                                            textAlign: c.align ?? "left",
                                          }}
                                        >
                                          {c.render(j)}
                                        </td>
                                      ))}
                                      {verb && (
                                        <td
                                          style={{
                                            ...cellStyle,
                                            textAlign: "right",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          <span
                                            style={{
                                              display: "inline-flex",
                                              gap: 6,
                                              alignItems: "center",
                                            }}
                                          >
                                            {said && (
                                              <span
                                                style={{
                                                  color: said.includes("not recorded")
                                                    ? "var(--warning)"
                                                    : /^(Retried|Promoted|Replayed)/.test(said)
                                                      ? "var(--success)"
                                                      : "var(--danger)",
                                                }}
                                              >
                                                {said}
                                              </span>
                                            )}
                                            <Verb
                                              label={verb.label}
                                              busy={acting === key}
                                              onClick={() => act(q.name, j, verb.action)}
                                            />
                                          </span>
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/*
       * Recent failures, gathered rather than scattered.
       *
       * They used to hang under each queue's card, so reading "what has
       * been failing" meant scrolling eight of them. Across queues and
       * newest-first is the question actually being asked.
       */}
      {failures.length > 0 && (
        <div style={{ ...card, marginBottom: 20 }}>
          <div
            style={{
              padding: "8px 14px",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-muted)",
              background: "var(--bg-elevated)",
            }}
          >
            Recent failures
          </div>
          {failures.map(({ queue, failure: f }) => (
            <div
              key={`${queue}-${f.jobId}-${f.failedAt}`}
              style={{
                padding: "8px 14px",
                borderTop: "1px solid var(--border-subtle)",
                display: "grid",
                gap: 2,
              }}
            >
              <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>
                  {queue}
                </span>
                {/* The tenant, which is the half Bull Board cannot show. */}
                <Tenant utilityId={f.utilityId} utilityName={f.utilityName} />
                <span style={{ color: "var(--text-muted)", fontFamily: "monospace" }}>
                  {f.jobName}
                  {f.jobId ? ` #${f.jobId}` : ""}
                </span>
                {f.failedAt && (
                  <span style={{ color: "var(--text-muted)" }}>
                    {new Date(f.failedAt).toLocaleString()}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {f.reason ?? "No reason recorded"}
              </div>
            </div>
          ))}
        </div>
      )}

      {/*
       * Bull Board is not linked, because the link cannot work.
       *
       * It is mounted at /admin/queues on the API host behind the same
       * `authMiddleware` as everything else, and that middleware reads
       * only the `authorization` header. A browser navigating to that URL
       * sends no header, so it answers `{"code":"UNAUTHORIZED"}` — which
       * is what a click on the button that used to be here produced.
       * Saying where it is and what it needs is worth more than a control
       * that always fails.
       */}
      <div
        style={{
          ...card,
          padding: "10px 14px",
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        Bull Board — full payloads and every verb — is mounted at{" "}
        <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
          {BULL_BOARD_URL}
        </span>
        , but it needs an operator token in an <code>Authorization</code> header, which a browser
        tab cannot send. Opening it from here would 401, so it is not linked.
      </div>
    </div>
  );
}
