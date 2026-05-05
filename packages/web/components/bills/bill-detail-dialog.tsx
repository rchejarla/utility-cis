"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

interface BillLine {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}
interface BillWithLines {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  lines: BillLine[];
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;

export function BillDetailDialog({ billId, onClose }: { billId: string; onClose: () => void }) {
  const [bill, setBill] = useState<BillWithLines | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<BillWithLines>(`/api/v1/bills/${billId}`)
      .then(setBill)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [billId]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px",
          width: "640px",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {loading || !bill ? (
          <div style={{ color: "var(--text-muted)" }}>Loading...</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "var(--text-primary)" }}>
              {bill.billNumber}
            </h3>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
              {bill.periodStart.slice(0, 10)} → {bill.periodEnd.slice(0, 10)}
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "16px" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <th style={th}>Line</th>
                  <th style={th}>Kind</th>
                  <th style={{ ...th, textAlign: "right" }}>Qty</th>
                  <th style={{ ...th, textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {bill.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>{l.label}</td>
                    <td style={{ ...td, color: "var(--text-muted)", fontSize: "11px" }}>
                      {l.kindCode}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {l.quantity ? parseFloat(l.quantity).toFixed(2) : "—"}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...td, textAlign: "right", fontWeight: 600 }}>
                    Subtotal
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                    {fmt(bill.subtotal)}
                  </td>
                </tr>
                {parseFloat(bill.taxes) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Taxes</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(bill.taxes)}
                    </td>
                  </tr>
                )}
                {parseFloat(bill.credits) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Credits</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(bill.credits)}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} style={{ ...td, textAlign: "right", fontWeight: 700 }}>Total</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>
                    {fmt(bill.total)}
                  </td>
                </tr>
              </tfoot>
            </table>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button onClick={onClose} style={btn}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "11px",
  textAlign: "left",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
};
const td: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
};
const btn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "inherit",
};
