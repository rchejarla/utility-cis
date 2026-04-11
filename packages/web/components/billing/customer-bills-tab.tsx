"use client";

import { useMemo } from "react";
import { StatCard } from "@/components/ui/stat-card";
import {
  mockCustomerBills,
  fmtMoney,
  fmtDateRange,
  type InvoiceStatus,
} from "@/lib/mock-billing";

// Invoice-status pill. Visual is identical to StatusBadge but routed
// directly to the right semantic tone (Paid → success, Overdue → danger,
// Partial → warning, Sent → info, Draft → neutral) instead of going
// through StatusBadge's domain-state mapping.
const STATUS_TONES: Record<
  InvoiceStatus,
  { bg: string; fg: string; border: string; label: string }
> = {
  DRAFT: {
    bg: "var(--bg-elevated)",
    fg: "var(--text-secondary)",
    border: "var(--border)",
    label: "Draft",
  },
  SENT: {
    bg: "var(--info-subtle)",
    fg: "var(--info)",
    border: "var(--info)",
    label: "Sent",
  },
  PARTIAL: {
    bg: "var(--warning-subtle)",
    fg: "var(--warning)",
    border: "var(--warning)",
    label: "Partial",
  },
  OVERDUE: {
    bg: "var(--danger-subtle)",
    fg: "var(--danger)",
    border: "var(--danger)",
    label: "Overdue",
  },
  PAID: {
    bg: "var(--success-subtle)",
    fg: "var(--success)",
    border: "var(--success)",
    label: "Paid",
  },
};

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const t = STATUS_TONES[status];
  return (
    <span
      role="status"
      aria-label={`Invoice status: ${t.label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        borderRadius: 999,
        background: t.bg,
        border: `1px solid ${t.border}`,
        fontSize: 11,
        fontWeight: 600,
        color: t.fg,
        whiteSpace: "nowrap",
        width: "fit-content",
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", background: t.fg, flexShrink: 0 }}
      />
      {t.label}
    </span>
  );
}

/**
 * Customer Bills tab.
 *
 * Renders a stat row and an invoice DataTable using `mock-billing`
 * data. Will be replaced with a real API call when Phase 3 ships the
 * invoice mirror table described in docs/specs/21-saaslogic-billing.md.
 * The shape of `MockCustomerBills` matches the planned response so
 * porting should be a one-line change.
 */
interface CustomerBillsTabProps {
  customerId: string;
  primaryPremiseLabel: string;
}

export function CustomerBillsTab({
  customerId,
  primaryPremiseLabel,
}: CustomerBillsTabProps) {
  const data = useMemo(
    () => mockCustomerBills(customerId, primaryPremiseLabel),
    [customerId, primaryPremiseLabel],
  );

  return (
    <div>
      {/* Stat row */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <StatCard label="Balance due" value={fmtMoney(data.summary.balanceDue)} icon="💰" />
        <StatCard label="Year to date" value={fmtMoney(data.summary.yearToDate)} icon="📅" />
        <StatCard label="Lifetime paid" value={fmtMoney(data.summary.lifetimePaid)} icon="✓" />
        <StatCard
          label="On-time rate"
          value={`${(data.summary.onTimeRate * 100).toFixed(1)}%`}
          icon="📈"
        />
      </div>

      {/* Invoice table */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th style={{ width: 160 }}>Invoice #</Th>
              <Th style={{ width: 200 }}>Period</Th>
              <Th>Premise</Th>
              <Th style={{ width: 150 }}>Commodities</Th>
              <Th style={{ width: 120, textAlign: "right" }}>Amount</Th>
              <Th style={{ width: 120 }}>Status</Th>
              <Th style={{ width: 150 }}>Action</Th>
            </tr>
          </thead>
          <tbody>
            {data.invoices.map((inv) => (
              <tr key={inv.id}>
                <Td>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {inv.invoiceNumber}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {fmtDateRange(inv.periodStart, inv.periodEnd)}
                  </span>
                </Td>
                <Td>{inv.premiseLabel}</Td>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {inv.commodities.join(" · ")}
                  </span>
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    {fmtMoney(inv.total)}
                  </span>
                </Td>
                <Td>
                  <InvoiceStatusBadge status={inv.status} />
                </Td>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                    {inv.status === "DRAFT" ? "Draft" : "View (Phase 3)"}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <span>
            Showing{" "}
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
              1–{data.invoices.length}
            </span>{" "}
            of{" "}
            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
              {data.summary.totalInvoiceCount}
            </span>
          </span>
          <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            Mock data — Phase 3 wiring pending
          </span>
        </div>
      </div>
    </div>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
      scope="col"
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

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
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
