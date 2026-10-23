"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { useCluster } from "@/components/cluster/use-cluster";
import {
  card,
  CardHead,
  cellStyle,
  DASH,
  plural,
  Th,
  Verb,
} from "@/components/cluster/ui";
import { isStale } from "@/components/cluster/types";
import type { StopResult, WorkerView } from "@/components/cluster/types";

/** See the note on `.col-hide-sm` in globals.css. */
const HIDE_SM = "col-hide-sm";

/**
 * The nodes, and the worker process on each.
 *
 * A table at every node count: one layout to learn, one code path. One
 * row per node, never a tree — a deployment may have a worker per API
 * node, and the version that kept a single record let the first node to
 * start one block every other node from starting any.
 *
 * Start is node-local, because nothing portable starts a process on
 * another machine: the request lands wherever the load balancer sent it,
 * and the row says which node that is rather than implying a choice.
 * Stop is offered only where the pid is this node's to signal; routing a
 * command to another node is step 3 of
 * `docs/specs/24-platform-worker-control.md`.
 */
export default function ClusterWorkersPage() {
  const { report, error, setReport, reload } = useCluster();
  const [busy, setBusy] = useState(false);
  /*
   * Workers that have been asked to drain and have not gone yet.
   *
   * The record stays while a worker winds down — a drain takes up to a
   * minute, and reporting "stopped" early would have this page
   * contradict the process table. Without marking the row, the control
   * looked inert and the honest response was to press it again.
   */
  const [draining, setDraining] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);

  const workers = report?.workers ?? [];

  /*
   * While anything is draining, read again until it has gone.
   *
   * The worker exits on its own and the next status read is what
   * notices; without this the row sat there until a reload, which is
   * what sent an operator back to the Stop button to press it a second
   * time. Stops when nothing is draining, so an idle page is idle.
   */
  useEffect(() => {
    if (draining.length === 0) return;
    const live = new Set(workers.map((w) => w.id));
    const gone = draining.filter((id) => !live.has(id));
    if (gone.length > 0) {
      setDraining((d) => d.filter((id) => live.has(id)));
      return;
    }
    const t = setInterval(() => reload(), 3000);
    return () => clearInterval(t);
  }, [draining, workers, reload]);
  /** A worker this node spawned, if any. At most one — the health port. */
  const ourWorker = workers.find((w) => w.node === report?.thisNode);
  const attachedSomewhere = (report?.queues ?? []).some((q) => (q.workers ?? 0) > 0);
  /**
   * One row per node: every node Redis reports as connected, plus any
   * node that holds a worker record.
   *
   * The union matters. A node that has dropped off the client list still
   * has its worker in the registry, and that is precisely when it must
   * stay on screen rather than vanish — so such a row is marked, not
   * omitted.
   */
  const nodeRows = [
    ...new Set([...(report?.nodes ?? []).map((n) => n.host), ...workers.map((w) => w.node)]),
  ].map((host) => ({
    host,
    connected: report?.nodes?.some((n) => n.host === host) ?? false,
    worker: workers.find((w) => w.node === host),
  }));
  const unattendedNodes = nodeRows.filter((r) => !r.worker).length;
  /** What a newly started worker would pick up at once, per queue. */
  const queuedOnStart = (report?.queues ?? [])
    .map((q) => ({ name: q.name, jobs: q.counts.waiting + q.counts.delayed }))
    .filter((q) => q.jobs > 0);

  async function startWorker() {
    setBusy(true);
    setSaid(null);
    try {
      const started = await apiClient.post<WorkerView>("/api/v1/platform/workers/start", {
        queues: [],
      });
      setReport((r) => ({ ...r, workers: [...r.workers, started] }));
      setSaid(`Started — pid ${started.pid} on ${started.node}`);
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function stopWorker(id: string) {
    setBusy(true);
    setSaid(null);
    try {
      const result = await apiClient.post<StopResult>(
        `/api/v1/platform/workers/${id}/stop`,
        {},
      );

      if (!result.drained) {
        /* The fallback fired: the worker never answered its own HTTP
           server, so it got a signal — which on Windows cuts in-flight
           jobs off, to be retried once their locks expire. */
        setSaid(
          "Stopped abruptly — the worker could not be reached to drain, so anything in flight will be retried after its lock expires.",
        );
      } else {
        setSaid(
          result.stopping
            ? "Draining — it will finish its in-flight jobs and then exit."
            : "Stopped.",
        );
      }

      // Gone only once the process has actually left; a drain can take a
      // minute, and the next read is what notices.
      if (result.stopping) {
        setDraining((d) => (d.includes(id) ? d : [...d, id]));
      } else {
        setReport((r) => ({ ...r, workers: r.workers.filter((w) => w.id !== id) }));
      }
    } catch (err) {
      setSaid(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Workers"
        subtitle="The API nodes on this deployment, and the worker process on each"
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
        <div style={{ ...card, marginBottom: 20 }}>
          <CardHead
            left="Worker processes"
            right={
              <>
                {nodeRows.length} {plural(nodeRows.length, "node", "nodes")} · {workers.length}{" "}
                {plural(workers.length, "worker", "workers")}
                {unattendedNodes > 0 && (
                  <span style={{ color: "var(--warning)" }}> · {unattendedNodes} with none</span>
                )}
              </>
            }
          />

          {report.nodes === null ? (
            /* A managed Redis refuses CLIENT LIST, which is where the
               node list comes from. "No nodes" is never true of a
               deployment that is serving this page, so the table is
               replaced rather than drawn empty. */
            <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
              The API nodes could not be listed — this Redis does not allow reading its clients.
              Any worker below is still reported from its own record.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <Th>Node</Th>
                    <Th>Worker</Th>
                    <Th>State</Th>
                    {/* The one column a phone can do without here: the
                        node, whether a worker is attached, and what can
                        be done about it are the question. */}
                    <Th className={HIDE_SM}>Since</Th>
                    <Th align="right">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {nodeRows.map(({ host, connected, worker }) => {
                    const here = host === report.thisNode;
                    return (
                      <tr key={host}>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          <span style={{ fontFamily: "monospace", color: "var(--text-primary)" }}>
                            {host}
                          </span>
                          {here && (
                            /* A start lands on whichever node the load
                               balancer picked, so which one that is has
                               to be visible rather than surprising. */
                            <span style={{ color: "var(--accent-primary)", marginLeft: 8 }}>
                              serving this page
                            </span>
                          )}
                          {!connected && (
                            /* Holds a worker record but is not in the
                               client list: the node has gone while its
                               worker's record remains, which is exactly
                               when it must not vanish from the table. */
                            <span style={{ color: "var(--danger)", marginLeft: 8 }}>
                              not connected
                            </span>
                          )}
                        </td>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          {worker ? (
                            <span style={{ fontFamily: "monospace" }}>pid {worker.pid}</span>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                          {!worker ? (
                            <span style={{ color: "var(--warning)" }}>no worker</span>
                          ) : draining.includes(worker.id) ? (
                            /* Asked to drain and not gone yet. A drain
                               runs to the end of the job in flight, so
                               this can sit here for up to a minute. */
                            <span style={{ color: "var(--warning)" }}>stopping…</span>
                          ) : worker.attached ? (
                            <span style={{ color: "var(--success)" }}>attached</span>
                          ) : (
                            /* Either still opening its connections, or
                               gone on a node whose pid this one cannot
                               check. Both are worth seeing; neither is
                               "running". */
                            <span style={{ color: "var(--warning)" }}>not attached</span>
                          )}
                        </td>
                        <td
                          className={HIDE_SM}
                          style={{ ...cellStyle, whiteSpace: "nowrap" }}
                        >
                          {worker ? (
                            <>
                              {new Date(worker.startedAt).toLocaleString()}
                              {/*
                                The worker is the only process here that
                                does not reload: the API runs `tsx watch`,
                                a worker runs as one `--import tsx`
                                process so a stop cannot orphan it. So a
                                code change does not reach the next job,
                                and the job reports the old behaviour as
                                current. Nothing on this page used to
                                contradict that.
                              */}
                              {isStale(worker.startedAt, report.sourceChangedAt) && (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: "var(--warning)",
                                    whiteSpace: "normal",
                                    maxWidth: 260,
                                    marginTop: 4,
                                  }}
                                >
                                  Running code from before the last change on disk — restart it
                                  to pick that up.
                                </div>
                              )}
                            </>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td style={{ ...cellStyle, textAlign: "right", whiteSpace: "nowrap" }}>
                          {worker && worker.stoppable ? (
                            <Verb
                              label="Stop"
                              ariaLabel={`Stop worker on ${host}`}
                              loud
                              // A second press is harmless but teaches
                              // an operator the control cannot be
                              // trusted: it is already stopping.
                              busy={busy || draining.includes(worker.id)}
                              onClick={() => stopWorker(worker.id)}
                            />
                          ) : worker ? (
                            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                              stop it from {host}
                            </span>
                          ) : here && report.controllable ? (
                            <Verb
                              label="Start"
                              ariaLabel={`Start worker on ${host}`}
                              busy={busy}
                              onClick={startWorker}
                            />
                          ) : (
                            DASH
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* The notes, under the table and naming the node they are
              about. They used to sit below every node at once, so with
              three nodes the log path of the one worker read as if it
              belonged to a node that had none. */}
          <div
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border-subtle)",
              display: "grid",
              gap: 4,
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {!report.controllable ? (
              <div>
                Workers are a separate deployment here, so starting one from this console is
                disabled — scale the worker deployment instead.
              </div>
            ) : ourWorker ? (
              <>
                {/* Asked over the worker's own HTTP server, which is the
                    one stop path that drains on both Windows and Linux —
                    a signal on Windows is an unconditional termination
                    that skips the handler entirely. */}
                <div>Stopping asks the worker to finish what it is holding first.</div>
                <div style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  {ourWorker.node}&rsquo;s log: {ourWorker.logFile}
                </div>
              </>
            ) : attachedSomewhere && workers.length === 0 ? (
              <div>
                A worker is attached but was not started from here — it has no record, so there
                is nothing for this console to stop.
              </div>
            ) : (
              <>
                <div>
                  Start acts on {report.thisNode}, the node serving this page — nothing portable
                  starts a process on another machine. It serves all {report.queues.length}{" "}
                  {plural(report.queues.length, "queue", "queues")} and outlives this API
                  process, so a reload will not stop it.
                </div>
                {queuedOnStart.length > 0 && (
                  <div style={{ color: "var(--warning)" }}>
                    Work already queued starts running at once:{" "}
                    <span style={{ fontFamily: "monospace" }}>
                      {queuedOnStart.map((q) => `${q.name} ${q.jobs}`).join(", ")}
                    </span>
                    . Open it on the Queues page to see the jobs first.
                  </div>
                )}
              </>
            )}

            {said && (
              <div
                style={{
                  color: /^(Started|Stopped\.|Draining)/.test(said)
                    ? "var(--success)"
                    : "var(--danger)",
                }}
              >
                {said}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
