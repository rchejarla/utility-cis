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

/** See the note on `.col-hide-sm` in globals.css. */
const HIDE_SM = "col-hide-sm";

/**
 * The count columns, declared once so the header and the cell cannot
 * disagree about which of them a phone drops.
 *
 * Eight numeric columns is the widest table in the console, and on a
 * phone the question is only "is anything wrong, and is anyone working
 * it" — so the queue, its workers, what is piling up and what has broken
 * stay. Active is almost always zero, Delayed is the armed cron rather
 * than a problem, and Completed is evidence of health rather than of
 * trouble; those three go.
 */
const COUNT_COLUMNS: readonly {
  state: JobState;
  header: string;
  /** The screen-reader label, where the header is not adjacent. */
  label: string;
  loud?: boolean;
  hideOnPhone?: boolean;
}[] = [
  { state: "waiting", header: "Waiting", label: "waiting" },
  { state: "active", header: "Active", label: "active", hideOnPhone: true },
  { state: "delayed", header: "Delayed", label: "delayed", hideOnPhone: true },
  { state: "failed", header: "Failed", label: "failed", loud: true },
  { state: "dlq", header: "Dead-lettered", label: "dead-lettered", loud: true },
  { state: "completed", header: "Completed", label: "completed", hideOnPhone: true },
];

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
                {COUNT_COLUMNS.map((c) => (
                  <Th
                    key={c.state}
                    align="right"
                    className={c.hideOnPhone ? HIDE_SM : undefined}
                  >
                    {c.header}
                  </Th>
                ))}
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
                  {COUNT_COLUMNS.map((c) => (
                    <td
                      key={c.state}
                      // The same class as its header, from the same
                      // entry: globals.css warns that a column hidden on
                      // one and not the other shifts every column after
                      // it, which reads as wrong data.
                      className={c.hideOnPhone ? HIDE_SM : undefined}
                      style={{ ...cellStyle, textAlign: "right" }}
                    >
                      <Count
                        queue={q.name}
                        state={c.state}
                        label={c.label}
                        value={c.state === "dlq" ? q.dlqDepth : q.counts[c.state]}
                        loud={c.loud}
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
