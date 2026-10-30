"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { card, CardHead, cellStyle, DASH, Th, Verb } from "@/components/cluster/ui";
import type { SchedulerReport, SchedulerView } from "@/components/cluster/types";

/**
 * What is meant to run, and when.
 *
 * Queues answers "what is waiting". This answers the question before it:
 * *is anything going to fire at all.* Three failures hide there and each
 * one looks like a quiet, healthy system, so each is said in words
 * rather than left for the reader to infer from a timestamp:
 *
 * - **Nothing armed it.** Schedulers are registered only at worker boot,
 *   so a deployment where none started has crons that were never armed.
 *   An unarmed cron has no row to appear in, which is why `unarmed` is
 *   its own panel and not a column.
 * - **Nothing promotes it.** An armed cron on a queue with no worker
 *   goes overdue and its record still looks perfect.
 * - **Redis holds one the build does not.** Worker boot reports these
 *   now instead of deleting them, so this row is the only place anybody
 *   sees one outside a log line.
 */

/** Once a row is this far past due, the exact timestamp stops helping. */
function overdueBy(nextRunAt: string): string {
  const minutes = Math.round((Date.now() - new Date(nextRunAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function when(iso: string | null): string {
  return iso === null ? "" : new Date(iso).toLocaleString();
}

/** The cadence, however this scheduler expresses it. */
function cadenceOf(s: SchedulerView): string {
  if (s.pattern) return s.pattern;
  if (s.everyMs) return `every ${Math.round(s.everyMs / 1000)}s`;
  return "—";
}

/**
 * Why this cron will not fire, if it will not.
 *
 * One sentence, in precedence order: a paused queue beats a missing
 * worker, because resuming is the thing to do and starting a worker
 * would not help. Null when nothing is wrong, so the column stays empty
 * on a healthy row rather than reassuring in eight places.
 */
function faultOf(s: SchedulerView): string | null {
  if (s.paused) return "its queue is paused — nothing is taken from it";
  if (s.workers === 0) return "no worker attached, so nothing will promote it";
  if (s.orphan) return "this build does not register it; it keeps firing until removed";
  if (s.overdue) return `overdue by ${overdueBy(s.nextRunAt!)} — nothing promoted it`;
  return null;
}

export default function ClusterSchedulersPage() {
  const [report, setReport] = useState<SchedulerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiClient
      .get<SchedulerReport>("/api/v1/platform/schedulers")
      .then((data) => {
        if (live) setReport(data);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Failed to load the schedulers");
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  async function remove(s: SchedulerView) {
    setRemoving(s.schedulerId);
    setError(null);
    try {
      await apiClient.delete(
        `/api/v1/platform/queues/${encodeURIComponent(s.queue)}/schedulers/${encodeURIComponent(s.schedulerId)}`,
      );
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the scheduler");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Schedulers"
        subtitle="Every cron armed in Redis — its cadence, when it next runs, and whether anything will run it"
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
        /* An unreachable Redis and a cluster with nothing scheduled draw
           the same empty table, and only one of them is good news. */
        <div style={{ ...card, marginBottom: 20, padding: "12px 14px", fontSize: 13 }}>
          <strong style={{ color: "var(--warning)" }}>The schedulers could not be read.</strong>{" "}
          Redis did not answer, so nothing here is known — this is not the same as nothing being
          scheduled.
        </div>
      )}

      {report && report.unarmed.length > 0 && (
        /*
         * Its own panel because an unarmed cron has no row. This is the
         * failure the scheduling spec exists for: registration happens
         * at worker boot, so a deployment where no worker started has
         * crons that were never armed — and the queue looks idle, which
         * is exactly what an idle queue looks like.
         */
        <div
          style={{
            ...card,
            borderColor: "var(--danger)",
            marginBottom: 20,
            padding: "12px 14px",
            fontSize: 13,
          }}
        >
          <strong style={{ color: "var(--danger)" }}>
            Nothing armed {report.unarmed.length === 1 ? "this cron" : "these crons"}.
          </strong>{" "}
          They are registered in the code and absent from Redis, so they will not fire at all.
          Schedulers are armed at worker boot — start a worker that serves their queues.
          <div style={{ fontFamily: "monospace", marginTop: 6, color: "var(--text-primary)" }}>
            {report.unarmed.join(", ")}
          </div>
        </div>
      )}

      {report?.reachable && report.schedulers.length > 0 && (
        <div style={{ ...card, marginBottom: 20, overflowX: "auto" }}>
          <CardHead
            left="Armed in Redis"
            right="The record in Redis is what fires — not the pattern in the source"
          />
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <Th>Scheduler</Th>
                <Th>Queue</Th>
                <Th>Cadence</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Fired</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {/* Trouble first, the rest in registry order, as the
                  Queues table sorts. */}
              {[...report.schedulers]
                .sort((a, b) => Number(faultOf(a) === null) - Number(faultOf(b) === null))
                .map((s) => {
                  const fault = faultOf(s);
                  return (
                    <tr key={`${s.queue}:${s.schedulerId}`}>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 500 }}>
                          {s.schedulerId}
                        </span>
                        {s.orphan && (
                          <span style={{ color: "var(--warning)", marginLeft: 8 }}>orphan</span>
                        )}
                        <div style={{ color: "var(--text-muted)", marginTop: 2 }}>{s.jobName}</div>
                        {fault && (
                          <div
                            style={{
                              color: s.overdue || s.paused ? "var(--danger)" : "var(--warning)",
                              marginTop: 2,
                              whiteSpace: "normal",
                            }}
                          >
                            {fault}
                          </div>
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        {/* Pre-filtered, so "due in four minutes" and
                            "here is what it did last time" are one click
                            apart. Delayed, because an armed occurrence
                            waits there until it comes due. */}
                        <Link
                          href={`/platform/cluster/jobs?queue=${encodeURIComponent(s.queue)}&state=delayed`}
                          style={{
                            fontFamily: "monospace",
                            color: "var(--accent-primary)",
                            textDecoration: "none",
                            borderBottom: "1px dotted var(--border)",
                          }}
                        >
                          {s.queue}
                          <span className="sr-only"> — delayed jobs</span>
                        </Link>
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap", fontFamily: "monospace" }}>
                        {cadenceOf(s)}
                        {s.timezone && (
                          <div style={{ fontFamily: "inherit", color: "var(--text-muted)" }}>
                            {s.timezone}
                          </div>
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        {s.nextRunAt === null ? (
                          DASH
                        ) : (
                          <span style={{ color: s.overdue ? "var(--danger)" : undefined }}>
                            {when(s.nextRunAt)}
                          </span>
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                        {s.lastRunAt === null ? (
                          /* Completed jobs are retained 24h, so absence
                             is not evidence of never. */
                          <span style={{ color: "var(--text-muted)" }}>not in the last 24h</span>
                        ) : (
                          when(s.lastRunAt)
                        )}
                      </td>
                      <td style={{ ...cellStyle, whiteSpace: "nowrap", fontFamily: "monospace" }}>
                        {s.iterations ?? DASH}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {/* Only on an orphan: the API refuses to remove a
                            registered cron, and a button whose only
                            outcome is a 409 teaches the reader to ignore
                            buttons. */}
                        {s.orphan && (
                          <Verb
                            label="Remove"
                            ariaLabel={`Remove ${s.schedulerId}`}
                            busy={removing === s.schedulerId}
                            loud
                            onClick={() => void remove(s)}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {report?.reachable && report.schedulers.length === 0 && (
        <div style={{ ...card, marginBottom: 20, padding: "12px 14px", fontSize: 13 }}>
          <strong style={{ color: "var(--warning)" }}>No cron is armed anywhere.</strong> Redis
          answered and holds no scheduler records, which means nothing scheduled will run.
          Schedulers are armed at worker boot — start a worker.
        </div>
      )}

      <div style={{ ...card, padding: "10px 14px", fontSize: 12, color: "var(--text-secondary)" }}>
        Cadences are fixed in the code, not here: three of the five resolve a tenant-facing setting,
        so a slower sweep would turn a timing preference into work that silently never happens.
        One overdue occurrence fires on recovery, not one per interval missed — a sweep catches up,
        a job that had to happen on a particular hour does not.
      </div>
    </div>
  );
}
