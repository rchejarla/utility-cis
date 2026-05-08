"use client";

import { useEffect, useState } from "react";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { BillSegmentDetailDialog } from "./bill-segment-detail-dialog";

interface BillSegmentSummary {
  id: string;
  segmentNumber: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  createdAt: string;
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;

export function BillSegmentsTab({ saId, canEdit }: { saId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [segments, setSegments] = useState<BillSegmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDialog, setShowDialog] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [creating, setCreating] = useState(false);
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<BillSegmentSummary[]>(`/api/v1/service-agreements/${saId}/bill-segments`)
      .then(setSegments)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [saId, refreshKey]);

  const handleCreate = async () => {
    if (!periodStart || !periodEnd) return;
    setCreating(true);
    try {
      await apiClient.post(`/api/v1/service-agreements/${saId}/bill-segments`, {
        periodStart,
        periodEnd,
      });
      toast("Bill generated", "success");
      setShowDialog(false);
      setPeriodStart("");
      setPeriodEnd("");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.replace(/^API error \d+:\s*/, "") : "Bill generation failed";
      toast(msg, "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px" }}>
        {canEdit && (
          <button
            onClick={() => setShowDialog(true)}
            style={{
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "none",
              background: "var(--accent-primary)",
              color: "#fff",
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Generate Bill
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading...</div>
      ) : segments.length === 0 ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "32px 0",
            textAlign: "center",
            fontSize: "13px",
          }}
        >
          No bills yet. Click <b>Generate Bill</b> above to create one for a period.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={th}>Bill #</th>
              <th style={th}>Period</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
              <th style={th}>Created</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {segments.map((s) => (
              <tr key={s.id}>
                <td style={{ ...td, fontFamily: "monospace", fontSize: "12px" }}>{s.segmentNumber}</td>
                <td style={td}>
                  {s.periodStart.slice(0, 10)} → {s.periodEnd.slice(0, 10)}
                </td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                  {fmt(s.total)}
                </td>
                <td style={{ ...td, color: "var(--text-muted)", fontSize: "12px" }}>
                  {new Date(s.createdAt).toLocaleString()}
                </td>
                <td style={td}>
                  <button
                    onClick={() => setOpenSegmentId(s.id)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--accent-primary)",
                      fontSize: "12px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    View →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showDialog && (
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
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              width: "420px",
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: "16px", color: "var(--text-primary)" }}>
              Generate Bill
            </h3>
            <div style={{ marginBottom: "12px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                Period Start
              </label>
              <DatePicker value={periodStart} onChange={setPeriodStart} />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                Period End
              </label>
              <DatePicker value={periodEnd} onChange={setPeriodEnd} />
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowDialog(false)}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !periodStart || !periodEnd}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: creating || !periodStart || !periodEnd ? "not-allowed" : "pointer",
                  opacity: creating || !periodStart || !periodEnd ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {creating ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {openSegmentId && (
        <BillSegmentDetailDialog
          segmentId={openSegmentId}
          onClose={() => setOpenSegmentId(null)}
        />
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "11px",
  textAlign: "left",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
};
const td: React.CSSProperties = {
  padding: "10px 12px",
  fontSize: "13px",
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
};
