"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * /meter-reads/progress — how far along a cycle's reading is, and which
 * services are still outstanding (spec 08).
 *
 * **The question the read log cannot answer.** That screen lists reads
 * that exist; this one is about the ones that do not, which is what
 * decides whether a cycle can bill. Until now the only way to find out
 * was to start a billing run and read the skips — one
 * `NO_READ_IN_WINDOW` per account, after the run had been created and
 * the window had closed behind it.
 *
 * So the count leads and the table follows: "612 still to read, 94%
 * done" is the answer somebody wants at 8am on bill day, and the list
 * is what they do about it. The window is printed beside it, because a
 * progress figure with no period attached reads as "ever".
 */

interface OutstandingRead {
  meterId: string;
  meterNumber: string;
  agreementNumber: string;
  accountNumber: string;
  premise: string | null;
  lastReadDate: string | null;
}

interface Progress {
  billingCycleId: string;
  cycleCode: string;
  windowStart: string;
  windowEnd: string;
  expected: number;
  read: number;
  outstanding: number;
  data: OutstandingRead[];
  meta: { total: number; page: number; limit: number; pages: number };
}

interface Cycle {
  id: string;
  cycleCode: string;
  name: string;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });

export default function ReadingProgressPage() {
  const { toast } = useToast();
  const { canView } = usePermission("meter_reads");
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState<string>("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: Cycle[] } | Cycle[]>("/api/v1/billing-cycles")
      .then((res) => {
        const list = Array.isArray(res) ? res : (res.data ?? []);
        setCycles(list);
        // The first cycle rather than none: a screen that opens on an
        // empty selector makes the operator work before it answers
        // anything, and most tenants have one or two routes.
        if (list.length > 0) setCycleId((prev) => prev || list[0]!.id);
      })
      .catch(() => setCycles([]));
  }, []);

  const fetchProgress = useCallback(async () => {
    if (!cycleId) return;
    setLoading(true);
    try {
      setProgress(
        await apiClient.get<Progress>(
          `/api/v1/meter-reads/progress?billingCycleId=${cycleId}&limit=100`,
        ),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not load reading progress", "error");
    } finally {
      setLoading(false);
    }
  }, [cycleId, toast]);

  useEffect(() => {
    fetchProgress();
  }, [fetchProgress]);

  if (!canView) return <AccessDenied />;

  const pct =
    progress && progress.expected > 0
      ? Math.floor((progress.read / progress.expected) * 100)
      : null;

  return (
    <div>
      <PageHeader
        title="Reading Progress"
        subtitle={
          progress
            ? `Cycle ${progress.cycleCode} · the window ${day(progress.windowStart)} to ${day(
                progress.windowEnd,
              )}`
            : "How much of a cycle has been read"
        }
      />

      <PageDescription storageKey="reading-progress">
        A billing run skips an account it has no read for, and reports it
        only once the run exists. This asks the same question beforehand,
        of the same window the run will use: which services the cycle
        expects a read for, and which have not been read yet. An interval
        meter counts as read once its intervals are in — it has no read
        row until a run rolls them up.
      </PageDescription>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 18 }}>
        <div>
          <label htmlFor="cycle" style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
            Cycle
          </label>
          <select
            id="cycle"
            style={selectStyle}
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
          >
            {cycles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.cycleCode} — {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {progress && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <Stat label="Still to read" value={progress.outstanding.toLocaleString()} loud />
          <Stat
            label="Read"
            value={`${progress.read.toLocaleString()} of ${progress.expected.toLocaleString()}`}
          />
          {pct !== null && <Stat label="Complete" value={`${pct}%`} />}
        </div>
      )}

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
              <th style={thCell}>Premise</th>
              <th style={thCell}>Agreement</th>
              <th style={thCell}>Account</th>
              <th style={thCell}>Last read</th>
            </tr>
          </thead>
          <tbody>
            {(progress?.data ?? []).map((row) => (
              <tr key={`${row.meterId}-${row.agreementNumber}`} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                <td style={{ ...tdCell, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                  <Link href={`/meters/${row.meterId}`} style={{ color: "var(--accent-primary)" }}>
                    {row.meterNumber}
                  </Link>
                </td>
                <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{row.premise ?? "—"}</td>
                <td style={tdCell}>{row.agreementNumber}</td>
                <td style={{ ...tdCell, fontFamily: "'JetBrains Mono', monospace" }}>
                  {row.accountNumber}
                </td>
                <td style={tdCell}>
                  {row.lastReadDate ? (
                    day(row.lastReadDate)
                  ) : (
                    /*
                     * A blank here would read as "no data available"
                     * rather than as a fact about the meter. Never read
                     * means a new service, which is a different morning's
                     * work from a meter somebody stopped reaching.
                     */
                    <span style={{ color: "var(--text-muted)" }}>Never read</span>
                  )}
                </td>
              </tr>
            ))}
            {progress && progress.data.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  style={{ padding: "24px 18px", color: "var(--text-muted)", textAlign: "center" }}
                >
                  {loading
                    ? "Loading..."
                    : progress.expected === 0
                      ? "This cycle has no services expecting a read in this window."
                      : `All ${progress.expected.toLocaleString()} services in this cycle have been read.`}
                </td>
              </tr>
            )}
            {!progress && (
              <tr>
                <td
                  colSpan={5}
                  style={{ padding: "24px 18px", color: "var(--text-muted)", textAlign: "center" }}
                >
                  {loading ? "Loading..." : "Pick a cycle."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {progress && progress.meta.total > progress.data.length && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
          Showing {progress.data.length.toLocaleString()} of{" "}
          {progress.meta.total.toLocaleString()} outstanding.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, loud }: { label: string; value: string; loud?: boolean }) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${loud ? "var(--warning)" : "var(--border)"}`,
        borderRadius: "var(--radius)",
        padding: "12px 18px",
        minWidth: 150,
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: loud ? "var(--warning)" : "var(--text-primary)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        {value}
      </div>
    </div>
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
  minWidth: 260,
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
const tdCell = { padding: "10px 14px", color: "var(--text-primary)", verticalAlign: "middle" as const };
