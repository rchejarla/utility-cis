"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { FilterBar } from "@/components/ui/filter-bar";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { BillDetailDialog } from "@/components/bills/bill-detail-dialog";

/**
 * The tenant-wide bill list.
 *
 * Exists because every other bill view was account-scoped: a CSR holding
 * a bill number had to already know whose account it was before they
 * could find it. Bill-number search is therefore the primary control, not
 * a refinement.
 *
 * Posted state is shown and acted on HERE rather than on the AR tab. A
 * bill is a calculation until it is posted; only then is it owed. The AR
 * tab lists what is owed, so by definition it cannot show an unposted
 * bill, and putting the Post action there put the manual-posting workflow
 * on the one screen that cannot display its subject.
 */

interface BillRow {
  id: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  periodStart: string;
  periodEnd: string;
  total: string;
  postedAt: string | null;
  billingCycleName: string | null;
  account: { id: string; accountNumber: string; customerName: string | null };
}

interface BillPage {
  data: BillRow[];
  meta: { total: number; page: number; limit: number; pages: number };
}

type PostedFilter = "all" | "unposted" | "posted";

export default function BillsPage() {
  const { canView, canEdit } = usePermission("accounts");
  const { toast } = useToast();

  const [rows, setRows] = useState<BillRow[]>([]);
  const [meta, setMeta] = useState<BillPage["meta"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [posted, setPosted] = useState<PostedFilter>("all");
  const [page, setPage] = useState(1);

  // Debounce the bill-number box: an operator types a whole number, and
  // a request per keystroke would both hammer the API and make the row
  // they are looking for flicker in and out as prefixes match.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Any filter change invalidates the page number — staying on page 4 of
  // a narrower result set shows an empty table and reads as "no results".
  useEffect(() => {
    setPage(1);
  }, [debounced, posted]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: "25" });
    if (debounced) p.set("search", debounced);
    if (posted !== "all") p.set("posted", posted === "posted" ? "true" : "false");
    return p.toString();
  }, [page, debounced, posted]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<BillPage>(`/api/v1/bills?${query}`);
      setRows(res.data ?? []);
      setMeta(res.meta ?? null);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load bills", "error");
    } finally {
      setLoading(false);
    }
  }, [query, toast]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  if (!canView) return <AccessDenied />;

  async function post(bill: BillRow) {
    setPosting(bill.id);
    try {
      await apiClient.post(`/api/v1/bills/${bill.id}/post`, {});
      toast(`Bill ${bill.billNumber} posted — it is now owed`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to post bill", "error");
    } finally {
      setPosting(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Bills"
        subtitle="Every bill across all accounts — search by bill number"
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search bill number…"
          aria-label="Search bill number"
          style={{
            padding: "7px 12px",
            fontSize: 13,
            minWidth: 240,
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-primary)",
            fontFamily: "inherit",
          }}
        />
        <FilterBar
          filters={[
            {
              key: "posted",
              label: "Status",
              value: posted === "all" ? undefined : posted,
              options: [
                { label: "Not posted", value: "unposted" },
                { label: "Posted", value: "posted" },
              ],
              onChange: (v) => setPosted((v as PostedFilter) ?? "all"),
            },
          ]}
        />
        {meta && (
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: "auto" }}>
            {meta.total.toLocaleString()} {meta.total === 1 ? "bill" : "bills"}
          </span>
        )}
      </div>

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div style={EMPTY}>
          {debounced
            ? `No bill number matches “${debounced}”`
            : posted === "unposted"
              ? "Every bill has been posted — nothing waiting."
              : "No bills yet."}
        </div>
      ) : (
        <>
          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Bill #</Th>
                  <Th>Account</Th>
                  <Th>Customer</Th>
                  <Th>Period</Th>
                  <Th>Due</Th>
                  <Th style={{ textAlign: "right" }}>Total</Th>
                  <Th>Status</Th>
                  {canEdit && <Th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <Td>
                      {/*
                        Opens the bill, not the account. A bill number is
                        the identifier a caller reads out, so looking it up
                        has to land on the bill itself — its segments and
                        line items — rather than on the account page, where
                        the operator would have to find it again.
                      */}
                      <button
                        onClick={() => setDetailId(b.id)}
                        style={MONO_BUTTON}
                        title="View segments and line items"
                      >
                        {b.billNumber}
                      </button>
                    </Td>
                    <Td>
                      <Link href={`/accounts/${b.account.id}`} style={MONO_LINK}>
                        {b.account.accountNumber}
                      </Link>
                    </Td>
                    <Td>{b.account.customerName ?? "—"}</Td>
                    <Td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}
                    </Td>
                    <Td style={{ fontSize: 12 }}>{fmtDate(b.dueDate)}</Td>
                    <Td style={{ textAlign: "right" }}>
                      <span style={MONEY}>
                        $
                        {Number(b.total).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </Td>
                    <Td>
                      {b.postedAt ? (
                        <Pill tone="var(--success)" title={`Posted ${fmtDate(b.postedAt)}`}>
                          Posted
                        </Pill>
                      ) : (
                        <Pill
                          tone="var(--warning)"
                          title="Calculated but not yet owed — it has not moved the account balance"
                        >
                          Not posted
                        </Pill>
                      )}
                    </Td>
                    {canEdit && (
                      <Td>
                        {!b.postedAt && (
                          <button
                            onClick={() => void post(b)}
                            disabled={posting === b.id}
                            style={POST_BTN(posting === b.id)}
                          >
                            {posting === b.id ? "Posting…" : "Post"}
                          </button>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {meta && meta.pages > 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
              <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1} style={PAGE_BTN(page <= 1)}>
                Previous
              </button>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                Page {meta.page} of {meta.pages}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= meta.pages}
                style={PAGE_BTN(page >= meta.pages)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {detailId && <BillDetailDialog billId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

/**
 * Render a date-only value without letting the local timezone shift it.
 * `new Date("2026-06-30")` is UTC midnight, which is the 29th west of
 * Greenwich — a bill would appear to be dated a day early.
 */
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

function Pill({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "2px 8px",
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        color: tone,
        background: `${tone}18`,
        border: `1px solid ${tone}40`,
        borderRadius: 999,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

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

const MONO_BUTTON: React.CSSProperties = {
  ...MONO_LINK,
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
};

const MONEY: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  fontWeight: 600,
};

const POST_BTN = (busy: boolean): React.CSSProperties => ({
  padding: "3px 10px",
  fontSize: 10,
  fontWeight: 600,
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: busy ? "default" : "pointer",
  opacity: busy ? 0.6 : 1,
  fontFamily: "inherit",
  whiteSpace: "nowrap",
});

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

function Th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <th
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

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
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
