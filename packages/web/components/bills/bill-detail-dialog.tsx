"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

interface SegmentLine {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  sortOrder: number;
}

interface SegmentRow {
  id: string;
  segmentNumber: string;
  serviceAgreementId: string;
  periodStart: string;
  periodEnd: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  lines: SegmentLine[];
}

interface BillWithSegments {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  billDate: string;
  dueDate: string;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  segments: SegmentRow[];
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const ymd = (s: string) => s.slice(0, 10);

export function BillDetailDialog({ billId, onClose }: { billId: string; onClose: () => void }) {
  const [bill, setBill] = useState<BillWithSegments | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<BillWithSegments>(`/api/v1/bills/${billId}`)
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
          width: "720px",
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        {loading || !bill ? (
          <div style={{ color: "var(--text-muted)" }}>Loading...</div>
        ) : (
          <>
            <h3 style={{ margin: "0 0 6px", fontSize: "16px", color: "var(--text-primary)" }}>
              {bill.billNumber}
            </h3>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "16px" }}>
              {ymd(bill.periodStart)} → {ymd(bill.periodEnd)} · Due {ymd(bill.dueDate)}
            </div>

            {bill.segments.map((seg) => (
              <div
                key={seg.id}
                style={{
                  marginBottom: "16px",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "var(--radius)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 14px",
                    background: "var(--bg-elevated)",
                    borderBottom: "1px solid var(--border-subtle)",
                  }}
                >
                  <span style={{ fontFamily: "monospace", fontSize: "12px", color: "var(--text-muted)" }}>
                    {seg.segmentNumber}
                  </span>
                  <span style={{ fontFamily: "monospace", fontSize: "13px", fontWeight: 600 }}>
                    {fmt(seg.total)}
                  </span>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>
                    {seg.lines.map((l) => (
                      <tr key={l.id}>
                        <td style={td}>
                          {l.label}
                          <span style={{ marginLeft: "8px", fontSize: "11px", color: "var(--text-muted)" }}>
                            {l.kindCode}
                          </span>
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
                </table>
              </div>
            ))}

            <div style={{ borderTop: "1px solid var(--border)", paddingTop: "12px", marginTop: "8px" }}>
              <Row label="Subtotal" value={fmt(bill.subtotal)} />
              {parseFloat(bill.taxes) !== 0 && <Row label="Taxes" value={fmt(bill.taxes)} />}
              {parseFloat(bill.credits) !== 0 && <Row label="Credits" value={fmt(bill.credits)} />}
              <Row label="Total" value={fmt(bill.total)} bold />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
              <button onClick={onClose} style={btn}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: bold ? 14 : 13, fontWeight: bold ? 700 : 400 }}>
      <span>{label}</span>
      <span style={{ fontFamily: "monospace" }}>{value}</span>
    </div>
  );
}

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
