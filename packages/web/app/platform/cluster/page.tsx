"use client";

import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { useCluster } from "@/components/cluster/use-cluster";
import { card, plural, Tenant, troubledFirst } from "@/components/cluster/ui";

/**
 * Is anything wrong, and where to go about it.
 *
 * One verdict and the recent failures, and nothing else. This used to be
 * the top of the Queues page, which had grown to five subjects — the
 * verdict, the nodes, the workers, the queues and the jobs behind one
 * count — so "is anything wrong" was answered at the top of a page about
 * something else.
 *
 * The verdict needs both halves of the cluster. "Nothing is running" is a
 * fact about workers *and* about what is queued behind them, which is why
 * one endpoint still serves all three pages.
 */
export default function ClusterOverviewPage() {
  const { report, error } = useCluster();

  const queues = report?.queues ?? [];
  const unattended = queues.filter((q) => q.workers === 0);
  const unknownWorkers = queues.filter((q) => q.workers === null);
  const paused = queues.filter((q) => q.paused);
  const failing = (report?.totals.failed ?? 0) > 0 || (report?.totals.dlq ?? 0) > 0;
  const allUnattended = queues.length > 0 && unattended.length === queues.length;
  const failures = troubledFirst(queues).flatMap((q) =>
    q.recentFailures.map((f) => ({ queue: q.name, failure: f })),
  );

  return (
    <div>
      <PageHeader
        title="Cluster"
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
              <strong style={{ color: "var(--warning)" }}>The queues could not be read.</strong>{" "}
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
            /* The counts say nothing is wrong, and nothing can run. This
               is the ordinary state of a dev stack, and it looked
               identical to healthy until the worker count arrived. */
            <>
              <strong style={{ color: "var(--warning)" }}>Nothing is running.</strong> No worker
              process is attached to any of the {report.queues.length} queues
              {report.totals.waiting > 0
                ? `, and ${report.totals.waiting} ${plural(report.totals.waiting, "job is", "jobs are")} waiting.`
                : "."}{" "}
              <Link href="/platform/cluster/workers" style={{ color: "var(--accent-primary)" }}>
                Start one
              </Link>
              .
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
        </div>
      )}

      {/*
       * Recent failures, gathered rather than scattered.
       *
       * They used to hang under each queue's card, so reading "what has
       * been failing" meant scrolling eight of them. Across queues and
       * newest first is the question actually being asked.
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
    </div>
  );
}
