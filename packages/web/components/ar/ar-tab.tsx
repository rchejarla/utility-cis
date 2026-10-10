"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

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
  const { canView } = usePermission("accounts");
  const [page, setPage] = useState<LedgerPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiClient
      .get<LedgerPage>(`/api/v1/accounts/${accountId}/ledger`)
      .then((p) => {
        setPage(p);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the ledger"))
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(load, [load]);

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
                </tr>
              );
            })}
          </tbody>
        </table>
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
