"use client";

import { useState } from "react";
import { API_URL, apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { useCluster } from "@/components/cluster/use-cluster";
import {
  card,
  CardHead,
  cellStyle,
  DASH,
  isOverdue,
  plural,
  shortAge,
  Tenant,
  Th,
  troubledFirst,
  Verb,
} from "@/components/cluster/ui";
import type {
  JobState,
  QueueHealth,
  QueueJob,
  QueueJobsResult,
} from "@/components/cluster/types";

/**
 * The eight queues, and the jobs behind any one count.
 *
 * Two tables, in two cards. They were one — the jobs rendered as a
 * `<tr><td colSpan={7}>` holding a second table *inside* the queue table,
 * so its header row landed among the queue rows and read as though those
 * columns described the queues beneath it. Two tables with different
 * columns cannot share one frame.
 */

const BULL_BOARD_URL = `${API_URL}/admin/queues`;

/** Twenty is a screenful; past that this is the wrong tool. */
const JOBS_PER_OPEN = 20;

/**
 * Below this, how long ago a worker attached is worth printing.
 *
 * A worker that reattaches every few seconds is crash-looping, and reads
 * as a healthy "1" without this. An hours-old connection's exact age
 * tells nobody anything, so it stays out.
 */
const RECENTLY_ATTACHED_SECONDS = 300;

type ActionName = "retry" | "promote" | "replay";

/**
 * The verb a state admits, in one place so the column header and the
 * cell cannot drift apart. Nothing for waiting, active or completed:
 * none needs pushing, and a button that only ever answers 409 is noise.
 */
function verbFor(state: JobState): { label: string; action: ActionName } | null {
  if (state === "failed") return { label: "Retry", action: "retry" };
  if (state === "delayed") return { label: "Run now", action: "promote" };
  if (state === "dlq") return { label: "Replay", action: "replay" };
  return null;
}

const ALL_STATES: readonly JobState[] = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
  "dlq",
];

interface JobColumn {
  header: string;
  /** The states this column means something in. */
  states: readonly JobState[];
  align?: "right";
  render: (job: QueueJob) => React.ReactNode;
}

