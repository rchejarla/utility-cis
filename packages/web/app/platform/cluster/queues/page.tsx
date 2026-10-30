"use client";

import Link from "next/link";
import { useState } from "react";
import { API_URL, apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { useCluster } from "@/components/cluster/use-cluster";
import {
  card,
  CardHead,
  cellStyle,
  plural,
  shortAge,
  Th,
  troubledFirst,
  Verb,
} from "@/components/cluster/ui";
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

/**
 * Whether the cluster limit is what is holding this queue back.
 *
 * Only worth saying when it actually binds. A ceiling of 4 over three
 * nodes that each take one job is not holding anything back — it binds
 * the day a fourth node joins — and marking it would be a false alarm on
 * a page whose whole job is telling alarms from quiet.
 */
function cappedBelowCapacity(q: QueueHealth): boolean {
  if (q.clusterLimit === null || q.workers === null) return false;
  return q.clusterLimit < q.workers * q.perNodeLimit;
}

/** `""` means no limit, which the API spells `null`. */
function parseLimit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const limitInput: React.CSSProperties = {
  width: 64,
  padding: "4px 8px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontFamily: "monospace",
  fontSize: 12,
};

/**
 * Stop a queue, or start it again.
 *
 * Pause asks for a reason first, in the row rather than in a dialog: it
 * is one short field, and the record it writes is the only thing that
 * will tell the next operator why a queue is stopped. Resume is a single
 * click — stopping work needs explaining, starting it again is the queue
 * doing its job, and a required field there would sit between an
 * operator and the end of an incident.
 */
function PauseCell({ queue: q, onDone }: { queue: QueueHealth; onDone: () => void }) {
  const [reason, setReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function send(action: "pause" | "resume", body: Record<string, string>) {
    setBusy(true);
    setFailed(null);
    try {
      await apiClient.post(
        `/api/v1/platform/queues/${encodeURIComponent(q.name)}/${action}`,
        body,
      );
      setReason(null);
      onDone();
    } catch (err) {
      // The typed reason stays: re-reading the report would drop it, and
      // an operator mid-incident should not have to type it twice.
      setFailed(err instanceof Error ? err.message : `Could not ${action} the queue`);
    } finally {
      setBusy(false);
    }
  }

  if (q.paused) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
        <Verb
          label="Resume"
          ariaLabel={`Resume ${q.name}`}
          busy={busy}
          onClick={() => void send("resume", {})}
        />
        {failed && <span style={{ color: "var(--danger)" }}>{failed}</span>}
      </div>
    );
  }

  if (reason === null) {
    return (
      <Verb
        label="Pause"
        ariaLabel={`Pause ${q.name}`}
        busy={false}
        onClick={() => setReason("")}
        loud
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
      <input
        aria-label={`Reason for pausing ${q.name}`}
        placeholder="Why?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ ...limitInput, width: 160, fontFamily: "inherit" }}
      />
      <div style={{ display: "flex", gap: 6 }}>
        <Verb
          label="Cancel"
          ariaLabel={`Leave ${q.name} running`}
          busy={false}
          onClick={() => {
            setReason(null);
            setFailed(null);
          }}
        />
        <Verb
          label="Pause"
          ariaLabel={`Confirm pause of ${q.name}`}
          busy={busy}
          loud
          onClick={() => void send("pause", { reason })}
        />
      </div>
      {failed && <span style={{ color: "var(--danger)" }}>{failed}</span>}
    </div>
  );
}

/**
 * One queue's two limits, in the row the queue already has.
 *
 * A column rather than a second card, because this page is deliberately
 * *one* table — a second per-queue list puts the same queue name in two
 * places and the reader has to work out whether they are the same thing.
 * It costs a wide cell, which is why the column drops on a phone: tuning
 * capacity is not what anybody opens this page on a phone to do.
 *
 * The sentence is computed here rather than taken from `effectiveLimit`,
 * so it follows what is being typed instead of what the server last
 * said. On load the two agree, which is what makes the duplicated
 * arithmetic safe to keep: a disagreement would show up immediately, in
 * the one place anybody reads both.
 */
function LimitsCell({ queue: q, onSaved }: { queue: QueueHealth; onSaved: () => void }) {
  const saved = {
    perNode: String(q.perNodeLimit),
    cluster: q.clusterLimit === null ? "" : String(q.clusterLimit),
  };
  const [draft, setDraft] = useState<{ perNode: string; cluster: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const value = draft ?? saved;
  const dirty = draft !== null && (draft.perNode !== saved.perNode || draft.cluster !== saved.cluster);

  const perNode = parseLimit(value.perNode) ?? q.perNodeLimit;
  const cluster = parseLimit(value.cluster);
  const capacity = q.workers === null ? null : q.workers * perNode;
  const cap = capacity === null ? null : cluster === null ? capacity : Math.min(cluster, capacity);

  async function save() {
    setBusy(true);
    setFailed(null);
    try {
      await apiClient.put(`/api/v1/platform/queues/${encodeURIComponent(q.name)}/concurrency`, {
        perNode,
        cluster,
      });
      /*
       * Drop the draft and re-read, so the row shows what the cluster now
       * holds. Only on success: re-reading after a failure would replace
       * what they typed with what the server still has, which reads as
       * the form having worked.
       */
      setDraft(null);
      onSaved();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Could not save the limits");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 260 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          min={1}
          aria-label={`Per node for ${q.name}`}
          value={value.perNode}
          onChange={(e) => setDraft({ ...value, perNode: e.target.value })}
          style={limitInput}
        />
        <span style={{ color: "var(--text-muted)" }}>per node, ≤</span>
        <input
          type="number"
          min={1}
          aria-label={`Cluster limit for ${q.name}`}
          placeholder="none"
          value={value.cluster}
          onChange={(e) => setDraft({ ...value, cluster: e.target.value })}
          style={limitInput}
        />
        <span style={{ color: "var(--text-muted)" }}>cluster-wide</span>
        {/* Shown only when there is something to save — this page's own
            rule: controls that mostly do nothing train the eye past
            them. */}
        {dirty && (
          <Verb
            label="Save"
            ariaLabel={`Save limits for ${q.name}`}
            busy={busy}
            onClick={() => void save()}
          />
        )}
      </div>
      <div style={{ color: "var(--text-secondary)" }}>
        {q.workers === null ? (
          /* A managed Redis refuses CLIENT LIST. A cap printed as a
             figure here would be invented. */
          <span style={{ color: "var(--text-muted)" }}>worker count unknown, so the cap is too</span>
        ) : q.workers === 0 ? (
          <span style={{ color: "var(--warning)" }}>no workers attached → nothing will run</span>
        ) : (
          <>
            {q.workers} {plural(q.workers, "worker", "workers")} attached → {cap} in flight at most
            {cluster !== null && capacity !== null && cluster > capacity && (
              /* Not an error. It binds the day a node is added, and
                 refusing it would also refuse it halfway through every
                 rolling deploy. */
              <span style={{ color: "var(--text-muted)" }}>
                {" "}
                — {cluster} not reached yet
              </span>
            )}
          </>
        )}
      </div>
      {failed && <div style={{ color: "var(--danger)" }}>{failed}</div>}
    </div>
  );
}

export default function ClusterQueuesPage() {
  const { report, error, reload } = useCluster();

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
                <Th className={HIDE_SM}>Runs at once</Th>
                {/* Not hidden on a phone: this is the lever somebody
                    reaches for during an incident, which is exactly when
                    they are not at a desk. */}
                <Th align="right">Taking work</Th>
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
                    {q.pauseRecord && (
                      /* Who and why, on the row rather than in a log.
                         A queue found paused with no record of why costs
                         the next operator the whole investigation. */
                      <div style={{ color: "var(--text-muted)", marginTop: 2, whiteSpace: "normal" }}>
                        {q.pauseRecord.reason} — {q.pauseRecord.by},{" "}
                        {new Date(q.pauseRecord.at).toLocaleString()}
                      </div>
                    )}
                    {cappedBelowCapacity(q) && (
                      /* A throttled queue and a slow queue look identical
                         from a count, which is the only reason this is
                         here rather than only on the card below. */
                      <span
                        style={{ color: "var(--warning)", marginLeft: 8 }}
                        title="The cluster limit is below what the attached workers would hold"
                      >
                        capped at {q.clusterLimit}
                      </span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                    <WorkerCell queue={q} />
                  </td>
                  <td className={HIDE_SM} style={cellStyle}>
                    <LimitsCell queue={q} onSaved={reload} />
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <PauseCell queue={q} onDone={reload} />
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

      {report?.reachable && (
        <div
          style={{
            ...card,
            padding: "10px 14px",
            marginBottom: 20,
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <strong style={{ color: "var(--text-primary)" }}>Per node</strong> bounds one worker
          process — its heap, its CPU, its own connection pool.{" "}
          <strong style={{ color: "var(--text-primary)" }}>Cluster-wide</strong> bounds the shared
          database, and takes effect at once: it is a key every node checks before taking a job.
          Per node takes effect when a worker next starts, since that one has to reach the process
          itself. Leave the cluster limit empty for no ceiling — zero is refused, because a queue
          that must stop is one to pause.
          <div style={{ marginTop: 6 }}>
            {/*
             * Said plainly because "pause" reads as "nothing will
             * happen", and the truth is "everything will happen later,
             * at once" — which an operator should know before reaching
             * for it rather than afterwards.
             */}
            <strong style={{ color: "var(--text-primary)" }}>Pausing</strong> stops workers taking
            new jobs. Jobs already running finish, and the schedules keep firing — so those jobs{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              pile up as waiting and run when it resumes
            </strong>
            , all of them. It is not a way to skip work.
          </div>
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
