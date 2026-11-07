"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  DATA_EXCEPTION_KINDS,
  DATA_EXCEPTION_STATUSES,
  type DataExceptionKind,
  type DataExceptionStatus,
  type MeterDataExceptionDto,
} from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * /meter-reads/interval-coverage — the days an interval meter's data
 * does not cover, and what somebody decided about them (spec 26,
 * TOU-GAP-1).
 *
 * The nightly sweep writes these rows; nothing here creates or deletes
 * one. What this screen is for is the **decision**: `Accept` tells the
 * pre-run check to stop blocking those minutes, so the month bills with
 * a hole in it — the only honest answer for a gap the head-end will
 * never backfill, and a figure a customer will be charged either way.
 * `Reopen` takes it back.
 *
 * **It tells you when the sweep is off.** That is not decoration: the
 * sweep ships disabled, so an empty table here would otherwise read as
 * "no problems with anybody's interval data" when it means "nobody
 * looked". The banner is the difference between a clean queue and an
 * unused one.
 */

interface AutomationAnswer {
  schedulers: Array<{ key: string; enabled: boolean }>;
}

type Row = MeterDataExceptionDto;

const KIND_LABELS: Record<DataExceptionKind, string> = {
  gap: "No data",
  overlap: "Counted twice",
  overrun: "Runs past the day",
  missing_reading: "Meter reported none",
};

const KIND_HINTS: Record<DataExceptionKind, string> = {
  gap: "The series does not cover these minutes. Re-poll the meter — the data may still exist at the head-end.",
  overlap: "Two intervals cover the same minutes, so this usage would be billed twice.",
  overrun: "The last interval runs past the end of the day, so the next period's energy would land here.",
  missing_reading:
    "The meter delivered the interval and said it had no value for it. Re-polling will not help; this is an estimate or an acceptance.",
};

const STATUS_LABELS: Record<DataExceptionStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  estimated: "Estimated",
  resolved: "Resolved",
};

/** Minutes, as a person reads a hole in a day. */
function duration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The window's day, in the reader's own zone — it is a day, not an instant. */
function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