/**
 * The job list's columns, declared once.
 *
 * It was a bare row of values — a tenant, a job name, two timestamps and
 * a number, in a flex row with no headers — and the first thing asked of
 * it was what those columns were. Header and cell come from the same
 * entry here, so a state can never grow a labelled column it does not
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
    states: ["waiting", "active", "delayed", "failed", "dlq"],
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
    header: "Ran at",
    states: ["completed"],
    render: (job) => (job.finishedAt ? new Date(job.finishedAt).toLocaleString() : DASH),
  },
  {
    header: "Took",
    states: ["completed"],
    align: "right",
    render: (job) =>
      job.durationMs === null ? (
        DASH
      ) : (
        <span style={{ fontFamily: "monospace" }}>
          {job.durationMs < 1000 ? `${job.durationMs}ms` : `${(job.durationMs / 1000).toFixed(1)}s`}
        </span>
      ),
  },
  {
    header: "Result",
    states: ["completed"],
    /*
     * What the handler returned — `{attempted, sent, failed}`,
     * `{deleted, batches}`, `{status, billedCount}`. For a quiet cron
     * queue this is the only evidence it is working: the handler logs
     * nothing on an empty tick, deliberately, at up to 8,640 ticks a day.
     * The API filters it to scalar fields, so an id cannot arrive here.
     */
    render: (job) =>
      job.result ? (
        <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>
          {Object.entries(job.result)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>nothing returned</span>
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
 * What is already wrong with a job — added only when at least one job in
 * the list has something wrong with it.
 *
 * Conditional because a column of dashes teaches the reader to ignore the
 * column, and most lists have nothing to put in it. When it does appear,
 * every row that can never run is named on its own line instead of the
 * operator having to cross-check payloads they are not shown.
 */
const PROBLEM_COLUMN: JobColumn = {
  header: "Problem",
  states: ALL_STATES,
  render: (job) =>
    job.invalid ? <span style={{ color: "var(--danger)" }}>{job.invalid}</span> : DASH,
};

/**
 * A count, clickable when there is anything behind it.
 *
 * Zero is not a button: there is nothing to open, and a row of six
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

export default function ClusterQueuesPage() {
  const { report, error } = useCluster();
  /** Which single count is open: at most one, so the page stays a page. */
  const [open, setOpen] = useState<{ queue: string; state: JobState } | null>(null);
  const [jobs, setJobs] = useState<QueueJobsResult | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  /** Per job: what the last verb used on it came back with. */
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

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

  const openColumns = open
    ? [
        ...JOB_COLUMNS.filter((c) => c.states.includes(open.state)),
        ...(jobs?.jobs.some((j) => j.invalid) ? [PROBLEM_COLUMN] : []),
      ]
    : [];
  const openVerb = open ? verbFor(open.state) : null;

  return (
    <div>
      <PageHeader
        title="Queues"
        subtitle="What is waiting, running, scheduled, failed and done — across every tenant"
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

      {report && !report.reachable && (
        /* Never an empty table: an unanswered Redis and an idle one
           produce the same zeroes, and only one of them is good news. */
        <div style={{ ...card, marginBottom: 20, padding: "12px 14px", fontSize: 13 }}>
          <strong style={{ color: "var(--warning)" }}>The queues could not be read.</strong>{" "}
          Redis did not answer in time, so nothing here is known — this is not the same as
          nothing being queued.
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
                <Th align="right">Completed</Th>
              </tr>
            </thead>
            <tbody>
              {troubledFirst(report.queues).map((q) => {
                const isOpen = open?.queue === q.name;

                return (
                  <tr
                    key={q.name}
                    style={
                      isOpen
                        ? /* Which count is open, now that the jobs are
                             shown below the table rather than inside it. */
                          { background: "var(--bg-elevated)" }
                        : undefined
                    }
                  >
                    <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                      <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 500 }}>
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
                        ["completed", q.counts.completed, false],
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div style={{ ...card, marginBottom: 20 }}>
          <CardHead
            left={
              <>
                <span style={{ fontFamily: "monospace", textTransform: "none" }}>
                  {open.queue}
                </span>
                {" · "}
                {open.state === "dlq" ? "dead-lettered" : open.state} jobs
              </>
            }
            right={
              <button
                type="button"
                onClick={() => {
                  setOpen(null);
                  setJobs(null);
                }}
                style={{
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "2px 10px",
                  fontFamily: "inherit",
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            }
          />

          {jobsError && (
            <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--danger)" }}>
              {jobsError}
            </div>
          )}
          {!jobs && !jobsError && (
            <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)" }}>
              Reading {open.state === "dlq" ? "dead-lettered" : open.state} jobs…
            </div>
          )}
          {jobs && !jobs.reachable && (
            <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--warning)" }}>
              Could not be read — Redis did not answer.
            </div>
          )}
          {jobs?.reachable && jobs.jobs.length === 0 && (
            <div style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)" }}>
              {/* The count came from a snapshot a moment earlier, so an
                  empty list here means the jobs moved on, not that the
                  count lied. */}
              Nothing there now — the jobs moved on since the count was taken.
            </div>
          )}
          {jobs?.reachable && jobs.jobs.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {openColumns.map((c) => (
                      <Th key={c.header} align={c.align}>
                        {c.header}
                      </Th>
                    ))}
                    {openVerb && <Th align="right">Action</Th>}
                  </tr>
                </thead>
                <tbody>
                  {jobs.jobs.map((j) => {
                    const key = `${open.queue}:${j.jobId}`;
                    const said = outcome[key];
                    return (
                      <tr key={`${j.jobId}-${j.enqueuedAt}-${j.finishedAt ?? ""}`}>
                        {openColumns.map((c) => (
                          <td
                            key={c.header}
                            style={{ ...cellStyle, textAlign: c.align ?? "left" }}
                          >
                            {c.render(j)}
                          </td>
                        ))}
                        {openVerb && (
                          <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                            <span
                              style={{ display: "inline-flex", gap: 6, alignItems: "center" }}
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
                                label={openVerb.label}
                                ariaLabel={`${openVerb.label} job ${j.jobId ?? ""} in ${open.queue}`}
                                busy={acting === key}
                                onClick={() => act(open.queue, j, openVerb.action)}
                              />
                            </span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
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
      <div style={{ ...card, padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)" }}>
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
