"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { StartRunDialog } from "@/components/billing-runs/start-run-dialog";
import { fmtDate } from "@/components/billing-runs/run-format";
import type { BillingRunRow } from "@/components/billing-runs/run-format";

/**
 * Every billing run, newest first.
 *
 * A run's identity to an operator is its cycle and its window — "the
 * October residential run" — so those are the first two columns and the
 * id never appears.
 *
 * Failed and skipped are separate columns, never one "exceptions"
 * figure. Skipped is "nothing to bill" and is ordinary; failed is
 * "should have billed and could not" and is the only number on this
 * screen that means somebody has work to do. A single column adding them
 * together would send a clerk to read forty rows of noise.
 */

export default function BillingRunsPage() {
  const { canView, canEdit } = usePermission("accounts");
  const { toast } = useToast();

  const [runs, setRuns] = useState<BillingRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await apiClient.get<BillingRunRow[]>("/api/v1/billing-runs"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load billing runs", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  /*
   * Poll only while something is actually moving. A finished run never
   * changes again, so a timer on this screen would be a request every
   * five seconds for a table that cannot differ.
   */
  const inFlight = runs.some((r) => r.status === "PENDING" || r.status === "RUNNING");
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Billing Runs"
        subtitle="One pass over a cycle, account by account — what billed, what did not, and why"
        actions={
          canEdit ? (
            <button onClick={() => setStarting(true)} style={PRIMARY_BTN}>
              Start a run
            </button>
          ) : undefined
        }
      />

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : runs.length === 0 ? (
        <div style={EMPTY}>
          No billing run yet.
          {canEdit ? (
            <>
              {" "}
              Starting one bills every account a cycle has due; nothing is owed until the
              run is posted.
            </>
          ) : null}
        </div>
      ) : (
        <div style={CARD}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <Th>Cycle</Th>
                <Th>Window</Th>
                <Th className={HIDE_SM}>Bill date</Th>
                <Th>Status</Th>
                <Th style={{ textAlign: "right" }}>Accounts</Th>
                <Th style={{ textAlign: "right" }}>Billed</Th>
                <Th style={{ textAlign: "right" }}>Failed</Th>
                <Th className={HIDE_SM} style={{ textAlign: "right" }}>
                  Skipped
                </Th>
                <Th className={HIDE_SM}>Posted</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link href={`/billing-runs/${r.id}`} style={LINK}>
                      {r.billingCycleName}
                    </Link>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {r.billingCycleCode}
                      {r.scheduled && " · scheduled"}
                    </div>
                  </Td>
                  <Td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {fmtDate(r.windowStart)} – {fmtDate(r.windowEnd)}
                  </Td>
                  <Td className={HIDE_SM} style={{ fontSize: 12 }}>
                    {fmtDate(r.billDate)}
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.accountCount.toLocaleString()}
                  </Td>
                  <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.billedCount.toLocaleString()}
                  </Td>
                  {/*
                    The only red number on the screen. A failure is an
                    account that should have billed and did not, so it
                    reads loudly or it does not get worked.
                  */}
                  <Td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {r.failedCount > 0 ? (
                      <span style={{ color: "var(--danger)", fontWeight: 700 }}>
                        {r.failedCount.toLocaleString()}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>0</span>
                    )}
                  </Td>
                  <Td
                    className={HIDE_SM}
                    style={{
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--text-muted)",
                    }}
                  >
                    {r.skippedCount.toLocaleString()}
                  </Td>
                  {/*
                    Posted is the question this list is most often opened
                    to answer: a run that calculated and was never posted
                    has raised no receivable, and nobody is being asked
                    for money.
                  */}
                  <Td className={HIDE_SM} style={{ fontSize: 12 }}>
                    {r.postedAt ? (
                      fmtDate(r.postedAt)
                    ) : (
                      <span style={{ color: "var(--warning)" }}>Not posted</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {starting && (
        <StartRunDialog
          onClose={() => setStarting(false)}
          onStarted={() => {
            setStarting(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

const HIDE_SM = "col-hide-sm";

const CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "auto",
};

const EMPTY: React.CSSProperties = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-muted)",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
};

const LINK: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--accent-primary)",
  textDecoration: "none",
};

const PRIMARY_BTN: React.CSSProperties = {
  padding: "7px 16px",
  background: "var(--accent-primary)",
  border: "1px solid var(--accent-primary)",
  borderRadius: "var(--radius)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

function Th({
  children,
  style,
  className,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <th
      className={className}
      style={{
        padding: "10px 16px",
        textAlign: "left",
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        borderBottom: "1px solid var(--border)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  style,
  className,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <td
      className={className}
      style={{
        padding: "12px 16px",
        fontSize: 13,
        color: "var(--text-primary)",
        borderBottom: "1px solid var(--border-subtle)",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </td>
  );
}
