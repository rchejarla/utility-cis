"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { FilterBar } from "@/components/ui/filter-bar";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";

/**
 * The tenant-wide disbursements list — money that LEFT.
 *
 * The mirror of Receipts, and deliberately its own screen rather than a
 * direction column there: a receipts total is tied out against a bank
 * deposit slip, which contains only money in, and this one against a
 * cheque run. A single page netting the two would destroy both
 * reconciliations while looking tidier.
 *
 * Until this existed a refund was visible on one account's AR tab and
 * nowhere else, so "what did we pay out today" had no answer — the
 * mirror of the question Receipts was built to answer.
 *
 * It opens on today, because that is the question being asked by anyone
 * who comes here.
 */

type Pool = "CREDIT" | "DEPOSIT";

interface DisbursementRow {
  id: string;
  amount: string;
  /** Null for a refund with no applications behind it — see the service. */
  source: Pool | null;
  tender: string | null;
  effectiveDate: string;
  externalRef: string | null;
  memo: string | null;
  reversed: boolean;
  account: { id: string; accountNumber: string; customerName: string | null };
}

interface DisbursementPage {
  data: DisbursementRow[];
  meta: { total: number; page: number; limit: number; pages: number };
  totalPaidOut: string;
  subtotals: Record<Pool, string>;
}

const TENDERS = ["CHECK", "CASH", "CARD", "ACH", "LOCKBOX"];

