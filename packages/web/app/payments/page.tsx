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
 * The tenant-wide payments list.
 *
 * Answers the question no screen could answer before: what did we take,
 * and does it agree with the bank. Every payment view was scoped to one
 * account, so counting a day's receipts meant visiting accounts one at a
 * time.
 *
 * It opens on today, because that is the question being asked when
 * somebody comes here at all.
 */

interface PaymentRow {
  id: string;
  amount: string;
  tender: string | null;
  effectiveDate: string;
  externalRef: string | null;
  memo: string | null;
  reversed: boolean;
  account: { id: string; accountNumber: string; customerName: string | null };
}

interface PaymentPage {
  data: PaymentRow[];
  meta: { total: number; page: number; limit: number; pages: number };
  totalReceived: string;
}

const TENDERS = ["CASH", "CHECK", "CARD", "ACH", "LOCKBOX"];

/** Today in the browser's own date, not UTC — "today's takings" is local. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PaymentsPage() {
  const { canView } = usePermission("payments");
  const { toast } = useToast();

  const [page, setPage] = useState<PaymentPage | null>(null);
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
  // narrower result shows an empty table that reads as "no payments".
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
      setPage(await apiClient.get<PaymentPage>(`/api/v1/payments?${query}`));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load payments", "error");
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
      <PageHeader title="Payments" subtitle="Money received across all accounts" />

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
              label: "Tender",
              value: tender,
              options: TENDERS.map((t) => ({ label: title(t), value: t })),
              onChange: (v) => setTender(v),
            },
          ]}
        />
      </div>

      {/*
        The figure this page exists for. Stated as what was taken in the
        range rather than "total", because a reversed payment is still in
        it -- a cheque banked on Monday and bounced on Wednesday was in
        Monday's deposit, and netting it out would stop this agreeing with
        the bank, which is its only job.
      */}
      {page && (
        <div style={TOTAL_CARD}>
          <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>
            $
            {Number(page.totalReceived).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Taken {sameDay ? `on ${fmtDate(from)}` : from && to ? `between ${fmtDate(from)} and ${fmtDate(to)}` : "in total"}
            {tender ? ` by ${title(tender).toLowerCase()}` : ""} · {page.meta.total}{" "}
            {page.meta.total === 1 ? "payment" : "payments"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, maxWidth: 560 }}>
            As recorded on the day. A payment later reversed is still counted here, because the
            money was in that day&apos;s deposit — reversed rows are marked below.
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : !page || page.data.length === 0 ? (
        <div style={EMPTY}>
          {debounced ? `No payment matches “${debounced}”` : "No payments in this range."}
        </div>
      ) : (
        <>
          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Received</Th>
                  <Th>Account</Th>
                  <Th className="col-hide-sm">Customer</Th>
                  <Th>Tender</Th>
                  <Th className="col-hide-sm">Reference</Th>
                  <Th style={{ textAlign: "right" }}>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {page.data.map((p) => (
                  <tr key={p.id}>
                    <Td style={{ fontSize: 12 }}>{fmtDate(p.effectiveDate)}</Td>
                    <Td>
                      <Link href={`/accounts/${p.account.id}?tab=ar`} style={MONO_LINK}>
                        {p.account.accountNumber}
                      </Link>
                    </Td>
                    <Td className="col-hide-sm">{p.account.customerName ?? "—"}</Td>
                    <Td style={{ fontSize: 12 }}>{p.tender ? title(p.tender) : "—"}</Td>
                    <Td className="col-hide-sm" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {p.externalRef ?? "—"}
                    </Td>
                    <Td style={{ textAlign: "right" }}>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 13,
                          fontWeight: 600,
                          textDecoration: p.reversed ? "line-through" : undefined,
                          color: p.reversed ? "var(--text-muted)" : "var(--text-primary)",
                        }}
                      >
                        $
                        {Number(p.amount).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                      {p.reversed && (
                        <span style={REVERSED} title="Reversed — NSF or a correction">
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
 * Greenwich — a receipt would appear to be a day early.
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
  borderLeft: "3px solid var(--success)",
  borderRadius: "var(--radius)",
  padding: "14px 18px",
  marginBottom: 18,
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
  color: "var(--primary)",
  textDecoration: "none",
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
