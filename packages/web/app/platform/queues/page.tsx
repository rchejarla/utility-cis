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

/** Trouble first; the rest keep the registry's order. */
function troubledFirst(queues: QueueHealth[]): QueueHealth[] {
  const score = (q: QueueHealth) => (q.counts.failed > 0 || q.dlqDepth > 0 ? 0 : 1);
  return [...queues].sort((a, b) => score(a) - score(b));
}

function Count({ label, value, loud }: { label: string; value: number; loud?: boolean }) {
  return (
    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
      <strong
        style={{
          fontFamily: "monospace",
          color: loud && value > 0 ? "var(--danger)" : "var(--text-primary)",
        }}
      >
        {value}
      </strong>{" "}
      {label}
    </span>
  );
}

export default function PlatformQueuesPage() {
  const [report, setReport] = useState<QueueHealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const clear = report?.reachable && report.totals.failed === 0 && report.totals.dlq === 0;

  return (
    <div>
      <PageHeader
        title="Queues"
        subtitle="Background work across every tenant on this deployment"
        actions={
          /* The verbs this page does not have. Bull Board is served by
             the API on its own host, so this leaves the console — fine
             as an escape hatch from inside a page, which is why it is
             not the menu entry. */
          <a
            href={BULL_BOARD_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: "7px 14px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              fontSize: 12,
              fontWeight: 500,
              textDecoration: "none",
            }}
          >
            Open Bull Board ↗
          </a>
        }
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
                <Count label="waiting" value={q.counts.waiting} />
                <Count label="active" value={q.counts.active} />
                <Count label="delayed" value={q.counts.delayed} />
                <Count label="failed" value={q.counts.failed} loud />
                <Count label="dead-lettered" value={q.dlqDepth} loud />
              </span>
            </div>

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
