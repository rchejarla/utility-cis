"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { FilterBar } from "@/components/ui/filter-bar";
import { useCluster } from "@/components/cluster/use-cluster";
import {
  card,
  CardHead,
  cellStyle,
  DASH,
  isOverdue,
  plural,
  Tenant,
  Th,
  Verb,
} from "@/components/cluster/ui";
import type { JobState, QueueJob, QueueJobsResult } from "@/components/cluster/types";

/**
 * The jobs in one queue and one state.
 *
 * Its own page rather than a panel under the queue table. The drill-down
 * was first a table nested inside that table — its header row landed
 * among the queue rows and read as though it described them — and then a
 * table directly below it, where the only thing tying the two together
 * was a tinted row that scrolls out of view. The rest of this app answers
 * list-to-detail with a route (`/billing-runs` → `/billing-runs/[id]`),
 * and this is that.
 *
 * Queue and status are filters rather than a route segment, because an
 * operator reading failed billing runs usually wants failed imports next,
 * not a trip back to the list. Both live in the URL, so the page is
 * shareable — "here are the failed billing runs" — and the browser's back
 * button replaces the Close control this used to need.
 */

const STATES: readonly JobState[] = [
  "waiting",
  "active",
  "delayed",
  "failed",
  "completed",
  "dlq",
];

const STATE_LABELS: Record<JobState, string> = {
  waiting: "Waiting",
  active: "Active",
  delayed: "Delayed",
  failed: "Failed",
  completed: "Completed",
  dlq: "Dead-lettered",
};

/** A screenful. Past this, Bull Board is the tool. */
const JOBS_PER_PAGE = 20;

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

interface JobColumn {
  header: string;
  /** The states this column means something in. */
  states: readonly JobState[];
  align?: "right";
  render: (job: QueueJob) => React.ReactNode;
}

/**
 * The columns, declared once.
 *
 * This was a bare row of values — a tenant, a job name, two timestamps
 * and a number, in a flex row with no headers — and the first thing asked
 * of it was what those columns were. Header and cell come from the same
 * entry, so a state can never grow a labelled column it does not fill, or
 * fill one it does not label.
 */
