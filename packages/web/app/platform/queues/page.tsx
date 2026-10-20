"use client";

import { useState, useEffect } from "react";
import { API_URL, apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Whether anything in the background is stuck, and whose.
 *
 * Bull Board lists every job and is the right tool for reading a payload
 * or retrying one. It cannot answer the question an operator arrives
 * with, because it has no notion of a tenant and no summary: a dead-
 * lettered billing run looks like any other row, and finding it means
 * knowing to look. Until now it was not even in the menu — reaching it
 * meant typing the URL on the API host.
 *
 * So this page is a verdict, not a console. One sentence when nothing is
 * wrong, the troubled queues first when something is, each failure named
 * with its tenant and reason.
 *
 * **The verdict counts workers, not just jobs.** Workers run in a
 * separate process from the API, and `start_dev.bat` deliberately does
 * not start them, so the ordinary state of a dev stack is queues filling
 * up with nothing attached to work them. Counts alone cannot tell that
 * apart from a healthy queue — the first version of this page said "All
 * clear" over 102 jobs that could never run.
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
    q.counts.failed > 0 || q.dlqDepth > 0 || q.workers === 0 || q.paused ? 0 : 1;
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
 * Three different facts, and the middle one used to be printed as a bare
 * uuid — indistinguishable from a tenant name nobody recognises. A
 * payload naming a tenant that no longer exists is a finding: it is a
 * job left behind, and nothing will ever claim it.
 */
function Tenant({ utilityId, utilityName }: { utilityId: string | null; utilityName: string | null }) {
  if (utilityName) {
    return <strong style={{ color: "var(--text-primary)" }}>{utilityName}</strong>;
  }
  if (utilityId) {
    return (
      <span style={{ color: "var(--warning)" }} title={utilityId}>
        {`Unknown tenant ${utilityId.slice(0, 8)}`}
      </span>
    );
  }
  // A sweep belongs to no one tenant, and saying so beats leaving the
  // column empty or guessing an owner.
  return <span style={{ color: "var(--text-muted)" }}>All tenants</span>;
}

/**
 * A count, clickable when there is anything behind it.
 *
 * Zero is not a button: there is nothing to open, and a row of five
 * controls that mostly do nothing trains the eye to ignore them.
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
  const colour = loud && value > 0 ? "var(--danger)" : "var(--text-primary)";

  if (value === 0) {
    return (
      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
        <strong style={{ fontFamily: "monospace", fontWeight: 500 }}>0</strong> {label}
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
        fontFamily: "inherit",
        fontSize: 12,
        color: "var(--text-secondary)",
        cursor: "pointer",
      }}
    >
      <strong style={{ fontFamily: "monospace", color: colour }}>{value}</strong> {label}
    </button>
  );
}

/** Who is attached to one queue, beside its name. */
function WorkerMark({ queue }: { queue: QueueHealth }) {
  const recent =
    queue.workerAgeSeconds !== null && queue.workerAgeSeconds < RECENTLY_ATTACHED_SECONDS
      ? ` · attached ${shortAge(queue.workerAgeSeconds)} ago`
      : "";

  return (
    <span style={{ display: "inline-flex", gap: 8, fontSize: 12 }}>
      {queue.workers === null ? (
        /* A managed Redis refuses CLIENT LIST. "No workers" would send
           an operator chasing a worker that is running fine. */
        <span style={{ color: "var(--text-muted)" }}>workers unknown</span>
      ) : queue.workers === 0 ? (
        <span style={{ color: "var(--warning)" }}>no worker</span>
      ) : (
        <span style={{ color: "var(--text-muted)" }}>
          {`${queue.workers} ${plural(queue.workers, "worker", "workers")}${recent}`}
        </span>
      )}
      {queue.paused && <span style={{ color: "var(--danger)" }}>paused</span>}
    </span>
  );
}

/** One job-sized action. */
function Verb({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        padding: "3px 10px",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        background: "transparent",
        color: "var(--text-primary)",
        fontFamily: "inherit",
        fontSize: 11,
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
    render: (job) => <Tenant utilityId={job.utilityId} utilityName={job.utilityName} />,
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
    render: (job) => job.reason ?? <span style={{ color: "var(--text-muted)" }}>No reason recorded</span>,
  },
];

const cellStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: 12,
  borderTop: "1px solid var(--border-subtle)",
  verticalAlign: "top",
};

