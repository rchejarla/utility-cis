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
  Clipped,
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

/** A screenful. Pages beyond it are reachable; a hundred rows is not. */
const JOBS_PER_PAGE = 20;

/**
 * Every queue at once — the same sentinel the API takes, and the one
 * `WORKER_QUEUES` already uses.
 *
 * "Where are all the failures" is a question about the deployment, and
 * making the operator try eight queues in turn is not an answer. Merged
 * newest-first, which is why each row then has to say which queue it
 * came from.
 */
const ALL_QUEUES = "all";

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
  /** Only shown when several queues are merged into one list. */
  mergedOnly?: boolean;
  align?: "right";
  /**
   * When this column is dropped: `md` below 1499px of viewport, `sm`
   * below 959 — which are the layout widths times the root zoom, see
   * globals.css.
   *
   * Two tiers because this table runs to ten columns, and one tier meant
   * it carried all ten until the viewport reached phone width: on a
   * display where a window that looks narrow still reports a thousand
   * pixels, nothing ever dropped. Chosen by what the question cannot be
   * answered without, as globals.css asks — a tenant, a job id, why it
   * is stuck and what can be done about it stay to the end.
   *
   * The class lands on the header and the cell from this one entry,
   * which is the point of declaring columns rather than writing them
   * twice: the note on `.col-hide-sm` warns that missing one shifts
   * every column after it.
   */
  hide?: "sm" | "md";
  /** Keep the cell on one line; the table scrolls sideways instead. */
  nowrap?: boolean;
  render: (job: QueueJob) => React.ReactNode;
}

