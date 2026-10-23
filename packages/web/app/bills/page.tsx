"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { FilterBar } from "@/components/ui/filter-bar";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { BillDetailDialog } from "@/components/bills/bill-detail-dialog";
import { BillStatusPill } from "@/components/bills/bill-status-pill";
import { BillRowActions } from "@/components/bills/bill-row-actions";
import type { BillState } from "@utility-cis/shared";

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
  /** Where a payment or an adjustment is addressed; both are account-scoped. */
  accountId: string;
  account: { id: string; accountNumber: string; customerName: string | null };
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
  /** Decided by the API, so the pill and the overdue filter agree. */
  overdue: boolean;
  /**
   * Also decided by the API. Asking `openAmount < total` here compared a
   * 2dp ledger column to a 4dp bill column, so any bill with a
   * fractional cent read "Part paid" with nothing paid.
   */
  partPaid: boolean;
}

interface BillPage {
  data: BillRow[];
  meta: { total: number; page: number; limit: number; pages: number };
}

/**
 * The Status filter's labels, and the only place they live.
 *
 * It used to offer posted and not posted, which answers "is this a debt
 * yet" and nothing about whether it was paid — so a settled bill read as
 * "Posted" and the paid fact showed up only as a dash in another
 * column. Settlement is what a CSR and collections actually ask about.
 *
 * Overdue overlaps outstanding and part paid on purpose: a bill can be
 * late and part paid at once, and "show me the late ones" should not
 * depend on which.
 *
 * Keyed by `BillState` so the filter cannot drift from the enum the API
 * validates against: a state added there fails to compile here until it
 * is given a label, and a label for a state that no longer exists fails
 * too. Declaration order is the display order, which is why the list is
 * written out rather than mapped from `billStates.options` — the enum
 * orders by meaning, the menu orders overdue next to outstanding.
 */
const STATE_LABELS: Record<BillState, string> = {
  unposted: "Not posted",
  outstanding: "Outstanding",
  overdue: "Overdue",
  partPaid: "Part paid",
  paid: "Paid",
  reversed: "Reversed",
};

const STATE_OPTIONS = (Object.keys(STATE_LABELS) as BillState[]).map((value) => ({
  value,
  label: STATE_LABELS[value],
}));

type StateFilter = BillState | "all";

function Bills() {
  const { canView } = usePermission("accounts");
  const params = useSearchParams();
  const { toast } = useToast();

  const [rows, setRows] = useState<BillRow[]>([]);
  const [meta, setMeta] = useState<BillPage["meta"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);

  /*
   * A bill named in the URL opens straight away.
   *
   * How a billing run's Billed tab reaches one bill out of thousands.
   * It used to link to `?search=<bill id>`, and this list's search
   * matches bill number, account number and customer name — never an
   * id — so the operator landed on an empty list with a UUID in the
   * search box, which reads as "that bill does not exist".
   *
   * Read once per id rather than held in sync with the URL: closing the
   * dialog should not navigate, and reopening the same bill from the
   * list is the list's business.
   */
  const billParam = params.get("bill");
  useEffect(() => {
    if (billParam) setDetailId(billParam);
  }, [billParam]);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [state, setState] = useState<StateFilter>("all");
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
  }, [debounced, state]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ page: String(page), limit: "25" });
    if (debounced) p.set("search", debounced);
    if (state !== "all") p.set("state", state);
    return p.toString();
  }, [page, debounced, state]);

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

  // One column for every act a CSR can perform here, so the header does
  // not appear for a user who can do none of them. Downloading a bill's
  // PDF is a read, so anyone who can see this list has at least that.
  const showActions = canView;

  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Bills"
        subtitle="Every bill across all accounts — search by bill number, account number or customer"
      />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search bill, account or customer…"
          aria-label="Search bill number, account number or customer"
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
              key: "state",
              label: "Status",
              value: state === "all" ? undefined : state,
              options: STATE_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
              onChange: (v) => setState((v as StateFilter) ?? "all"),
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
            ? `Nothing matches “${debounced}” — tried bill numbers, account numbers and customer names`
            : state === "unposted"
              ? "Every bill has been posted — nothing waiting."
              : state === "overdue"
                ? "Nothing is overdue."
                : state !== "all"
                  ? `No bill is ${(STATE_OPTIONS.find((o) => o.value === state)?.label ?? state).toLowerCase()}.`
                  : "No bills yet."}
        </div>
      ) : (
        <>
          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Bill #</Th>
                  <Th className={HIDE_SM}>Account</Th>
                  <Th>Customer</Th>
                  <Th className={HIDE_MD}>Period</Th>
                  <Th className={HIDE_SM}>Due</Th>
                  <Th className={HIDE_SM} style={{ textAlign: "right" }}>Total</Th>
                  <Th style={{ textAlign: "right" }}>Still owed</Th>
                  <Th>Status</Th>
                  {showActions && <Th>Actions</Th>}
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
                    <Td className={HIDE_SM}>
                      <Link href={`/accounts/${b.account.id}`} style={MONO_LINK}>
                        {b.account.accountNumber}
                      </Link>
                    </Td>
                    <Td>{b.account.customerName ?? "—"}</Td>
                    <Td className={HIDE_MD} style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {fmtDate(b.periodStart)} – {fmtDate(b.periodEnd)}
                    </Td>
                    <Td className={HIDE_SM} style={{ fontSize: 12 }}>
                      {fmtDate(b.dueDate)}
                    </Td>
                    <Td className={HIDE_SM} style={{ textAlign: "right" }}>
                      <span style={MONEY}>
                        $
                        {Number(b.total).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </Td>
                    {/*
                      Still owed is not the total. A $64.20 bill with $15
                      left is not a $15 bill, and a CSR on a call needs the
                      second number without doing arithmetic. A dash where
                      there is no charge yet, rather than $0.00, which
                      would read as settled.
                    */}
                    <Td style={{ textAlign: "right" }}>
                      {b.charge ? (
                        <span
                          style={{
                            ...MONEY,
                            color:
                              Number(b.charge.openAmount) > 0
                                ? "var(--text-primary)"
                                : "var(--text-muted)",
                          }}
                        >
                          {Number(b.charge.openAmount) === 0
                            ? "—"
                            : `$${Number(b.charge.openAmount).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}`}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </Td>
                    <Td>
                      <BillStatusPill bill={b} />
                    </Td>
                    {showActions && (
                      <Td>
                        <BillRowActions bill={b} onChanged={() => void load()} />
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


/*
 * Which columns survive a narrow screen.
 *
 * Chosen by what a CSR cannot answer a call without, not by what fits:
 * the bill number they were read, who it belongs to, what is STILL OWED
 * -- not the original total, which is the question less often asked --
 * whether it is posted, and the actions. Period, due date, the account
 * number and the original total all remain one tap away in the bill
 * dialog, so nothing is lost, only deferred.
 */
const HIDE_SM = "col-hide-sm";
const HIDE_MD = "col-hide-md";

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

/**
 * `useSearchParams` makes this page client-rendered; the boundary is
 * what keeps Next from complaining about it during the build.
 */
export default function BillsPage() {
  return (
    <Suspense fallback={null}>
      <Bills />
    </Suspense>
  );
}