function Th({ children, align }: { children?: React.ReactNode; align?: "right" }) {
  return (
    <th
      scope="col"
      style={{
        padding: "6px 14px",
        textAlign: align ?? "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        whiteSpace: "nowrap",
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
      .catch((err) =>
        setJobsError(err instanceof Error ? err.message : "Failed to load jobs"),
      );
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
      setOutcome((o) => ({
        ...o,
        [key]: err instanceof Error ? err.message : "Failed",
      }));
    } finally {
      setActing(null);
    }
  }

  const queues = report?.queues ?? [];
  const unattended = queues.filter((q) => q.workers === 0);
  const unknownWorkers = queues.filter((q) => q.workers === null);
  const paused = queues.filter((q) => q.paused);
  const failing = (report?.totals.failed ?? 0) > 0 || (report?.totals.dlq ?? 0) > 0;
  const allUnattended = queues.length > 0 && unattended.length === queues.length;
  const clear =
    report?.reachable && !failing && unattended.length === 0 && paused.length === 0;

  return (
    <div>
      <PageHeader
        title="Queues"
        subtitle="Background work across every tenant on this deployment"
      />

      {/*
       * Bull Board is not linked, because the link cannot work.
       *
       * It is mounted at /admin/queues on the API host behind the same
       * `authMiddleware` as everything else, and that middleware reads
       * only the `authorization` header. A browser navigating to that
       * URL sends no header, so it answers
       * `{"code":"UNAUTHORIZED"}` — which is what a click on the button
       * that used to be here produced. Saying where it is and what it
       * needs is worth more than a control that always fails.
       */}
      <div
        style={{
          ...card,
          padding: "10px 14px",
          marginBottom: 20,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        Bull Board — full payloads, retry and promote — is mounted at{" "}
        <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
          {BULL_BOARD_URL}
        </span>
        , but it needs an operator token in an <code>Authorization</code> header, which a browser
        tab cannot send. Opening it from here would 401, so it is not linked.
      </div>

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
        <div style={{ ...card, marginBottom: 20, padding: "12px 14px", fontSize: 13 }}>
          <div>
            {!report.reachable ? (
              /* Never "all clear": an unanswered Redis and an idle one
                 produce the same zeroes, and only one of them is good
                 news. */
              <>
                <strong style={{ color: "var(--warning)" }}>
                  The queues could not be read.
                </strong>{" "}
                Redis did not answer in time, so nothing here is known — this is not the same as
                nothing being queued.
              </>
            ) : failing ? (
              <>
                <strong style={{ color: "var(--danger)" }}>Needs attention.</strong>{" "}
                {report.totals.failed} failed and {report.totals.dlq} dead-lettered across{" "}
                {report.queues.length} queues.
              </>
            ) : allUnattended ? (
              /* The counts say nothing is wrong, and nothing can run.
                 This is the ordinary state of a dev stack, and it looked
                 identical to healthy until the worker count arrived. */
              <>
                <strong style={{ color: "var(--warning)" }}>Nothing is running.</strong> No worker
                process is attached to any of the {report.queues.length} queues
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
                {paused.map((q) => q.name).join(", ")} {plural(paused.length, "is", "are")} paused,
                so nothing in {plural(paused.length, "it", "them")} will run however many workers
                are attached.
              </>
            ) : (
              <>
                <strong style={{ color: "var(--success)" }}>All clear.</strong> Nothing failed or
                dead-lettered across {report.queues.length} queues
                {report.totals.active + report.totals.waiting > 0
                  ? `, ${report.totals.active} running and ${report.totals.waiting} waiting.`
                  : "."}
              </>
            )}
          </div>

          {/* The two facts are independent: a failure must not bury the
              reason its retry will not run either. */}
          {report.reachable && failing && unattended.length > 0 && (
            <div style={{ marginTop: 6, color: "var(--warning)" }}>
              No worker is attached to {unattended.map((q) => q.name).join(", ")}, so nothing
              there will run — a retry included.
            </div>
          )}

          {report.reachable && unknownWorkers.length > 0 && (
            <div style={{ marginTop: 6, color: "var(--text-muted)" }}>
              Worker attachment could not be read for {unknownWorkers.length} of{" "}
              {report.queues.length} queues — this Redis does not allow listing its clients.
            </div>
          )}

          {report.reachable && unattended.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
              Workers are a separate process from the API. In development:{" "}
              <span style={{ fontFamily: "monospace" }}>
                pnpm --filter @utility-cis/api dev:worker
              </span>
              .
            </div>
          )}
        </div>
      )}

      {report?.reachable &&
        troubledFirst(report.queues).map((q) => {
          const verb = open?.queue === q.name ? verbFor(open.state) : null;
          const columns =
            open?.queue === q.name
              ? JOB_COLUMNS.filter((c) => c.states.includes(open.state))
              : [];

          return (
            <div key={q.name} style={{ ...card, marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "10px 14px",
                  borderBottom:
                    q.recentFailures.length > 0 ? "1px solid var(--border-subtle)" : "none",
                }}
              >
                <span style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace" }}>
                    {q.name}
                  </span>
                  <WorkerMark queue={q} />
                </span>
                <span style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {(
                    [
                      ["waiting", q.counts.waiting, false],
                      ["active", q.counts.active, false],
                      ["delayed", q.counts.delayed, false],
                      ["failed", q.counts.failed, true],
                      ["dlq", q.dlqDepth, true],
                    ] as [JobState, number, boolean][]
                  ).map(([state, value, loud]) => (
                    <Count
                      key={state}
                      label={state === "dlq" ? "dead-lettered" : state}
                      value={value}
                      loud={loud}
                      open={open?.queue === q.name && open.state === state}
                      onOpen={() => toggle(q.name, state)}
                    />
                  ))}
                </span>
              </div>

              {open?.queue === q.name && (
                <div
                  style={{
                    borderTop: "1px solid var(--border-subtle)",
                    background: "var(--bg-elevated)",
                    overflowX: "auto",
                  }}
                >
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
                      {/* The count came from a snapshot a moment earlier,
                          so an empty list here means the jobs moved on,
                          not that the count lied. */}
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
                        {jobs.jobs.length} {open.state === "dlq" ? "dead-lettered" : open.state}{" "}
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
                                  style={{ ...cellStyle, textAlign: c.align ?? "left" }}
                                >
                                  {c.render(j)}
                                </td>
                              ))}
                              {verb && (
                                <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
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
                </div>
              )}

              {q.recentFailures.map((f) => (
                <div
                  key={`${f.jobId}-${f.failedAt}`}
                  style={{
                    padding: "8px 14px",
                    borderTop: "1px solid var(--border-subtle)",
                    display: "grid",
                    gap: 2,
                  }}
                >
                  <div style={{ fontSize: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
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
          );
        })}
    </div>
  );
}
