"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RecordPaymentDialog } from "./record-payment-dialog";
import { AdjustDialog, type AdjustMode } from "./adjust-dialog";

/**
 * The account's receivable: what it owes, and every entry behind that
 * figure.
 *
 * Three rendering rules carry most of the value here, because each is a
 * way a plain table of rows misleads a reader:
 *
 *  1. Charged and still owed are separate columns. An open-item ledger's
 *     whole point is that a $40 charge with $15 outstanding is not the
 *     same as a $15 charge, and collapsing them to one number loses it.
 *  2. A negative balance is shown as "In credit $20.00", never as
 *     "Amount due -$20.00". The second is not English.
 *  3. A reversed entry and its reversal both appear — they are history
 *     and nothing is ever deleted — so both are marked, or a reader
 *     concludes they were charged twice.
 *
 * Actions follow the module that owns them, not one blanket "can edit":
 * posting a bill is `accounts:EDIT`, taking a payment is
 * `payments:CREATE`, reversing one is `payments:EDIT`. A button the user
 * cannot use is not rendered — and the API refuses it regardless, so the
 * hiding is courtesy rather than security.
 */

export interface LedgerRow {
  id: string;
  type: string;
  amount: string;
  openAmount: string;
  settled: boolean;
  effectiveDate: string;
  dueDate: string | null;
  postedAt: string;
  reasonCode: string | null;
  reasonLabel: string | null;
  billNumber: string | null;
  tender: string | null;
  memo: string | null;
  reversedByEntryId: string | null;
  reversesEntryId: string | null;
}

export interface LedgerPage {
  data: LedgerRow[];
  balance: string;
  openCount: number;
}

interface UnpostedBill {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  total: string;
}

/** Money for display. The sign is carried by the label, not the digits. */
const money = (s: string) => `$${Math.abs(parseFloat(s)).toFixed(2)}`;

/** Readable names for the enum. The reason's own label wins when there is one. */
const TYPE_LABEL: Record<string, string> = {
  BILL_CHARGE: "Bill charge",
  FEE: "Fee",
  ADJUSTMENT_DEBIT: "Charge",
  PAYMENT: "Payment",
  ADJUSTMENT_CREDIT: "Credit",
  WRITE_OFF: "Written off",
  REVERSAL: "Reversal",
};

function describe(row: LedgerRow): string {
  if (row.reasonLabel) return row.reasonLabel;
  return TYPE_LABEL[row.type] ?? row.type;
}

