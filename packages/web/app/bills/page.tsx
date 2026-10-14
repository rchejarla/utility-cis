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
import { BillPdfButton } from "@/components/bills/bill-pdf-button";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
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
  account: { id: string; accountNumber: string; customerName: string | null };
  charge: { entryId: string; openAmount: string; reversed: boolean } | null;
  /** Decided by the API, so the pill and the overdue filter agree. */
  overdue: boolean;
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
  const [regenerate, setRegenerate] = useState<BillRow | null>(null);
  const [regenerating, setRegenerating] = useState(false);

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

  /**
   * The exception-handling acts, behind More.
   *
   * Each keeps the availability rule it had when it sat on the row —
   * these are not merely hidden, they are still only offered where they
   * can succeed:
   *
   *  - Reverse: there is no void (§3.5). A wrong charge is reversed and
   *    both sides stay on the ledger, so it needs a charge that is not
   *    already reversed.
   *  - Waive / write off: both need something left to forgive. A settled
   *    charge has nothing outstanding; a reversed one no longer stands.
   *  - Regenerate: replaces the stored PDF, so the bill must be posted.
   */
  function moreActions(b: BillRow): ActionMenuItem[] {
    const items: ActionMenuItem[] = [];
    const open = b.charge && !b.charge.reversed && Number(b.charge.openAmount) > 0;

    /*
     * Ordered by how often it is reached and how much it costs to get
     * wrong: taking money first, then the document, then forgiveness,
     * and reversal last — furthest from where the pointer lands when
     * the menu opens.
     *
     * Payment is account-scoped, not bill-scoped: recordPayment takes an
     * accountId and §6.3 allocates oldest-first across fees, manual
     * debits and then bills. The label says "account" so nobody reads it
     * as paying off this bill alone.
     */
    if (canTakePayment && b.postedAt) {
      items.push({
        label: "Take payment on account",
        title: "Allocated oldest-first across what the account owes, not to this bill alone",
        onSelect: () => setPayFor(b),
      });
    }
    if (canEdit && b.postedAt) {
      items.push({
        label: "Regenerate PDF",
        title: "Replace the stored PDF with a freshly generated one",
        onSelect: () => setRegenerate(b),
      });
    }
    if (canForgive && open) {
      items.push({
        label: "Waive",
        title: "Forgive a charge that was correct",
        onSelect: () => setAdjust({ mode: "waive", bill: b }),
      });
      items.push({
        label: "Write off",
        title: "Give up on collecting this charge",
        onSelect: () => setAdjust({ mode: "writeOff", bill: b }),
      });
    }
    if (canReverse && b.charge && !b.charge.reversed) {
      items.push({
        label: "Reverse charge",
        tone: "danger",
        title: "Negate this bill's charge; both sides stay on the ledger",
        onSelect: () => setVoidRow(b),
      });
    }
    return items;
  }

  /**
   * Replace the stored PDF. The only writer of this; the PDF button
   * deliberately does not offer it, so the warning copy below is the one
   * place an operator is told what it does and does not do.
   */
  async function regenerateDocument() {
    if (!regenerate) return;
    setRegenerating(true);
    try {
      await apiClient.post(`/api/v1/bills/${regenerate.id}/document?force=true`, {});
      toast(`${regenerate.billNumber} was generated again`, "success");
      setRegenerate(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not generate the bill again", "error");
    } finally {
      setRegenerating(false);
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
                      {/*
                        Settled-ness, not just issuance. "Posted" was the
                        only thing this said once a bill was owed, so a
                        fully paid bill looked identical to an unpaid one
                        and the difference showed up as a dash in the
                        column before it.
                      */}
                      {b.charge?.reversed ? (
                        <Pill tone="var(--text-muted)" title="The charge was reversed, so it no longer stands">
                          Reversed
                        </Pill>
                      ) : b.charge && Number(b.charge.openAmount) === 0 ? (
                        <Pill tone="var(--success)" title="Nothing is owed on this bill">
                          Paid
                        </Pill>
                      ) : b.charge && isOverdue(b) ? (
                        <Pill tone="var(--danger)" title={`Was due ${fmtDate(b.dueDate)}`}>
                          Overdue
                        </Pill>
                      ) : b.charge && Number(b.charge.openAmount) < Number(b.total) ? (
                        <Pill tone="var(--warning)" title="Part of this bill has been paid">
                          Part paid
                        </Pill>
                      ) : b.postedAt ? (
                        <Pill tone="var(--info)" title={`Posted ${fmtDate(b.postedAt)} — still owed in full`}>
                          Outstanding
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
                          {/*
                            One act inline, and it is the one that only
                            reads: getting the bill as a PDF. Everything
                            that moves money or overwrites something sits
                            behind More, a deliberate click away, so the
                            row reads as a list of bills rather than a
                            control panel.

                            Post is the one exception, and it proves the
                            rule: it appears only before posting, when
                            PDF cannot (the API refuses an unposted bill
                            with a 409). The two are mutually exclusive,
                            so the row never carries more than one inline
                            action — and on an unposted bill Post is the
                            only act there is, so burying it would leave
                            the row with nothing.
                          */}
                          {canEdit && !b.postedAt && (
                            <button
                              onClick={() => void post(b)}
                              disabled={posting === b.id}
                              style={POST_BTN(posting === b.id)}
                            >
                              {posting === b.id ? "Posting…" : "Post"}
                            </button>
                          )}
                          <BillPdfButton
                            billId={b.id}
                            billNumber={b.billNumber}
                            disabled={!b.postedAt}
                            onChanged={() => void load()}
                          />
                          <ActionMenu
                            aria-label={`More actions for ${b.billNumber}`}
                            items={moreActions(b)}
                          />
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

      {regenerate && (
        <ConfirmDialog
          title={`Generate ${regenerate.billNumber} again?`}
          /*
           * Both sentences are here because operators expect the wrong
           * thing otherwise. "Generate again" sounds like it might
           * recalculate the bill, and it does not; and it overwrites
           * rather than keeping the old copy, which is the part that
           * cannot be undone.
           */
          message={
            "This does not change what is owed — nothing about the bill is recalculated. " +
            "It replaces the stored PDF with a freshly generated one; the previous copy is not kept. " +
            "Use it when the bill's own details have been corrected, or after a template change."
          }
          confirmLabel={regenerating ? "Generating…" : "Generate again"}
          destructive={false}
          onConfirm={() => void regenerateDocument()}
          onCancel={() => setRegenerate(null)}
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

/**
 * Past its due date with something still owed — as decided by the API.
 *
 * This used to be computed here from the browser's calendar date while
 * `state=overdue` computed it from UTC, so for the hours between local
 * midnight and UTC midnight the filter and the pill disagreed about the
 * same bill: it came back from the overdue filter and then rendered as
 * "Outstanding". Two copies of one judgement, in different zones.
 *
 * The row now carries the answer. The question is the utility's, not the
 * viewer's: a bill is late by the utility's calendar, whatever zone the
 * person looking at it happens to be in.
 */
function isOverdue(b: BillRow): boolean {
  return b.overdue;
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
