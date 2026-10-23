"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { BillPdfButton } from "./bill-pdf-button";

interface SegmentLine {
  id: string;
  label: string;
  kindCode: string;
  amount: string;
  quantity: string | null;
  /** What the quantity counts — the tariff's unit, not always the meter's. */
  unit: string | null;
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
  /**
   * Carried so the document action can be gated the same way the list
   * row gates it. The detail payload has always included this; the type
   * simply left it out, which is why the dialog offered a PDF for an
   * unposted bill and spent a 404 and a 409 toast finding out.
   */
  postedAt: string | null;
  /**
   * Why this bill is held, or null. Carries the account's standing rule
   * when that is what holds it, so one field answers "can anything
   * happen to this bill".
   */
  holdReason: string | null;
  /** True when the account's rule holds it rather than the bill itself. */
  heldByAccount: boolean;
  subtotal: string;
  taxes: string;
  credits: string;
  total: string;
  segments: SegmentRow[];
}

/** One attempt to deliver this bill. */
interface Delivery {
  id: string;
  channel: string;
  status: string;
  recipientEmail: string | null;
  attempts: number;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const ymd = (s: string) => s.slice(0, 10);

export function BillDetailDialog({ billId, onClose }: { billId: string; onClose: () => void }) {
  const { toast } = useToast();
  const [bill, setBill] = useState<BillWithSegments | null>(null);
  const [loading, setLoading] = useState(true);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return apiClient
      .get<BillWithSegments>(`/api/v1/bills/${billId}`)
      .then(setBill)
      .catch(console.error);
  }, [billId]);

  const loadDeliveries = useCallback(() => {
    return apiClient
      .get<Delivery[]>(`/api/v1/bills/${billId}/deliveries`)
      .then(setDeliveries)
      // The bill still reads fine without its delivery history; a
      // failure here is not worth taking the dialog down for.
      .catch(() => setDeliveries([]));
  }, [billId]);

  useEffect(() => {
    void Promise.all([load(), loadDeliveries()]).finally(() => setLoading(false));
  }, [load, loadDeliveries]);

  /*
   * Hold, release and send all reload the bill rather than patching it
   * in place: each changes what the others may do, and a second source
   * of truth about that is how a stale Send button offers to post a bill
   * somebody just held.
   */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await Promise.all([load(), loadDeliveries()]);
    } catch (err) {
      toast(err instanceof Error ? err.message : "That did not work", "error");
    } finally {
      setBusy(false);
    }
  };

  const hold = () => {
    const reason = window.prompt("Why is this bill being held?")?.trim();
    // A hold nobody can explain is one nobody can clear, so an empty
    // reason is a cancelled action rather than a hold with no reason.
    if (!reason) return;
    void act(() => apiClient.post(`/api/v1/bills/${billId}/hold`, { reason }));
  };

  const release = () =>
    void act(() => apiClient.post(`/api/v1/bills/${billId}/release`, {}));

  const send = () =>
    void act(async () => {
      await apiClient.post(`/api/v1/bills/${billId}/deliver`, {});
      toast("Queued for delivery.", "success");
    });

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
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: "16px",
              }}
            >
              <div>
                <h3 style={{ margin: "0 0 6px", fontSize: "16px", color: "var(--text-primary)" }}>
                  {bill.billNumber}
                </h3>
                <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  {ymd(bill.periodStart)} → {ymd(bill.periodEnd)} · Due {ymd(bill.dueDate)}
                </div>
              </div>
              {/*
                The document actions live here rather than on the list
                row. Opening a bill is the deliberate act that regenerating
                its PDF deserves, and the row stays legible without it.
              */}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {bill.postedAt && (
                  <BillPdfButton
                    billId={bill.id}
                    billNumber={bill.billNumber}
                  />
                )}
                {/*
                  Send only once posted: an unposted bill is a
                  calculation nobody owes, and the API refuses it. Held
                  bills keep the button and are refused with the reason,
                  rather than hiding it and leaving the operator to
                  wonder.
                */}
                {bill.postedAt && (
                  <SmallButton onClick={send} disabled={busy} label="Send" />
                )}
                {bill.holdReason ? (
                  !bill.heldByAccount && (
                    <SmallButton onClick={release} disabled={busy} label="Release" />
                  )
                ) : (
                  <SmallButton onClick={hold} disabled={busy} label="Hold" />
                )}
              </div>
            </div>

            {/*
              The hold, said before the numbers. A held bill looks
              exactly like any other one — same lines, same total — and
              the only thing that distinguishes it is that nothing can
              happen to it. Which of the two holds it matters because
              they are released in different places: Release here clears
              the bill's own reason and would do nothing to the
              account's standing rule.
            */}
            {bill.holdReason && (
              <div
                style={{
                  background: "var(--warning-subtle)",
                  border: "1px solid var(--warning)",
                  borderRadius: "var(--radius)",
                  padding: "10px 14px",
                  marginBottom: 16,
                  fontSize: 12.5,
                  color: "var(--warning)",
                }}
              >
                <strong>
                  {bill.heldByAccount
                    ? "On hold — the account's billing is held"
                    : "On hold"}
                </strong>
                <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>
                  {bill.holdReason}
                </div>
                <div style={{ color: "var(--text-muted)", marginTop: 4, fontSize: 11 }}>
                  {bill.heldByAccount
                    ? "It cannot post or be sent until the account's hold is lifted, which is done on the account."
                    : "It cannot post or be sent until it is released."}
                </div>
              </div>
            )}

            {deliveries.length > 0 && (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: "10px 14px",
                  marginBottom: 16,
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    marginBottom: 6,
                  }}
                >
                  Delivery
                </div>
                {deliveries.map((d) => (
                  <div key={d.id} style={{ marginBottom: 4 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        color:
                          d.status === "SENT"
                            ? "var(--success)"
                            : d.status === "FAILED"
                              ? "var(--danger)"
                              : "var(--text-muted)",
                      }}
                    >
                      {d.status}
                    </span>{" "}
                    <span style={{ color: "var(--text-secondary)" }}>
                      {d.recipientEmail ?? "—"}
                    </span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {" · "}
                      {ymd(d.sentAt ?? d.createdAt)}
                    </span>
                    {/* The reason a bounce is worth a row of its own:
                        the bill looks sent and is not. */}
                    {d.error && (
                      <div style={{ color: "var(--danger)", fontSize: 11 }}>{d.error}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

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
                          {l.quantity
                            ? `${parseFloat(l.quantity).toFixed(2)}${l.unit ? ` ${l.unit}` : ""}`
                            : "—"}
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

/** The dialog's own action button, matching BillPdfButton's weight. */
function SmallButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 500,
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        color: "var(--text-primary)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontFamily: "inherit",
      }}
    >
      {label}
    </button>
  );
}