const JOB_COLUMNS: readonly JobColumn[] = [
  {
    header: "Tenant",
    states: STATES,
    render: (job) => (
      <Tenant utilityId={job.utilityId} utilityName={job.utilityName} tenancy={job.tenancy} />
    ),
  },
  {
    header: "Job",
    states: STATES,
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
          {job.durationMs < 1000
            ? `${job.durationMs}ms`
            : `${(job.durationMs / 1000).toFixed(1)}s`}
        </span>
      ),
  },
  {
    header: "Result",
    states: ["completed"],
    /*
     * What the handler returned. For a quiet cron queue this is the only
     * evidence it is working at all: the handler logs nothing on an empty
     * tick, deliberately, at up to 8,640 ticks a day. The API filters it
     * to scalar fields, so an id cannot arrive here.
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
    states: STATES,
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
 * operator cross-checking payloads they are not shown.
 */
const PROBLEM_COLUMN: JobColumn = {
  header: "Problem",
  states: STATES,
  render: (job) =>
    job.invalid ? <span style={{ color: "var(--danger)" }}>{job.invalid}</span> : DASH,
};

function ClusterJobs() {
  const router = useRouter();
  const params = useSearchParams();
  const { report } = useCluster();

  const queueNames = (report?.queues ?? []).map((q) => q.name);
  /*
   * A queue must be named — the endpoint is per queue — so an absent or
   * unknown one falls back to the first rather than erroring. The links
   * from the Queues page always set both, so this only decides what a
   * bare visit from the menu shows.
   */
  const requestedQueue = params.get("queue");
  const queue =
    requestedQueue && queueNames.includes(requestedQueue) ? requestedQueue : queueNames[0];
  const requestedState = params.get("state") as JobState | null;
  const state: JobState =
    requestedState && STATES.includes(requestedState) ? requestedState : "waiting";

  const [jobs, setJobs] = useState<QueueJobsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!queue) return;
    let live = true;
    setJobs(null);
    setError(null);
    apiClient
      .get<QueueJobsResult>(`/api/v1/platform/queues/${queue}/jobs`, {
        state,
        limit: String(JOBS_PER_PAGE),
      })
      .then((data) => {
        if (live) setJobs(data);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Failed to load jobs");
      });
    return () => {
      live = false;
    };
  }, [queue, state]);

  /** Per job: what the last verb used on it came back with. */
  const [outcome, setOutcome] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  /**
   * The verb, and what it reports back.
   *
   * The counts behind this are a snapshot, so a job can move between the
   * list being drawn and the button being pressed — a 409 saying so is
   * the normal case, not an error worth a toast. It is shown on the row
   * it belongs to.
   */
  async function act(job: QueueJob, action: ActionName) {
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

  function go(next: { queue?: string; state?: string }) {
    const q = next.queue ?? queue ?? "";
    const s = next.state ?? state;
    router.push(`/platform/cluster/jobs?queue=${encodeURIComponent(q)}&state=${s}`);
  }

  /*
   * The counts ride along in the filter labels. "failed (2)" is the
   * whole reason to open a filter — otherwise choosing a queue is
   * guesswork, and most combinations are empty.
   */
  const health = report?.queues.find((q) => q.name === queue);
  const countFor = (s: JobState): number | null => {
    if (!health) return null;
    if (s === "dlq") return health.dlqDepth;
    return health.counts[s as keyof typeof health.counts] ?? 0;
  };

  const columns = [
    ...JOB_COLUMNS.filter((c) => c.states.includes(state)),
    ...(jobs?.jobs.some((j) => j.invalid) ? [PROBLEM_COLUMN] : []),
  ];
  const verb = verbFor(state);

  return (
    <div>
      <PageHeader title="Jobs" subtitle="What is in one queue, in one state" />

      <div style={{ marginBottom: 12, fontSize: 12 }}>
        <Link href="/platform/cluster/queues" style={{ color: "var(--accent-primary)" }}>
          ← All queues
        </Link>
      </div>

      <div style={{ marginBottom: 16 }}>
        <FilterBar
          filters={[
            {
              key: "queue",
              label: "Queue",
              value: queue,
              options: (report?.queues ?? []).map((q) => ({
                value: q.name,
                label: q.name,
              })),
              onChange: (value) => value && go({ queue: value }),
            },
            {
              key: "state",
              label: "Status",
              value: state,
              options: STATES.map((s) => {
                const n = countFor(s);
                return {
                  value: s,
                  label: n === null ? STATE_LABELS[s] : `${STATE_LABELS[s]} (${n})`,
                };
              }),
              onChange: (value) => value && go({ state: value }),
            },
          ]}
        />
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

      <div style={{ ...card, marginBottom: 20 }}>
        <CardHead
          left={
            <>
              <span style={{ fontFamily: "monospace", textTransform: "none" }}>
                {queue ?? "no queue"}
              </span>
              {" · "}
              {STATE_LABELS[state].toLowerCase()}
            </>
          }
          right={
            jobs?.reachable
              ? `${jobs.jobs.length} ${plural(jobs.jobs.length, "job", "jobs")}`
              : undefined
          }
        />

        {!jobs && !error && (
          <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
            Reading {STATE_LABELS[state].toLowerCase()} jobs…
          </div>
        )}
        {jobs && !jobs.reachable && (
          <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--warning)" }}>
            Could not be read — Redis did not answer. This is not the same as nothing being
            there.
          </div>
        )}
        {jobs?.reachable && jobs.jobs.length === 0 && (
          <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
            {/* The count came from a snapshot a moment earlier, so an
                empty list here means the jobs moved on, not that the
                count lied. */}
            Nothing {STATE_LABELS[state].toLowerCase()} in {queue} — either there never was, or
            the jobs moved on since the count was taken.
          </div>
        )}
        {jobs?.reachable && jobs.jobs.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                  const key = `${queue}:${j.jobId}`;
                  const said = outcome[key];
                  return (
                    <tr key={`${j.jobId}-${j.enqueuedAt}-${j.finishedAt ?? ""}`}>
                      {columns.map((c) => (
                        <td key={c.header} style={{ ...cellStyle, textAlign: c.align ?? "left" }}>
                          {c.render(j)}
                        </td>
                      ))}
                      {verb && (
                        <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
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
                              ariaLabel={`${verb.label} job ${j.jobId ?? ""} in ${queue}`}
                              busy={acting === key}
                              onClick={() => act(j, verb.action)}
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
    </div>
  );
}

/**
 * `useSearchParams` makes this page client-rendered; the boundary is
 * what keeps Next from complaining about it during the build.
 */
export default function ClusterJobsPage() {
  return (
    <Suspense fallback={null}>
      <ClusterJobs />
    </Suspense>
  );
}
