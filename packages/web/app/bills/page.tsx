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
import { RecordPaymentDialog } from "@/components/ar/record-payment-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AdjustDialog, type AdjustMode } from "@/components/ar/adjust-dialog";

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
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
}

interface BillPage {
  data: BillRow[];
  meta: { total: number; page: number; limit: number; pages: number };
}

type PostedFilter = "all" | "unposted" | "posted";

export default function BillsPage() {
  const { canView, canEdit } = usePermission("accounts");
  const { canCreate: canTakePayment, canEdit: canReverse } = usePermission("payments");
  const { canEdit: canForgive } = usePermission("ar_adjustments");
  const { toast } = useToast();

  const [rows, setRows] = useState<BillRow[]>([]);
  const [meta, setMeta] = useState<BillPage["meta"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [payFor, setPayFor] = useState<BillRow | null>(null);
  const [voidRow, setVoidRow] = useState<BillRow | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [adjust, setAdjust] = useState<{ mode: AdjustMode; bill: BillRow } | null>(null);

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

  // One column for every act a CSR can perform here, so the header does
  // not appear for a user who can do none of them.
  const showActions = canEdit || canTakePayment || canReverse || canForgive;

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

  async function reverseCharge() {
    if (!voidRow?.charge) return;
    setVoiding(true);
    try {
      await apiClient.post(`/api/v1/ledger-entries/${voidRow.charge.entryId}/reverse`, {});
      toast(`${voidRow.billNumber} reversed — the charge no longer stands`, "success");
      setVoidRow(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not reverse the charge", "error");
    } finally {
      setVoiding(false);
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
                      {b.charge?.reversed ? (
                        <Pill tone="var(--text-muted)" title="The charge was reversed, so it no longer stands">
                          Reversed
                        </Pill>
                      ) : b.postedAt ? (
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
                    {showActions && (
                      <Td>
                        <div style={{ display: "flex", gap: 6 }}>
                          {/* Post only exists before posting; the rest only after. */}
                          {canEdit && !b.postedAt && (
                            <button
                              onClick={() => void post(b)}
                              disabled={posting === b.id}
                              style={POST_BTN(posting === b.id)}
                            >
                              {posting === b.id ? "Posting…" : "Post"}
                            </button>
                          )}
                          {/*
                            Payment is account-scoped, not bill-scoped:
                            recordPayment takes an accountId and §6.3
                            allocates oldest-first across fees, manual
                            debits and then bills. The label says "account"
                            so nobody reads this as paying off this bill.
                          */}
                          {canTakePayment && b.postedAt && (
                            <SmallBtn tone="var(--info)" onClick={() => setPayFor(b)}>
                              Take payment
                            </SmallBtn>
                          )}
                          {/*
                            There is no void. §3.5: a wrong charge is
                            reversed, and both sides stay on the ledger.
                            Offered only where it can succeed — a posted
                            bill with its own charge, not already reversed.
                          */}
                          {canReverse && b.charge && !b.charge.reversed && (
                            <SmallBtn tone="var(--danger)" onClick={() => setVoidRow(b)}>
                              Reverse
                            </SmallBtn>
                          )}
                          {/*
                            Waive and write off need something left to
                            forgive, so they are offered only while the
                            charge is still open. A settled charge has
                            nothing outstanding; a reversed one no longer
                            stands at all.
                          */}
                          {canForgive &&
                            b.charge &&
                            !b.charge.reversed &&
                            Number(b.charge.openAmount) > 0 && (
                              <>
                                <SmallBtn
                                  tone="var(--warning)"
                                  onClick={() => setAdjust({ mode: "waive", bill: b })}
                                >
                                  Waive
                                </SmallBtn>
                                <SmallBtn
                                  tone="var(--text-muted)"
                                  onClick={() => setAdjust({ mode: "writeOff", bill: b })}
                                >
                                  Write off
                                </SmallBtn>
                              </>
                            )}
                        </div>
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

      {payFor && (
        <RecordPaymentDialog
          accountId={payFor.account.id}
          onClose={() => setPayFor(null)}
          onRecorded={() => {
            setPayFor(null);
            void load();
          }}
        />
      )}

      {adjust?.bill.charge && (
        <AdjustDialog
          mode={adjust.mode}
          accountId={adjust.bill.account.id}
          target={{
            id: adjust.bill.charge.entryId,
            amount: adjust.bill.total,
            openAmount: adjust.bill.charge.openAmount,
            label: `Bill ${adjust.bill.billNumber}`,
          }}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            void load();
          }}
        />
      )}

      {voidRow && (
        <ConfirmDialog
          title={`Reverse ${voidRow.billNumber}?`}
          message={
            `This reverses the $${Number(voidRow.total).toFixed(2)} charge this bill raised, so it is no longer owed. ` +
            "Both the charge and its reversal stay on the ledger — nothing is deleted, and the bill itself is unchanged. " +
            "Use this when the charge was wrong. To forgive a charge that was correct, waive it instead."
          }
          confirmLabel={voiding ? "Reversing…" : "Reverse charge"}
          onConfirm={() => void reverseCharge()}
          onCancel={() => setVoidRow(null)}
        />
      )}
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

function SmallBtn({
  children,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  tone: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "3px 8px",
        fontSize: 10,
        fontWeight: 600,
        background: `${tone}18`,
        color: tone,
        border: `1px solid ${tone}40`,
        borderRadius: "var(--radius)",
        cursor: "pointer",
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
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
