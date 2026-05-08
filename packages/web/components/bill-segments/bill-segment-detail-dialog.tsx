"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

interface BillSegmentLine {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  sourceScheduleId: string;
  sourceComponentId: string;
  sortOrder: number;
}
interface BillSegmentWithLines {
  id: string;
  segmentNumber: string;
  periodStart: string;
  periodEnd: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  minimumFloorApplied: boolean;
  lines: BillSegmentLine[];
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;

export function BillSegmentDetailDialog({
  segmentId,
  onClose,
}: {
  segmentId: string;
  onClose: () => void;
}) {
  const [segment, setSegment] = useState<BillSegmentWithLines | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<BillSegmentWithLines>(`/api/v1/bill-segments/${segmentId}`)
      .then(setSegment)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [segmentId]);

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
        {loading || !segment ? (
          <div style={{ color: "var(--text-muted)" }}>Loading...</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 8px", fontSize: "16px", color: "var(--text-primary)" }}>
              {segment.segmentNumber}
            </h3>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
              {segment.periodStart.slice(0, 10)} → {segment.periodEnd.slice(0, 10)}
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
                {segment.lines.map((l) => (
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
                    {fmt(segment.subtotal)}
                  </td>
                </tr>
                {parseFloat(segment.taxes) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Taxes</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(segment.taxes)}
                    </td>
                  </tr>
                )}
                {parseFloat(segment.credits) !== 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, textAlign: "right" }}>Credits</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                      {fmt(segment.credits)}
                    </td>
                  </tr>
                )}
                <tr>
                  <td colSpan={3} style={{ ...td, textAlign: "right", fontWeight: 700 }}>Total</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 700 }}>
                    {fmt(segment.total)}
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
