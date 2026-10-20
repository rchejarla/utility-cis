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
 * with its tenant and reason, and a link out to Bull Board for the verbs
 * this page deliberately does not have.
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
  const score = (q: QueueHealth) => (q.counts.failed > 0 || q.dlqDepth > 0 ? 0 : 1);
  return [...queues].sort((a, b) => score(a) - score(b));
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

export default function PlatformQueuesPage() {
  const [report, setReport] = useState<QueueHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Which single count is open: at most one, so the page stays a page. */
  const [open, setOpen] = useState<{ queue: string; state: JobState } | null>(null);
  const [jobs, setJobs] = useState<QueueJobsResult | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

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

  const clear = report?.reachable && report.totals.failed === 0 && report.totals.dlq === 0;

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
          ) : clear ? (
            <>
              <strong style={{ color: "var(--success)" }}>All clear.</strong> Nothing failed or
              dead-lettered across {report.queues.length} queues
              {report.totals.active + report.totals.waiting > 0
                ? `, ${report.totals.active} running and ${report.totals.waiting} waiting.`
                : "."}
            </>
          ) : (
            <>
              <strong style={{ color: "var(--danger)" }}>Needs attention.</strong>{" "}
              {report.totals.failed} failed and {report.totals.dlq} dead-lettered across{" "}
              {report.queues.length} queues.
            </>
          )}
        </div>
      )}

      {report?.reachable &&
        troubledFirst(report.queues).map((q) => (
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
              <span style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace" }}>
                {q.name}
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
              <div style={{ borderTop: "1px solid var(--border-subtle)", background: "var(--bg-subtle, transparent)" }}>
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
                {jobs?.reachable &&
                  jobs.jobs.map((j) => (
                    <div
                      key={`${j.jobId}-${j.enqueuedAt}`}
                      style={{
                        padding: "6px 14px",
                        borderTop: "1px solid var(--border-subtle)",
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        fontSize: 12,
                      }}
                    >
                      <strong style={{ color: "var(--text-primary)" }}>
                        {j.utilityName ?? (j.utilityId ? j.utilityId : "All tenants")}
                      </strong>
                      <span style={{ fontFamily: "monospace", color: "var(--text-muted)" }}>
                        {j.jobName}
                        {j.jobId ? ` #${j.jobId}` : ""}
                      </span>
                      {j.enqueuedAt && (
                        <span style={{ color: "var(--text-muted)" }}>
                          queued {new Date(j.enqueuedAt).toLocaleString()}
                        </span>
                      )}
                      {j.runsAt && (
                        <span
                          style={{
                            color: isOverdue(j.runsAt)
                              ? "var(--warning)"
                              : "var(--text-secondary)",
                          }}
                        >
                          due {new Date(j.runsAt).toLocaleString()}
                          {isOverdue(j.runsAt) ? " — overdue" : ""}
                        </span>
                      )}
                      {/* A repeatable job is the scheduler at rest; a
                          delayed one without a pattern is a retry
                          backing off, and they read identically as a
                          count. */}
                      {j.repeats && (
                        <span style={{ fontFamily: "monospace", color: "var(--accent-primary)" }}>
                          repeats {j.repeats}
                        </span>
                      )}
                      {j.attemptsMade > 0 && (
                        <span style={{ color: "var(--text-muted)" }}>
                          {j.attemptsMade} attempt{j.attemptsMade === 1 ? "" : "s"}
                        </span>
                      )}
                      {j.reason && (
                        <span style={{ color: "var(--text-secondary)" }}>{j.reason}</span>
                      )}
                    </div>
                  ))}
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
                  {/* The tenant, which is the half Bull Board cannot
                      show. A sweep belongs to no one tenant, and saying
                      so is better than leaving the column empty or
                      guessing an owner. */}
                  <strong style={{ color: "var(--text-primary)" }}>
                    {f.utilityName ?? (f.utilityId ? f.utilityId : "All tenants")}
                  </strong>
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
        ))}
    </div>
  );
}