/** Today in the browser's own date, not UTC — "today's payouts" is local. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const money = (s: string) =>
  Number(s).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DisbursementsPage() {
  const { canView } = usePermission("payments");
  const { toast } = useToast();

  const [page, setPage] = useState<DisbursementPage | null>(null);
  const [loading, setLoading] = useState(true);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [tender, setTender] = useState<string | undefined>();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pageNo, setPageNo] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // A filter change invalidates the page number: staying on page 3 of a
  // narrower result shows an empty table that reads as "nothing paid out".
  useEffect(() => {
    setPageNo(1);
  }, [debounced, tender, from, to]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(pageNo), limit: "25" });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (tender) p.set("tender", tender);
    if (debounced) p.set("search", debounced);
    return p.toString();
  }, [pageNo, from, to, tender, debounced]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await apiClient.get<DisbursementPage>(`/api/v1/disbursements?${query}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load disbursements", "error");
    } finally {
      setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView) return <AccessDenied />;

  const sameDay = from && from === to;

  return (
    <div>
      <PageHeader
        title="Money paid out"
        subtitle="Refunds and deposit returns across all accounts, for tying out against the cheque run"
      />

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={FIELD}>
          <span style={LABEL}>From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={INPUT} />
        </label>
        <label style={FIELD}>
          <span style={LABEL}>To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={INPUT} />
        </label>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cheque or reference…"
          aria-label="Search reference"
          style={{ ...INPUT, minWidth: 200 }}
        />
        <FilterBar
          filters={[
            {
              key: "tender",
              label: "Paid by",
              value: tender,
              options: TENDERS.map((t) => ({ label: title(t), value: t })),
              onChange: (v) => setTender(v),
            },
          ]}
        />
      </div>

      {/*
        One figure, because a cheque run is one figure, with the split
        beneath because the two are different liabilities discharged: a
        credit refund hands back money the customer overpaid, a deposit
        return releases collateral the utility was holding.

        A reversed refund stays IN the total, for the same reason a
        bounced cheque stays in the day it was banked: a refund written
        on Monday and voided on Wednesday left the building on Monday,
        and Monday's cheque run has to agree. The row is marked instead.
      */}
      {page && (
        <div style={TOTAL_CARD}>
          <div
            data-testid="disbursement-total"
            style={{ fontSize: 26, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}
          >
            ${money(page.totalPaidOut)}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Paid out {sameDay ? `on ${fmtDate(from)}` : from && to ? `between ${fmtDate(from)} and ${fmtDate(to)}` : "in total"}
            {tender ? ` by ${title(tender).toLowerCase()}` : ""} · {page.meta.total}{" "}
            {page.meta.total === 1 ? "payment" : "payments"}
          </div>
          {/*
            Both kinds always stated, including a zero: "no deposits were
            returned today" is an answer, and a line that vanishes at
            zero cannot be told from a screen that never looked.
          */}
          <div style={SPLIT} data-testid="disbursement-split">
            <span>
              Credit refunds <strong style={SPLIT_FIG}>${money(page.subtotals.CREDIT)}</strong>
            </span>
            <span style={{ color: "var(--border)" }}>|</span>
            <span>
              Deposit returns <strong style={SPLIT_FIG}>${money(page.subtotals.DEPOSIT)}</strong>
            </span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, maxWidth: 580 }}>
            As issued on the day. A refund later reversed is still counted here, because the money
            left on that day — reversed rows are marked below. Money received is on the Receipts
            screen; the two are never netted, because each is tied out against something different.
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : !page || page.data.length === 0 ? (
        <div style={EMPTY}>
          {debounced ? `No disbursement matches “${debounced}”` : "Nothing was paid out in this range."}
        </div>
      ) : (
        <>
          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Issued</Th>
                  <Th>Account</Th>
                  <Th className="col-hide-sm">Customer</Th>
                  {/* Never hidden: a deposit return and a credit refund
                      discharge different things, and the operator
                      reconciling the run needs to know which. */}
                  <Th>Kind</Th>
                  <Th>Paid by</Th>
                  <Th className="col-hide-sm">Reference</Th>
                  <Th style={{ textAlign: "right" }}>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {page.data.map((d) => (
                  <tr key={d.id}>
                    <Td style={{ fontSize: 12 }}>{fmtDate(d.effectiveDate)}</Td>
                    <Td>
                      <Link href={`/accounts/${d.account.id}?tab=ar`} style={MONO_LINK}>
                        {d.account.accountNumber}
                      </Link>
                    </Td>
                    <Td className="col-hide-sm">{d.account.customerName ?? "—"}</Td>
                    <Td>
                      {d.source === "DEPOSIT" ? (
                        <span style={TAG} title="Collateral the utility was holding, released">
                          Deposit return
                        </span>
                      ) : d.source === "CREDIT" ? (
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          Credit refund
                        </span>
                      ) : (
                        // No applications behind it. The service will not
                        // create one, so this means a hand-written row —
                        // said plainly rather than defaulted to a kind.
                        <span style={{ fontSize: 12, color: "var(--text-muted)" }} title="No credits recorded against this refund">
                          Unknown
                        </span>
                      )}
                    </Td>
                    <Td style={{ fontSize: 12 }}>{d.tender ? title(d.tender) : "—"}</Td>
                    <Td className="col-hide-sm" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {d.externalRef ?? "—"}
                    </Td>
                    <Td style={{ textAlign: "right" }}>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 13,
                          fontWeight: 600,
                          textDecoration: d.reversed ? "line-through" : undefined,
                          color: d.reversed ? "var(--text-muted)" : "var(--text-primary)",
                        }}
                      >
                        ${money(d.amount)}
                      </span>
                      {d.reversed && (
                        <span style={REVERSED} title="Reversed — a voided cheque or a correction">
                          reversed
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {page.meta.pages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
              <button onClick={() => setPageNo((p) => p - 1)} disabled={pageNo <= 1} style={PAGE_BTN(pageNo <= 1)}>
                Previous
              </button>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Page {page.meta.page} of {page.meta.pages}
              </span>
              <button
                onClick={() => setPageNo((p) => p + 1)}
                disabled={pageNo >= page.meta.pages}
                style={PAGE_BTN(pageNo >= page.meta.pages)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const title = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/**
 * Render a date-only value without letting the local timezone shift it.
 * `new Date("2026-06-30")` is UTC midnight, which is the 29th west of
 * Greenwich — a cheque would appear to be issued a day early.
 */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

const FIELD: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const LABEL: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};
const INPUT: React.CSSProperties = {
  padding: "7px 10px",
  fontSize: 13,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
};
const TOTAL_CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  // Not the success green Receipts uses: money leaving is not a win, and
  // two screens showing a big figure in the same colour invite a glance
  // at the wrong one.
  borderLeft: "3px solid var(--warning)",
  borderRadius: "var(--radius)",
  padding: "14px 18px",
  marginBottom: 18,
};
const SPLIT: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
  marginTop: 8,
  fontSize: 12,
  color: "var(--text-muted)",
};
const SPLIT_FIG: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontWeight: 600,
  color: "var(--text-primary)",
};
const CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "auto",
};
const EMPTY: React.CSSProperties = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-muted)",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
};
const MONO_LINK: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--accent-primary)",
  textDecoration: "none",
};
const TAG: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--accent-primary)",
  border: "1px solid var(--border)",
  borderRadius: 999,
};
const REVERSED: React.CSSProperties = {
  display: "inline-block",
  marginLeft: 8,
  padding: "1px 6px",
  fontSize: 9,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--danger)",
  background: "var(--danger)18",
  border: "1px solid var(--border)",
  borderRadius: 999,
};
const PAGE_BTN = (disabled: boolean): React.CSSProperties => ({
  padding: "5px 12px",
  fontSize: 12,
  fontWeight: 600,
  background: "var(--bg-card)",
  color: disabled ? "var(--text-muted)" : "var(--text-primary)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  cursor: disabled ? "default" : "pointer",
  fontFamily: "inherit",
});

function Th({
  children,
  style,
  className,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <th
      className={className}
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
  className,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <td
      className={className}
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