export function ArTab({ accountId }: { accountId: string }) {
  const { toast } = useToast();
  const { canView } = usePermission("accounts");
  const { canCreate: canTakePayment, canEdit: canReverse } = usePermission("payments");
  const { canCreate: canRaiseFee, canEdit: canForgive } = usePermission("ar_adjustments");

  const [page, setPage] = useState<LedgerPage | null>(null);
  const [unposted, setUnposted] = useState<UnpostedBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [reverseRow, setReverseRow] = useState<LedgerRow | null>(null);
  const [reversing, setReversing] = useState(false);
  const [adjust, setAdjust] = useState<{ mode: AdjustMode; target: LedgerRow | null } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiClient.get<LedgerPage>(`/api/v1/accounts/${accountId}/ledger`),
      // On accounts:VIEW, same as the ledger itself. The old gate here was
      // accounts:EDIT, copied from the Post button it used to guard, which
      // hid the note from the read-only users it is most useful to.
      apiClient
        .get<{ data: UnpostedBill[] }>(`/api/v1/accounts/${accountId}/unposted-bills`)
        .then((r) => r.data)
        .catch(() => [] as UnpostedBill[]),
    ])
      .then(([p, u]) => {
        setPage(p);
        setUnposted(u);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the ledger"))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

  async function confirmReverse() {
    if (!reverseRow) return;
    setReversing(true);
    try {
      const res = await apiClient.post<{ balance: string; dependentFees: { id: string }[] }>(
        `/api/v1/ledger-entries/${reverseRow.id}/reverse`,
        {},
      );
      // Dependent fees are reported and never reversed automatically
      // (§6.6) — so say so, or the operator assumes it was handled.
      const fees = res.dependentFees?.length ?? 0;
      toast(
        fees > 0
          ? `Reversed. Balance is now $${res.balance}. ${fees} fee${fees === 1 ? "" : "s"} assessed on this entry still stand${fees === 1 ? "s" : ""} — reverse them separately if they should go.`
          : `Reversed. Balance is now $${res.balance}.`,
        "success",
      );
      setReverseRow(null);
      load();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Could not reverse the entry", "error");
    } finally {
      setReversing(false);
    }
  }

  if (!canView) {
    return <div style={muted}>You do not have permission to view this account&apos;s ledger.</div>;
  }
  if (loading) return <div style={muted}>Loading…</div>;
  if (error) return <div style={{ ...muted, color: "var(--accent-danger, #b00)" }}>{error}</div>;
  if (!page) return null;

  const balance = parseFloat(page.balance);
  const inCredit = balance < 0;
  const settledUp = balance === 0;

  return (
    <div>
      {(canTakePayment || canRaiseFee) && (
        <div
          style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginBottom: "12px" }}
        >
          {canRaiseFee && (
            <button
              onClick={() => setAdjust({ mode: "fee", target: null })}
              style={secondaryButton}
            >
              Raise Fee
            </button>
          )}
          {canTakePayment && (
            <button onClick={() => setShowPayment(true)} style={primaryButton}>
              Record Payment
            </button>
          )}
        </div>
      )}

      {/*
        Why a note and not a work list: an unposted bill is a calculation,
        not a debt, so it is context for the balance below — it explains a
        balance lower than the customer expects — but it is not something
        this tab can act on. A tab that lists what is owed cannot show an
        unposted bill among its rows, so the Post action lives on Bills,
        where the bill itself lives.
      */}
      {unposted.length > 0 && (
        <div style={strip}>
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {unposted.length === 1
              ? "1 bill has been calculated but not posted, so it is not yet owed and is not counted below."
              : `${unposted.length} bills have been calculated but not posted, so they are not yet owed and are not counted below.`}{" "}
            <Link href="/bills?posted=false" style={stripLink}>
              Review in Bills
            </Link>
          </span>
        </div>
      )}

      {/* What the account owes, in words that are true for every sign. */}
      <div style={{ display: "flex", gap: "16px", marginBottom: "20px", flexWrap: "wrap" }}>
        <div style={card}>
          <div style={cardValue}>{settledUp ? "$0.00" : money(page.balance)}</div>
          <div style={cardLabel}>
            {settledUp ? "Nothing owed" : inCredit ? "In credit" : "Amount due"}
          </div>
        </div>
        <div style={card}>
          <div style={cardValue}>{page.openCount}</div>
          <div style={cardLabel}>{page.openCount === 1 ? "Open item" : "Open items"}</div>
        </div>
      </div>

      {page.data.length === 0 ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "32px 0",
            textAlign: "center",
            fontSize: "13px",
          }}
        >
          No ledger activity yet. A charge appears here when a bill is posted, or when a fee
          is raised against this account.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={th}>Date</th>
              <th style={th}>Entry</th>
              <th style={{ ...th, textAlign: "right" }}>Charged</th>
              <th style={{ ...th, textAlign: "right" }}>Still owed</th>
              <th style={th}>Detail</th>
              {(canReverse || canForgive) && <th style={th} aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {page.data.map((row) => {
              const isCredit = parseFloat(row.amount) < 0;
              const reversed = row.reversedByEntryId !== null;
              return (
                <tr key={row.id} style={reversed ? { opacity: 0.6 } : undefined}>
                  <td style={td}>{row.effectiveDate}</td>
                  <td style={td}>
                    {describe(row)}
                    {reversed && <span style={marker}>reversed</span>}
                    {row.reversesEntryId && <span style={marker}>reverses an earlier entry</span>}
                  </td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace" }}>
                    {/* A credit is shown in brackets, the accounting
                        convention, rather than as a minus sign a reader
                        has to notice. */}
                    {isCredit ? `(${money(row.amount)})` : money(row.amount)}
                  </td>
                  <td
                    style={{
                      ...td,
                      textAlign: "right",
                      fontFamily: "monospace",
                      fontWeight: row.settled ? 400 : 600,
                      color: row.settled ? "var(--text-muted)" : "var(--text-primary)",
                    }}
                  >
                    {row.settled ? "—" : money(row.openAmount)}
                  </td>
                  <td style={{ ...td, color: "var(--text-muted)", fontSize: "12px" }}>
                    {[
                      row.billNumber,
                      row.tender,
                      row.dueDate ? `due ${row.dueDate}` : null,
                      row.memo,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  {(canReverse || canForgive) && (
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      {/* Forgiving only makes sense on a charge that is
                          still owed: a credit cannot be waived, and a
                          settled charge has nothing left to forgive. */}
                      {canForgive && !reversed && !isCredit && !row.settled && (
                        <>
                          <button
                            onClick={() => setAdjust({ mode: "waive", target: row })}
                            style={linkButton}
                          >
                            Waive
                          </button>
                          <button
                            onClick={() => setAdjust({ mode: "writeOff", target: row })}
                            style={{ ...linkButton, marginLeft: "10px" }}
                          >
                            Write off
                          </button>
                        </>
                      )}
                      {/* A reversal is itself irreversible, and an entry
                          already reversed cannot be reversed again. */}
                      {canReverse && !reversed && row.type !== "REVERSAL" && (
                        <button
                          onClick={() => setReverseRow(row)}
                          style={{ ...linkButton, marginLeft: "10px" }}
                        >
                          Reverse
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showPayment && (
        <RecordPaymentDialog
          accountId={accountId}
          onClose={() => setShowPayment(false)}
          onRecorded={load}
        />
      )}

      {adjust && (
        <AdjustDialog
          mode={adjust.mode}
          accountId={accountId}
          target={
            adjust.target
              ? {
                  id: adjust.target.id,
                  amount: adjust.target.amount,
                  openAmount: adjust.target.openAmount,
                  label:
                    (adjust.target.reasonLabel ?? adjust.target.type) +
                    (adjust.target.billNumber ? ` (${adjust.target.billNumber})` : ""),
                }
              : null
          }
          onClose={() => setAdjust(null)}
          onDone={load}
        />
      )}

      {reverseRow && (
        <ConfirmDialog
          title="Reverse this entry?"
          message={`${describe(reverseRow)} of ${money(reverseRow.amount)} will be negated by a new entry. Nothing is deleted: both remain on the ledger, and anything this entry paid off becomes owed again.`}
          confirmLabel={reversing ? "Reversing…" : "Reverse entry"}
          confirmDisabled={reversing}
          onConfirm={confirmReverse}
          onCancel={() => setReverseRow(null)}
        />
      )}
    </div>
  );
}

const muted: React.CSSProperties = {
  color: "var(--text-muted)",
  padding: "24px 0",
  fontSize: "13px",
};
const card: React.CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "14px 18px",
  minWidth: "140px",
};
const cardValue: React.CSSProperties = {
  fontSize: "22px",
  fontWeight: 600,
  fontFamily: "monospace",
  color: "var(--text-primary)",
};
const cardLabel: React.CSSProperties = {
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  marginTop: "4px",
};
const marker: React.CSSProperties = {
  marginLeft: "8px",
  fontSize: "10px",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: "3px",
  padding: "1px 5px",
};
const primaryButton: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "none",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
const secondaryButton: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};
const linkButton: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent-primary)",
  fontSize: "12px",
  cursor: "pointer",
  fontFamily: "inherit",
  padding: 0,
};
const stripLink: React.CSSProperties = {
  color: "var(--primary)",
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const strip: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "12px 14px",
  marginBottom: "16px",
  background: "var(--bg-elevated)",
};
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
