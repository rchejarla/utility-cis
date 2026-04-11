"use client";

import { useMemo } from "react";
import { mockAgreementBilling, fmtMoney } from "@/lib/mock-billing";

/**
 * Service agreement → Billing tab.
 *
 * Two-column card layout: SaaSLogic subscription info on the left,
 * current cycle snapshot on the right. Recent activity table underneath.
 * Uses the existing CIS field-grid pattern (180px label / 1fr value).
 * Primary action buttons are present but disabled with a tooltip until
 * Phase 3 backend work lands.
 */
interface AgreementBillingTabProps {
  agreementId: string;
}

const cardStyle = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "20px 24px",
} as const;

const cardHeadingStyle = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-primary)",
  margin: "0 0 14px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
};

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: 8,
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};

const labelStyle = { fontSize: 12, color: "var(--text-muted)", fontWeight: 500 as const };
const valueStyle = { fontSize: 13, color: "var(--text-primary)" };
const monoValueStyle = {
  ...valueStyle,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
};

const disabledBtnStyle = {
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: 500,
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: "not-allowed",
  fontFamily: "inherit",
};

export function AgreementBillingTab({ agreementId }: AgreementBillingTabProps) {
  const data = useMemo(() => mockAgreementBilling(agreementId), [agreementId]);

  return (
    <div>
      {/* Two-column cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* SaaSLogic subscription */}
        <div style={cardStyle}>
          <h3 style={cardHeadingStyle}>SaaSLogic Subscription</h3>
          <Field label="Subscription ID" value={data.subscription.id} mono />
          <Field label="Plan" value={data.subscription.planId} mono />
          <Field label="Provisioned" value={data.subscription.provisionedAt} />
          <Field
            label="Link status"
            valueNode={
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--success-subtle)",
                  border: "1px solid var(--success)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--success)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--success)",
                  }}
                />
                Synced
              </span>
            }
          />
          <Field
            label="Last reconciled"
            value={`${data.subscription.lastReconciledSecondsAgo} seconds ago`}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button
              style={disabledBtnStyle}
              disabled
              title="Payment method management is hosted by SaaSLogic (Phase 3)"
            >
              Manage payment methods
            </button>
            <button
              style={disabledBtnStyle}
              disabled
              title="Ad-hoc charges are a Phase 3 feature"
            >
              Issue charge now
            </button>
          </div>
        </div>

        {/* Current cycle snapshot */}
        <div style={cardStyle}>
          <h3 style={cardHeadingStyle}>Current Cycle Snapshot</h3>
          <Field label="Period" value={data.currentCycle.period} />
          <Field label="Closes in" value={`${data.currentCycle.closesInDays} days`} />
          <Field label="Accumulated usage" value={data.currentCycle.usage} mono />
          <Field
            label="Estimated charge"
            valueNode={
              <span
                style={{
                  ...monoValueStyle,
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text-primary)",
                }}
              >
                {fmtMoney(data.currentCycle.estimatedCharge)}
              </span>
            }
          />
          <Field label="Last interval read" value={data.currentCycle.lastIntervalReadAt} />
          <Field
            label="Line item state"
            valueNode={
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--text-secondary)",
                  }}
                />
                Pending cycle close
              </span>
            }
          />
        </div>
      </div>

      {/* Recent activity */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-surface)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--text-muted)",
          }}
        >
          Recent activity
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th style={{ width: 160 }}>When</Th>
              <Th style={{ width: 200 }}>Event</Th>
              <Th>Detail</Th>
              <Th style={{ width: 140, textAlign: "right" }}>Amount</Th>
              <Th style={{ width: 120 }}>Status</Th>
            </tr>
          </thead>
          <tbody>
            {data.recentActivity.map((row, i) => (
              <tr key={i}>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.when}</span>
                </Td>
                <Td>{row.event}</Td>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{row.detail}</span>
                </Td>
                <Td style={{ textAlign: "right" }}>
                  {row.amount !== undefined ? (
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 13,
                        fontWeight: 600,
                      }}
                    >
                      {fmtMoney(row.amount)}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        fontStyle: "italic",
                      }}
                    >
                      —
                    </span>
                  )}
                </Td>
                <Td>
                  <ActivityBadge status={row.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <div
          style={{
            padding: "10px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text-muted)",
            fontStyle: "italic",
            textAlign: "right",
          }}
        >
          Mock data — Phase 3 wiring pending
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  valueNode,
  mono = false,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div style={fieldStyle}>
      <div style={labelStyle}>{label}</div>
      <div style={mono ? monoValueStyle : valueStyle}>{valueNode ?? value ?? "—"}</div>
    </div>
  );
}

function ActivityBadge({
  status,
}: {
  status: "DRAFT" | "SENT" | "PARTIAL" | "OVERDUE" | "PAID" | "SYNCED";
}) {
  const tones: Record<string, { bg: string; fg: string; border: string; label: string }> = {
    DRAFT: {
      bg: "var(--bg-elevated)",
      fg: "var(--text-secondary)",
      border: "var(--border)",
      label: "Draft",
    },
    SENT: { bg: "var(--info-subtle)", fg: "var(--info)", border: "var(--info)", label: "Sent" },
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
    SYNCED: {
      bg: "var(--bg-elevated)",
      fg: "var(--text-secondary)",
      border: "var(--border)",
      label: "Synced",
    },
  };
  const t = tones[status];
  return (
    <span
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
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: "50%", background: t.fg }}
      />
      {t.label}
    </span>
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