export default function IntervalCoveragePage() {
  const { toast } = useToast();
  const { canView, canEdit } = usePermission("meter_reads");
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<DataExceptionStatus | "">("open");
  const [kind, setKind] = useState<DataExceptionKind | "">("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** `null` until the automation config answers — never assumed on. */
  const [sweepEnabled, setSweepEnabled] = useState<boolean | null>(null);

  const fetchRows = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50", sort: "windowStart", order: "desc" });
    if (status) params.set("status", status);
    if (kind) params.set("kind", kind);
    try {
      const res = await apiClient.get<{ data: Row[]; meta: { total: number } }>(
        `/api/v1/meter-data-exceptions?${params.toString()}`,
      );
      setRows(res.data ?? []);
      setTotal(res.meta?.total ?? 0);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load the queue", "error");
    } finally {
      setLoading(false);
    }
  }, [status, kind, toast]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    /*
     * A separate call, and a failure here is silent on purpose: not
     * knowing whether the sweep is on is a reason to say nothing about
     * it, never a reason to fail the page the rows are on.
     */
    apiClient
      .get<AutomationAnswer>("/api/v1/settings/automation")
      .then((cfg) => {
        const sweep = cfg.schedulers?.find((s) => s.key === "intervalCoverage");
        setSweepEnabled(sweep ? sweep.enabled : null);
      })
      .catch(() => setSweepEnabled(null));
  }, []);

  if (!canView) return <AccessDenied />;

  const act = async (row: Row, action: "accept" | "reopen") => {
    setBusyId(row.id);
    try {
      /*
       * An empty body, because the decision is the whole request:
       * the row says which exception and the path says which way. The
       * client requires one, so this is `{}` rather than nothing — a
       * detail only the typechecker caught, since the test mock takes
       * any arity.
       */
      await apiClient.post(`/api/v1/meter-data-exceptions/${row.id}/${action}`, {});
      toast(
        action === "accept"
          ? `${row.meter.meterNumber} — ${duration(row.minutesAffected)} accepted; this month can bill`
          : `${row.meter.meterNumber} — acceptance withdrawn`,
        "success",
      );
      // Re-read rather than patch the row in place: the sweep may have
      // moved it since this page loaded, and a guessed row is how a
      // screen comes to disagree with the database.
      await fetchRows();
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not ${action} it`, "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Interval Coverage"
        subtitle={`Days an interval meter's data does not cover (${total} ${
          status ? STATUS_LABELS[status].toLowerCase() : "in all"
        })`}
      />

      <PageDescription storageKey="interval-coverage">
        A TOU bill is a sum over classified intervals, so a missing hour is
        not a smaller bill — it is a bill that undercharges with nothing
        saying so. The nightly sweep finds the days that do not add up and
        lists them here while the data can still be re-polled. <b>Accept</b>{" "}
        when a hole will never be filled and the month has to bill anyway:
        the pre-run check stops blocking exactly those minutes, and who
        accepted it is recorded.
      </PageDescription>

      {sweepEnabled === false && (
        <div
          style={{
            background: "var(--warning-subtle)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: "12px 16px",
            marginBottom: 16,
            fontSize: 13,
            color: "var(--text-primary)",
          }}
        >
          <b>The nightly sweep is off</b>, so nothing is filling this queue —
          an empty list here means nobody has looked, not that the data is
          sound. Turn it on under{" "}
          <Link href="/settings/automation" style={{ color: "var(--accent-primary)" }}>
            Settings · Automation
          </Link>
          , where its grace period and how far back it checks are set too.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <select
          aria-label="Status"
          style={selectStyle}
          value={status}
          onChange={(e) => setStatus(e.target.value as DataExceptionStatus | "")}
        >
          <option value="">Any status</option>
          {DATA_EXCEPTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Kind"
          style={selectStyle}
          value={kind}
          onChange={(e) => setKind(e.target.value as DataExceptionKind | "")}
        >
          <option value="">Any problem</option>
          {DATA_EXCEPTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={thCell}>Meter</th>
              <th style={thCell}>Day</th>
              <th style={thCell}>Problem</th>
              <th style={thCell}>Affected</th>
              <th style={thCell}>Status</th>
              <th style={thCell}>Found</th>
              <th style={{ ...thCell, textAlign: "right" }}>Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                <td style={{ ...tdCell, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  <Link href={`/meters/${row.meterId}`} style={{ color: "var(--accent-primary)" }}>
                    {row.meter.meterNumber}
                  </Link>
                </td>
                <td style={tdCell}>{day(row.windowStart)}</td>
                <td style={tdCell}>
                  <div>{KIND_LABELS[row.kind] ?? row.kind}</div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {KIND_HINTS[row.kind]}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-secondary)",
                      marginTop: 4,
                      whiteSpace: "pre-line",
                    }}
                  >
                    {row.detail}
                  </div>
                </td>
                <td style={{ ...tdCell, fontWeight: 600 }}>{duration(row.minutesAffected)}</td>
                <td style={tdCell}>
                  <StatusBadge status={row.status} />
                </td>
                <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{day(row.detectedAt)}</td>
                <td style={{ ...tdCell, textAlign: "right" }}>
                  {!canEdit ? (
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                  ) : row.status === "open" ? (
                    <button
                      onClick={() => act(row, "accept")}
                      disabled={busyId === row.id}
                      style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}
                    >
                      {busyId === row.id ? "Working..." : "Accept"}
                    </button>
                  ) : row.status === "accepted" ? (
                    <button
                      onClick={() => act(row, "reopen")}
                      disabled={busyId === row.id}
                      style={{
                        ...btnStyle,
                        background: "transparent",
                        color: "var(--text-secondary)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {busyId === row.id ? "Working..." : "Reopen"}
                    </button>
                  ) : (
                    /*
                     * `resolved` — the data arrived, so there is nothing
                     * to decide; and `estimated`, which the estimator
                     * owns and this screen cannot undo yet.
                     */
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{ padding: "24px 18px", color: "var(--text-muted)", textAlign: "center" }}
                >
                  {loading
                    ? "Loading..."
                    : status === "open"
                      ? "No open coverage problems."
                      : "Nothing matches these filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: DataExceptionStatus }) {
  const tone: Record<DataExceptionStatus, { fg: string; bg: string }> = {
    open: { fg: "var(--warning)", bg: "var(--warning-subtle)" },
    accepted: { fg: "var(--accent-primary)", bg: "var(--accent-primary-subtle)" },
    estimated: { fg: "var(--info)", bg: "var(--info-subtle)" },
    resolved: { fg: "var(--success)", bg: "var(--success-subtle)" },
  };
  const { fg, bg } = tone[status] ?? { fg: "var(--text-secondary)", bg: "var(--bg-elevated)" };
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: fg,
        background: bg,
        padding: "2px 8px",
        borderRadius: 10,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

const selectStyle = {
  padding: "6px 10px",
  fontSize: 13,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
};
const btnStyle = {
  padding: "6px 14px",
  fontSize: 12,
  fontWeight: 500 as const,
  border: "none",
  borderRadius: "var(--radius)",
  cursor: "pointer",
  fontFamily: "inherit",
};
const thCell = {
  padding: "10px 14px",
  textAlign: "left" as const,
  fontSize: 10,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};
const tdCell = {
  padding: "10px 14px",
  color: "var(--text-primary)",
  verticalAlign: "top" as const,
};
