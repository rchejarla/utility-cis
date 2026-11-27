"use client";

import { Fragment, useEffect, useState } from "react";
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
  /** The utility shows rate comparisons and this bill's tariff names one (spec 26, TOU-BIL-4). */
  rateComparison?: boolean;
}

/** One part of a bill, compared with its tariff's comparison rate. */
interface Comparison {
  segmentId: string;
  periodStart: string;
  periodEnd: string;
  actualTotal: string;
  actualRate: string;
  comparisonRate: string | null;
  comparisonTotal: string | null;
  difference: string | null;
  touUsageFrom: "registers" | "intervals" | null;
  unavailable: string | null;
}

type ComparisonState = { loading: true } | { comparisons: Comparison[] } | { failed: true };

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
  const [compared, setCompared] = useState<Record<string, ComparisonState>>({});

  const compare = (billId: string) => {
    setCompared((c) => ({ ...c, [billId]: { loading: true } }));
    apiClient
      .get<{ comparisons: Comparison[] }>(`/portal/api/bills/${billId}/rate-comparison`)
      .then((res) => setCompared((c) => ({ ...c, [billId]: { comparisons: res.comparisons } })))
      .catch(() => setCompared((c) => ({ ...c, [billId]: { failed: true } })));
  };

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
              <Fragment key={r.id}>
              <tr>
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
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <BillPdfButton
                      billId={r.id}
                      billNumber={r.billNumber}
                      surface="portal"
                    />
                    {r.rateComparison && !compared[r.id] && (
                      <button
                        type="button"
                        onClick={() => compare(r.id)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "var(--accent-primary)",
                          fontSize: 12,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          textDecoration: "underline",
                        }}
                      >
                        Compare rates
                      </button>
                    )}
                  </div>
                </Td>
              </tr>
              {compared[r.id] && (
                <tr>
                  <Td colSpan={showAccount ? 8 : 7}>
                    <ComparisonPanel state={compared[r.id]!} />
                  </Td>
                </tr>
              )}
              </Fragment>
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

/**
 * A bill compared with another rate, in the customer's terms: what the
 * other rate would have charged, and which way it went. Never a
 * recommendation — the utility decides what to say about switching.
 */
function ComparisonPanel({ state }: { state: ComparisonState }) {
  const box: React.CSSProperties = {
    whiteSpace: "normal",
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  };
  if ("loading" in state) return <div style={box}>Working out the comparison…</div>;
  if ("failed" in state) {
    return <div style={box}>The comparison could not be loaded just now. Please try again shortly.</div>;
  }
  return (
    <div data-testid="rate-comparison" style={{ ...box, display: "flex", flexDirection: "column", gap: 6 }}>
      {state.comparisons.map((c) => {
        if (c.unavailable || c.comparisonTotal === null || c.difference === null) {
          return <div key={c.segmentId}>{c.unavailable}</div>;
        }
        const diff = parseFloat(c.difference);
        const amount = fmt(Math.abs(diff).toFixed(2));
        return (
          <div key={c.segmentId}>
            {`${ymd(c.periodStart)} → ${ymd(c.periodEnd)}: `}
            on <b>{c.comparisonRate}</b> this would have cost <b>{fmt(c.comparisonTotal)}</b>, against{" "}
            {fmt(c.actualTotal)} on {c.actualRate}.{" "}
            <span data-testid="rate-comparison-verdict">
              {diff === 0
                ? "The same either way."
                : diff > 0
                  ? `Your rate saved you ${amount}.`
                  : `${c.comparisonRate} would have been ${amount} less.`}
            </span>
            {c.touUsageFrom === "intervals" && (
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {" "}
                Worked out from your meter&apos;s hourly readings.
              </span>
            )}
          </div>
        );
      })}
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
