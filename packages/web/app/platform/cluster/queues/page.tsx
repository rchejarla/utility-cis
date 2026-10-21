"use client";

import Link from "next/link";
import { API_URL } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { useCluster } from "@/components/cluster/use-cluster";
import { card, cellStyle, shortAge, Th, troubledFirst } from "@/components/cluster/ui";
import type { JobState, QueueHealth } from "@/components/cluster/types";

/**
 * The eight queues, at a glance.
 *
 * Counts only. The jobs behind a count live on the Jobs page, reached by
 * clicking one — which took three attempts to get right. First the job
 * table was nested inside this one, so its header row landed among these
 * rows and read as though it described them. Then it sat directly below,
 * where the only thing tying the two together was a tinted row that
 * scrolls out of view. Now it is a route, like every other list-to-detail
 * in this app, with the queue and the state in the URL.
 */

const BULL_BOARD_URL = `${API_URL}/admin/queues`;

/**
 * Below this, how long ago a worker attached is worth printing.
 *
 * A worker that reattaches every few seconds is crash-looping, and reads
 * as a healthy "1" without this. An hours-old connection's exact age
 * tells nobody anything, so it stays out.
 */
const RECENTLY_ATTACHED_SECONDS = 300;

/**
 * A count, a link when there is anything behind it.
 *
 * Zero is not a link: there is nothing to open, and a row of six
 * controls that mostly do nothing trains the eye to ignore them. The
 * state's name rides along for a screen reader, where the column header
 * is not adjacent the way it is on screen.
 */
function Count({
  queue,
  state,
  label,
  value,
  loud,
}: {
  queue: string;
  state: JobState;
  label: string;
  value: number;
  loud?: boolean;
}) {
  if (value === 0) {
    return (
      <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-muted)" }}>
        0<span className="sr-only"> {label}</span>
      </span>
    );
  }

  return (
    <Link
      href={`/platform/cluster/jobs?queue=${encodeURIComponent(queue)}&state=${state}`}
      style={{
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: 600,
        color: loud ? "var(--danger)" : "var(--accent-primary)",
        textDecoration: "none",
        borderBottom: "1px dotted var(--border)",
      }}
    >
      {value}
      <span className="sr-only"> {label}</span>
    </Link>
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
              {troubledFirst(report.queues).map((q) => (
                <tr key={q.name}>
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
                        queue={q.name}
                        state={state}
                        label={state === "dlq" ? "dead-lettered" : state}
                        value={value}
                        loud={loud}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