/** See the breakpoint note in globals.css. */
const HIDE = { sm: "col-hide-sm", md: "col-hide-md" } as const;

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
    /*
     * Only when the list is merged. On a single queue every row would
     * say the same thing, which is a column that teaches nothing — and
     * on a merged list it is the first thing the eye needs.
     */
    header: "Queue",
    states: STATES,
    mergedOnly: true,
    nowrap: true,
    render: (job) => (
      <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>{job.queue}</span>
    ),
  },
  {
    header: "Tenant",
    states: STATES,
    nowrap: true,
    render: (job) => (
      <Tenant utilityId={job.utilityId} utilityName={job.utilityName} tenancy={job.tenancy} />
    ),
  },
  {
    header: "Job",
    states: STATES,
    /*
     * Cut rather than wrapped. A repeatable's id is
     * `repeat:notification-send-cron:1792590070000` — 43 characters that
     * wrapped to three lines beside rows of one. The whole of it is on
     * hover, and it is also in the URL of the action taken on it.
     */
    render: (job) => (
      <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>
        <Clipped
          text={`${job.jobName}${job.jobId ? ` #${job.jobId}` : ""}`}
          width={260}
        />
      </span>
    ),
  },
  {
    header: "Queued",
    states: ["waiting", "active", "delayed", "failed", "dlq"],
    nowrap: true,
    hide: "sm",
    render: (job) => (job.enqueuedAt ? new Date(job.enqueuedAt).toLocaleString() : DASH),
  },
  {
    header: "Due",
    states: ["delayed"],
    nowrap: true,
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
    nowrap: true,
    hide: "sm",
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
    nowrap: true,
    render: (job) => (job.finishedAt ? new Date(job.finishedAt).toLocaleString() : DASH),
  },
  {
    header: "Took",
    states: ["completed"],
    align: "right",
    nowrap: true,
    hide: "md",
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
    nowrap: true,
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
    nowrap: true,
    hide: "md",
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
    requestedQueue === ALL_QUEUES || (requestedQueue && queueNames.includes(requestedQueue))
      ? requestedQueue
      : queueNames[0];
  const requestedState = params.get("state") as JobState | null;
  const state: JobState =
    requestedState && STATES.includes(requestedState) ? requestedState : "waiting";
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);
  const merged = queue === ALL_QUEUES;

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
        offset: String(offset),
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
  }, [queue, state, offset]);

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

  function go(next: { queue?: string; state?: string; offset?: number }) {
    const q = next.queue ?? queue ?? "";
    const s = next.state ?? state;
    // Back to the first page whenever the filters change: page four of
    // the old selection is not page four of the new one.
    const o = next.offset ?? (next.queue || next.state ? 0 : offset);
    const page = o > 0 ? `&offset=${o}` : "";
    router.push(`/platform/cluster/jobs?queue=${encodeURIComponent(q)}&state=${s}${page}`);
  }

  /*
   * The counts ride along in the filter labels. "failed (2)" is the
   * whole reason to open a filter — otherwise choosing a queue is
   * guesswork, and most combinations are empty.
   */
  const countFor = (s: JobState): number | null => {
    const queues = merged ? report?.queues : report?.queues.filter((q) => q.name === queue);
    if (!queues || queues.length === 0) return null;
    // Summed across the selection, so "All queues · Failed (3)" means
    // three failures somewhere rather than three in one unnamed place.
    return queues.reduce(
      (n, q) => n + (s === "dlq" ? q.dlqDepth : (q.counts[s as keyof typeof q.counts] ?? 0)),
      0,
    );
  };

  const columns = [
    ...JOB_COLUMNS.filter((c) => c.states.includes(state) && (merged || !c.mergedOnly)),
    ...(jobs?.jobs.some((j) => j.invalid) ? [PROBLEM_COLUMN] : []),
  ];
  const verb = verbFor(state);

  return (
    <div>
      <PageHeader title="Jobs" subtitle="What is in one queue, in one state" />

      <div style={{ marginBottom: 12, fontSize: 12 }}>
        {/* "Queues", not "All queues": that is the page's name, and the
            queue filter already uses those words for every queue at
            once. Two different things in the same words is how this read
            as a duplicate. */}
        <Link href="/platform/cluster/queues" style={{ color: "var(--accent-primary)" }}>
          ← Queues
        </Link>
      </div>

      <div style={{ marginBottom: 16 }}>
        <FilterBar
          filters={[
            {
              key: "queue",
              label: "Queue",
              value: queue,
              /*
               * Every queue is an option, not the absence of one.
               *
               * It was FilterBar's clear item for a moment, which read
               * as cleared: the pill showed the bare label while the
               * page was in fact filtering across all eight. A selection
               * the control does not show is worse than one it names, so
               * `all` is a value here and the built-in All is suppressed
               * — which is also what keeps it from appearing twice.
               */
              clearable: false,
              options: [
                { value: ALL_QUEUES, label: "All queues" },
                ...(report?.queues ?? []).map((q) => ({ value: q.name, label: q.name })),
              ],
              onChange: (value) => value && go({ queue: value }),
            },
            {
              key: "state",
              label: "Status",
              value: state,
              // A job is always in exactly one state, and the endpoint
              // takes exactly one, so there is no "All" to offer.
              clearable: false,
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
              {merged ? (
                "All queues"
              ) : (
                <span style={{ fontFamily: "monospace", textTransform: "none" }}>
                  {queue ?? "no queue"}
                </span>
              )}
              {" · "}
              {STATE_LABELS[state].toLowerCase()}
            </>
          }
          right={
            jobs?.reachable
              ? /* Where the page starts, not just how long it is: "1–20"
                   on its own would read the same on page one and page
                   four. */
                `${offset + 1}–${offset + jobs.jobs.length}`
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
            {offset > 0 ? (
              <>
                Nothing on this page any more — the jobs moved on since it was reached.{" "}
                <button
                  type="button"
                  onClick={() => go({ offset: 0 })}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    fontFamily: "inherit",
                    fontSize: 12,
                    color: "var(--accent-primary)",
                    cursor: "pointer",
                  }}
                >
                  Back to the first page
                </button>
                .
              </>
            ) : (
              <>
                Nothing {STATE_LABELS[state].toLowerCase()} in{" "}
                {merged ? "any queue" : queue} — either there never was, or the jobs moved on
                since the count was taken.
              </>
            )}
          </div>
        )}
        {jobs?.reachable && jobs.jobs.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <Th
                      key={c.header}
                      align={c.align}
                      className={c.hide ? HIDE[c.hide] : undefined}
                    >
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
                        <td
                          key={c.header}
                          // The same class as its header, from the same
                          // entry: globals.css warns that a column hidden
                          // on one and not the other shifts every column
                          // after it, which reads as wrong data.
                          className={c.hide ? HIDE[c.hide] : undefined}
                          style={{
                            ...cellStyle,
                            textAlign: c.align ?? "left",
                            ...(c.nowrap ? { whiteSpace: "nowrap" } : null),
                          }}
                        >
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

        {/*
         * Prev and Next rather than numbered pages, because there is no
         * total to number against: the sets move under us, and `hasMore`
         * is answered by fetching one job past the page rather than by
         * counting a set that will have changed by the time it is drawn.
         */}
        {jobs?.reachable && (offset > 0 || jobs.hasMore) && (
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              justifyContent: "flex-end",
              padding: "8px 14px",
              borderTop: "1px solid var(--border-subtle)",
            }}
          >
            <Verb
              label="← Newer"
              ariaLabel="Previous page"
              busy={offset === 0}
              onClick={() => go({ offset: Math.max(offset - JOBS_PER_PAGE, 0) })}
            />
            <Verb
              label="Older →"
              ariaLabel="Next page"
              busy={!jobs.hasMore}
              onClick={() => go({ offset: offset + JOBS_PER_PAGE })}
            />
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
