"use client";

import { useEffect, useState } from "react";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { BillDetailDialog } from "./bill-detail-dialog";
import { BillStatusPill } from "./bill-status-pill";
import { BillRowActions } from "./bill-row-actions";

/**
 * The same shape the Bills page rows have, because this is the same
 * list of the same things.
 *
 * It used to be `Bill # · Period · Due · Total · Created` and a "View →"
 * link: no status, no PDF, none of the acts. The same bill therefore
 * read differently depending on which screen you found it on — and the
 * tempting shortcut, deriving status here from `total` and an open
 * amount, is the bug that made every fractional-cent bill read "Part
 * paid" with nothing paid. `overdue`, `partPaid` and `charge` come from
 * the API for that reason.
 */
interface BillSummary {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  billDate: string;
  dueDate: string;
  total: string;
  createdAt: string;
  accountId: string;
  postedAt: string | null;
  overdue: boolean;
  partPaid: boolean;
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
  /** Why this bill cannot be sent, or null when it is ready. */
  blockedReason: string | null;
  /** The newest delivery attempt, which decides Send versus Resend. */
  delivery: { status: string; sentAt: string | null; error: string | null } | null;
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const ymd = (s: string) => s.slice(0, 10);

export function BillsTab({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [bills, setBills] = useState<BillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showDialog, setShowDialog] = useState(false);
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [creating, setCreating] = useState(false);
  const [openBillId, setOpenBillId] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<BillSummary[]>(`/api/v1/accounts/${accountId}/bills`)
      .then(setBills)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [accountId, refreshKey]);

  const handleCreate = async () => {
    if (!asOfDate) return;
    setCreating(true);
    try {
      await apiClient.post(`/api/v1/accounts/${accountId}/bills`, { asOfDate });
      toast("Bill generated", "success");
      setShowDialog(false);
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
            Bill off cycle
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading...</div>
      ) : bills.length === 0 ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "32px 0",
            textAlign: "center",
            fontSize: "13px",
          }}
        >
          No bills yet. A cycle&apos;s bills come from a billing run; billing this account
          on its own is for the exceptions.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={th}>Bill #</th>
              <th style={th}>Period</th>
              <th style={th}>Due</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
              {/*
                Still owed earns its place over Created for the same
                reason it does on the Bills page: it is the question
                asked on a phone call. Created was only ever here
                because there was nothing better to show.
              */}
              <th style={{ ...th, textAlign: "right" }}>Still owed</th>
              <th style={th}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td style={td}>
                  {/*
                    The bill number opens the bill, as it does on the
                    Bills page — it is the identifier a caller reads out,
                    so it should be the thing you click. This row briefly
                    had a "View →" link next to a "View bill" button:
                    two controls, both called View, one opening the
                    segments and the other the PDF.
                  */}
                  <button
                    onClick={() => setOpenBillId(b.id)}
                    style={MONO_BUTTON}
                    title="View segments and line items"
                  >
                    {b.billNumber}
                  </button>
                </td>
                <td style={td}>
                  {ymd(b.periodStart)} → {ymd(b.periodEnd)}
                </td>
                <td style={td}>{ymd(b.dueDate)}</td>
                <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                  {fmt(b.total)}
                </td>
                <td
                  style={{
                    ...td,
                    textAlign: "right",
                    fontFamily: "monospace",
                    fontWeight: b.charge && Number(b.charge.openAmount) > 0 ? 600 : 400,
                    color:
                      b.charge && Number(b.charge.openAmount) > 0
                        ? "var(--text-primary)"
                        : "var(--text-muted)",
                  }}
                >
                  {b.charge ? fmt(b.charge.openAmount) : "—"}
                </td>
                <td style={td}>
                  <BillStatusPill bill={b} />
                </td>
                <td style={td}>
                  <BillRowActions bill={b} onChanged={() => setRefreshKey((k) => k + 1)} />
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
              Bill this account off cycle
            </h3>
            {/*
              Said before the date field, because the commonest reason
              to be here is looking for the normal path and not finding
              it. This one assembles unbilled segments for a single
              account; it rates nothing, and on an account whose cycle
              has already run there is usually nothing to assemble.
            */}
            <p
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                margin: "0 0 16px",
                lineHeight: 1.5,
              }}
            >
              A cycle&apos;s bills are made by a <b>billing run</b>. Use this for an exception —
              a final bill, or a correction. It will <b>not be posted</b>: review it, then post
              it, the same way a run works.
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                As of date
              </label>
              <DatePicker value={asOfDate} onChange={setAsOfDate} />
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" }}>
                Period auto-derived from this account&apos;s billing cycle. Override the date to bill an earlier period.
              </div>
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
                disabled={creating || !asOfDate}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: creating || !asOfDate ? "not-allowed" : "pointer",
                  opacity: creating || !asOfDate ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {creating ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        </div>
      )}

      {openBillId && (
        <BillDetailDialog billId={openBillId} onClose={() => setOpenBillId(null)} />
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
/** The bill number, as the Bills page renders it: mono, and clickable. */
const MONO_BUTTON: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--primary)",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
};
