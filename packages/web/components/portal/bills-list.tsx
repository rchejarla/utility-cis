"use client";

import { useEffect, useState } from "react";
import { StatCard } from "@/components/ui/stat-card";
import { apiClient } from "@/lib/api-client";
import { BillPdfButton } from "@/components/bills/bill-pdf-button";
import {
  BillStatusPill,
  type BillStatusFields,
} from "@/components/bills/bill-status-pill";

/**
 * A portal customer's bills, across every account they hold.
 *
 * A `Bill` belongs to an Account, not to a Customer, so there is no
 * customer-wide bill list to ask for: this reads the accounts the
 * portal already exposes and then each account's bills. The API
 * withholds unposted bills, which is why nothing here filters — a bill
 * the customer can see is one they owe or have paid.
 *
 * Replaces `lib/mock-billing`, which invented the invoice numbers, the
 * premises, the commodities, a lifetime-paid figure and an on-time
 * rate. Three of those have no source in this data model at all; the
 * two that do are derived here from what the API actually returns.
 *
 * Settlement state comes from the shared `BillStatusPill` rather than
 * being worked out locally. Asking the money columns in the browser is
 * the specific bug that ladder exists to prevent.
 */

interface PortalAccount {
  id: string;
  accountNumber: string;
}

interface PortalBill extends BillStatusFields {
  id: string;
  billNumber: string;
  periodStart: string;
  periodEnd: string;
  total: string;
}

/** A bill with the account it belongs to, for the combined list. */
interface Row extends PortalBill {
  accountNumber: string;
}

const fmt = (s: string) => `$${parseFloat(s).toFixed(2)}`;
const ymd = (s: string) => s.slice(0, 10);

export function BillsList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [accountCount, setAccountCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const accounts = await apiClient
          .get<{ data: PortalAccount[] }>("/portal/api/accounts")
          .then((r) => r.data ?? []);
        if (!live) return;
        setAccountCount(accounts.length);

        const perAccount = await Promise.all(
          accounts.map(async (a) => {
            const bills = await apiClient
              .get<{ data: PortalBill[] }>(`/portal/api/accounts/${a.id}/bills`)
              .then((r) => r.data ?? [])
              .catch(() => [] as PortalBill[]);
            return bills.map((b) => ({ ...b, accountNumber: a.accountNumber }));
          }),
        );
        if (!live) return;
        setRows(
          perAccount
            .flat()
            .sort((x, y) => (x.periodEnd < y.periodEnd ? 1 : -1)),
        );
      } catch {
        if (live) setFailed(true);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // What is still owed, summed from the open charges. The sum of the
  // totals would include every bill already paid.
  const due = rows.reduce(
    (sum, r) =>
      r.charge && !r.charge.reversed ? sum + parseFloat(r.charge.openAmount) : sum,
    0,
  );

  const showAccount = accountCount > 1;

  if (failed) {
    return (
      <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
        Your bills could not be loaded just now. Please try again shortly.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <div data-testid="portal-amount-due">
          <StatCard label="Amount due" value={fmt(due.toFixed(2))} icon="💰" />
        </div>
        <StatCard label="Bills" value={String(rows.length)} icon="📄" />
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <Th style={{ width: 140 }}>Bill #</Th>
              {showAccount && <Th style={{ width: 120 }}>Account</Th>}
              <Th style={{ width: 200 }}>Period</Th>
              <Th style={{ width: 120 }}>Due</Th>
              <Th style={{ width: 120, textAlign: "right" }}>Amount</Th>
              <Th style={{ width: 120, textAlign: "right" }}>Still owed</Th>
              <Th style={{ width: 120 }}>Status</Th>
              <Th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {r.billNumber}
                  </span>
                </Td>
                {showAccount && (
                  <Td>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {r.accountNumber}
                    </span>
                  </Td>
                )}
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {`${ymd(r.periodStart)} → ${ymd(r.periodEnd)}`}
                  </span>
                </Td>
                <Td>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                    {ymd(r.dueDate)}
                  </span>
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Money value={r.total} />
                </Td>
                <Td style={{ textAlign: "right" }}>
                  <Money
                    value={r.charge && !r.charge.reversed ? r.charge.openAmount : "0"}
                    bold
                  />
                </Td>
                <Td>
                  <BillStatusPill bill={r} />
                </Td>
                <Td>
                  <BillPdfButton
                    billId={r.id}
                    billNumber={r.billNumber}
                    surface="portal"
                  />
                </Td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <Td colSpan={showAccount ? 8 : 7}>
                  <span
                    style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}
                  >
                    No bills yet. Your first bill will appear here once it has been issued.
                  </span>
                </Td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Money({ value, bold = false }: { value: string; bold?: boolean }) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        fontWeight: bold ? 600 : 400,
      }}
    >
      {fmt(value)}
    </span>
  );
}

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
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

function Td({
  children,
  style,
  colSpan,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
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
