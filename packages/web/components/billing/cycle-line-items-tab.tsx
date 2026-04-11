"use client";

import { useMemo } from "react";
import { StatCard } from "@/components/ui/stat-card";
import {
  mockCycleLineItems,
  fmtMoney,
  type LineItemState,
  type MockLineItem,
} from "@/lib/mock-billing";

/**
 * Billing cycle → Line items tab.
 *
 * Four-column kanban showing the BillingLineItem state machine
 * (Pending → Sent → Acked → Failed) from docs/specs/21-saaslogic-billing.md.
 * Stat row at the top mirrors the existing CIS stat-card style so it
 * looks consistent with the other cycle / customer / meter pages.
 */
interface CycleLineItemsTabProps {
  cycleId: string;
}

const COL_LABEL: Record<LineItemState, string> = {
  PENDING: "Pending",
  SENT: "Sent",
  ACKED: "Acked",
  FAILED: "Failed",
};

const COL_ORDER: LineItemState[] = ["PENDING", "SENT", "ACKED", "FAILED"];

export function CycleLineItemsTab({ cycleId }: CycleLineItemsTabProps) {
  const data = useMemo(() => mockCycleLineItems(cycleId), [cycleId]);

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
        <StatCard label="Line items" value={data.totals.lineItems} icon="📄" />
        <StatCard label="Agreements in cycle" value={data.totals.agreements} icon="👥" />
        <StatCard label="Pushed so far" value={fmtMoney(data.totals.pushedAmount)} icon="✓" />
        <StatCard label="Failures" value={data.totals.failures} icon="⚠" />
      </div>

      {/* Kanban */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
        }}
      >
        {COL_ORDER.map((state) => {
          const items = data.byState[state];
          const count = data.stateCounts[state];
          return (
            <KanbanColumn key={state} state={state} count={count} items={items} />
          );
        })}
      </div>

      <div
        style={{
          marginTop: 16,
          padding: "10px 16px",
          fontSize: 12,
          color: "var(--text-muted)",
          fontStyle: "italic",
          textAlign: "right",
        }}
      >
        Mock data — Phase 3 wiring pending
      </div>
    </div>
  );
}

function KanbanColumn({
  state,
  count,
  items,
}: {
  state: LineItemState;
  count: number;
  items: MockLineItem[];
}) {
  const headColor =
    state === "FAILED" ? "var(--danger)" : "var(--text-muted)";

  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        minHeight: 420,
      }}
    >
      <div
        style={{
          background: "var(--bg-elevated)",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: headColor,
        }}
      >
        <span>{COL_LABEL[state]}</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: state === "FAILED" ? "var(--danger)" : "var(--text-secondary)",
          }}
        >
          {count.toLocaleString()}
        </span>
      </div>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        {items.map((item) => (
          <LineItemCard key={item.id} item={item} state={state} />
        ))}
      </div>
    </div>
  );
}

function LineItemCard({ item, state }: { item: MockLineItem; state: LineItemState }) {
  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "10px 12px",
        fontSize: 12,
      }}
    >
      <div
        style={{
          fontWeight: 600,
          color: "var(--text-primary)",
          marginBottom: 4,
          fontSize: 12,
        }}
      >
        {item.agreementNumber} · {item.customerName}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          color: "var(--text-muted)",
          fontSize: 11,
        }}
      >
        <span style={{ color: state === "FAILED" ? "var(--danger)" : "var(--text-muted)" }}>
          {item.description}
        </span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            color: "var(--text-secondary)",
            fontWeight: 500,
          }}
        >
          {state === "FAILED"
            ? "retry"
            : item.amount > 0
              ? `$${item.amount.toFixed(2)}`
              : ""}
        </span>
      </div>
    </div>
  );
}
