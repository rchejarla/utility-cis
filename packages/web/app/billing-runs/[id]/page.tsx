"use client";

import { useCallback, useEffect, useState, use } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { fmtDate, fmtMoney, daysInclusive } from "@/components/billing-runs/run-format";
import type { BillingRunItemRow, BillingRunRow } from "@/components/billing-runs/run-format";

/**
 * One billing run: what billed, what did not, and the one button that
 * turns the first into money owed.
 *
 * Failures open first. A run's counts are on the cards above, so the
 * question this screen exists to answer is "what didn't bill?" — and
 * failures are the only part of that which is work. Skipped accounts get
 * their own tab rather than a row in the same table: "no read in the
 * window" is the ordinary state of an account whose meter has not been
 * read yet, and mixed in with real failures it buries them.
 *
 * Posting is deliberately a second act. The run calculated; until it is
 * posted no receivable exists, no balance moved, and no customer is
 * being asked for anything. That is the whole reason a run is reviewable
 * at all, so the button says what it will raise before it raises it.
 */

interface RunDetail extends BillingRunRow {
  billedTotal: string;
}

interface PostResult {
  posted: number;
  alreadyPosted: number;
  failed: number;
}

const TAB_STATUS: Record<string, string | undefined> = {
  failures: "FAILED",
  skipped: "SKIPPED",
  billed: "BILLED",
  details: undefined,
};

export default function BillingRunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { canView, canEdit } = usePermission("accounts");
  const { toast } = useToast();

  const [run, setRun] = useState<RunDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState("failures");
  const [items, setItems] = useState<BillingRunItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [confirmPost, setConfirmPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [resuming, setResuming] = useState(false);

  const loadRun = useCallback(async () => {
    try {
      setRun(await apiClient.get<RunDetail>(`/api/v1/billing-runs/${id}`));
    } catch (err) {
      setNotFound(true);
      toast(err instanceof Error ? err.message : "Failed to load the run", "error");
    }
  }, [id, toast]);

  const loadItems = useCallback(async () => {
    const status = TAB_STATUS[tab];
    if (!status) return;
    setItemsLoading(true);
    try {
      const query: Record<string, string> = { status, limit: "500" };
      setItems(
        await apiClient.get<BillingRunItemRow[]>(`/api/v1/billing-runs/${id}/items`, query),
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load accounts", "error");
    } finally {
      setItemsLoading(false);
    }
  }, [id, tab, toast]);

  useEffect(() => {
    if (canView) void loadRun();
  }, [canView, loadRun]);

  useEffect(() => {
    if (canView) void loadItems();
  }, [canView, loadItems]);

  /*
   * While the run is still going, both halves of the screen are stale
   * the moment they render — the counts climb and the item list grows.
   * A finished run never changes, so the timer stops with it.
   */
  const inFlight = run?.status === "PENDING" || run?.status === "RUNNING";
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      void loadRun();
      void loadItems();
    }, 5000);
    return () => clearInterval(t);
  }, [inFlight, loadRun, loadItems]);

  const post = async () => {
    setPosting(true);
    try {
      const res = await apiClient.post<PostResult>(`/api/v1/billing-runs/${id}/post`, {});
      setConfirmPost(false);
      toast(describePosting(res), res.failed > 0 ? "error" : "success");
      await loadRun();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Posting failed", "error");
    } finally {
      setPosting(false);
    }
  };

  const cancel = async () => {
    try {
      await apiClient.post(`/api/v1/billing-runs/${id}/cancel`, {});
      toast("Cancellation requested. The run stops after the account it is on.", "info");
      await loadRun();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Cancel failed", "error");
    }
  };

  /**
   * Put the accounts this run did not bill back in the queue.
   *
   * The only way forward from a run that did not finish: one run per
   * cycle window is a database constraint, so the period cannot be
   * started again. Accounts already billed are untouched — the worker
   * bills only PENDING items.
   */
  const resume = async () => {
    setResuming(true);
    try {
      await apiClient.post(`/api/v1/billing-runs/${id}/resume`, {});
      toast("Resumed. The accounts it could not bill are queued again.", "success");
      await loadRun();
      await loadItems();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Resume failed", "error");
    } finally {
      setResuming(false);
    }
  };

  if (!canView) return <AccessDenied />;
  if (notFound) {
    return (
      <div>
        <PageHeader title="Billing run" subtitle="Not found" />
        <p style={{ color: "var(--text-muted)" }}>
          No run with this id. <Link href="/billing-runs" style={{ color: "var(--primary)" }}>Back to all runs</Link>
        </p>
      </div>
    );
  }
  if (!run) return <p style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading…</p>;

  const finished = !inFlight;
  const canPost = canEdit && finished && run.billedCount > 0 && !run.postedAt;
  /*
   * FAILED, PARTIAL and CANCELLED all mean the same thing — some
   * accounts are not billed — and all three are dead ends without this,
   * since the window cannot be run again. COMPLETE has nothing left.
   */
  const canResume =
    canEdit && ["FAILED", "PARTIAL", "CANCELLED"].includes(run.status) && !run.postedAt;

  return (
    <div>
      <PageHeader
        title={`${run.billingCycleName} — ${fmtDate(run.windowEnd)}`}
        subtitle={`Window ${fmtDate(run.windowStart)} – ${fmtDate(run.windowEnd)} · billed ${fmtDate(
          run.billDate,
        )} · due ${fmtDate(run.dueDate)}`}
        actions={
          <div style={{ display: "flex", gap: 8 }}>
            {canEdit && inFlight && !run.cancelRequested && (
              <button onClick={() => void cancel()} style={WARNING_BTN}>
                Cancel run
              </button>
            )}
            {canResume && (
              <button
                onClick={() => void resume()}
                disabled={resuming}
                style={{ ...WARNING_BTN, opacity: resuming ? 0.6 : 1 }}
                title="Queue the accounts this run did not bill. Accounts already billed are untouched."
              >
                {resuming ? "Resuming…" : "Resume"}
              </button>
            )}
            {canPost && (
              <button onClick={() => setConfirmPost(true)} style={PRIMARY_BTN}>
                Post this run
              </button>
            )}
          </div>
        }
      />

      {/*
        Said plainly, because every other screen in the app shows bills
        that are already owed. A run that has not been posted looks
        finished and has moved no money at all.
      */}
      {finished && !run.postedAt && run.billedCount > 0 && (
        <Banner tone="warning">
          {run.billedCount.toLocaleString()} bills calculated, none posted — no customer owes
          any of it yet. Review the failures, then post the run.
        </Banner>
      )}
      {run.postedAt && (
        <Banner tone="success">
          Posted {fmtDate(run.postedAt)} — these bills are now receivables on their accounts.
        </Banner>
      )}
      {run.cancelRequested && inFlight && (
        <Banner tone="warning">
          Cancellation requested — the run stops after the account it is on. What it already
          billed stays billed, and can still be posted.
        </Banner>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        <Stat label="Status" value={<StatusBadge status={run.status} />} />
        <Stat label="Accounts due" value={run.accountCount.toLocaleString()} />
        <Stat
          label="Billed"
          value={run.billedCount.toLocaleString()}
          accent="var(--success)"
        />
        <Stat
          label="Failed"
          value={run.failedCount.toLocaleString()}
          accent={run.failedCount > 0 ? "var(--danger)" : undefined}
        />
        <Stat label="Skipped" value={run.skippedCount.toLocaleString()} />
        <Stat label="Billed total" value={fmtMoney(run.billedTotal)} />
      </div>

      <Tabs
        tabs={[
          { key: "failures", label: `Failures (${run.failedCount})` },
          { key: "skipped", label: `Skipped (${run.skippedCount})` },
          { key: "billed", label: `Billed (${run.billedCount})` },
          { key: "details", label: "Details" },
        ]}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === "details" ? (
          <div style={CARD_PAD}>
            <KV k="Started" v={new Date(run.createdAt).toLocaleString()} />
            <KV
              k="Last progress"
              v={run.lastProgressAt ? new Date(run.lastProgressAt).toLocaleString() : "—"}
            />
            <KV k="Cycle" v={`${run.billingCycleName} (${run.billingCycleCode})`} />
            <KV
              k="Window"
              v={`${fmtDate(run.windowStart)} – ${fmtDate(run.windowEnd)} (${daysInclusive(
                run.windowStart,
                run.windowEnd,
              )} days)`}
            />
            <KV k="Bill date" v={fmtDate(run.billDate)} />
            <KV k="Due date" v={fmtDate(run.dueDate)} />
            <KV k="Posted" v={run.postedAt ? new Date(run.postedAt).toLocaleString() : "Not posted"} />
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12, marginBottom: 0 }}>
              The window decides which accounts are due. What each bill covers is its own
              service period, read to read, which is why two accounts on one run can carry
              different dates.
            </p>
          </div>
        ) : itemsLoading ? (
          <p style={{ color: "var(--text-muted)" }}>Loading…</p>
        ) : items.length === 0 ? (
          <div style={EMPTY}>{emptyFor(tab, run)}</div>
        ) : (
          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Account</Th>
                  <Th>Customer</Th>
                  {tab === "billed" ? (
                    <>
                      <Th>Service period</Th>
                      <Th style={{ textAlign: "right" }}>Segments</Th>
                      <Th style={{ textAlign: "right" }}>Total</Th>
                      <Th>Bill</Th>
                    </>
                  ) : (
                    <>
                      <Th>Reason</Th>
                      <Th>What it says</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <Td>
                      <Link href={`/accounts/${i.accountId}`} style={MONO_LINK}>
                        {i.accountNumber}
                      </Link>
                    </Td>
                    <Td>{i.customerName ?? "—"}</Td>
                    {tab === "billed" ? (
                      <>
                        <Td style={{ fontSize: 12, color: "var(--text-muted)" }}>
                          {i.servicePeriodStart && i.servicePeriodEnd
                            ? `${fmtDate(i.servicePeriodStart)} – ${fmtDate(
                                i.servicePeriodEnd,
                              )} (${daysInclusive(i.servicePeriodStart, i.servicePeriodEnd)}d)`
                            : "—"}
                        </Td>
                        <Td style={{ textAlign: "right" }}>{i.segmentCount}</Td>
                        <Td style={{ textAlign: "right" }}>
                          <span style={MONEY}>{fmtMoney(i.total)}</span>
                        </Td>
                        <Td>
                          {i.billId ? (
                            <Link href={`/bills?search=${i.billId}`} style={MONO_LINK}>
                              View
                            </Link>
                          ) : (
                            "—"
                          )}
                        </Td>
                      </>
                    ) : (
                      <>
                        {/*
                          The code, not the sentence, is what an operator
                          sorts and groups by — forty accounts with no
                          read are one job, and forty different codes are
                          forty.
                        */}
                        <Td>
                          <span
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 11,
                              fontWeight: 600,
                              color: tab === "failures" ? "var(--danger)" : "var(--text-muted)",
                            }}
                          >
                            {i.errorCode ?? "—"}
                          </span>
                        </Td>
                        <Td style={{ whiteSpace: "normal", fontSize: 12 }}>
                          {i.errorMessage ?? "—"}
                        </Td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Tabs>

      <div style={{ marginTop: 16 }}>
        <Link href="/billing-runs" style={{ color: "var(--primary)", fontSize: 13 }}>
          ← Back to all runs
        </Link>
      </div>

      {confirmPost && (
        <ConfirmDialog
          title="Post this run?"
          message={`${run.billedCount.toLocaleString()} bills totalling ${fmtMoney(
            run.billedTotal,
          )} become receivables on their accounts. Posting cannot be undone — a wrong charge is reversed afterwards, on the ledger, in full view.${
            run.failedCount > 0
              ? ` ${run.failedCount.toLocaleString()} accounts failed and are not included; they stay unbilled until somebody fixes them.`
              : ""
          }`}
          confirmLabel={posting ? "Posting…" : "Post the run"}
          cancelLabel="Not yet"
          confirmDisabled={posting}
          destructive={false}
          onConfirm={() => void post()}
          onCancel={() => setConfirmPost(false)}
        />
      )}
    </div>
  );
}

/**
 * What posting did, in one sentence.
 *
 * `alreadyPosted` is not an error: somebody posting a bill by hand
 * between the run and this click agrees with us about the outcome, and
 * the service deliberately tolerates it. It is still worth saying, so
 * the number of bills posted here matches what the operator sees.
 */
function describePosting(res: PostResult): string {
  const parts = [`${res.posted.toLocaleString()} posted`];
  if (res.alreadyPosted > 0) parts.push(`${res.alreadyPosted.toLocaleString()} already posted`);
  if (res.failed > 0) parts.push(`${res.failed.toLocaleString()} could not post`);
  return parts.join(", ") + ".";
}

function emptyFor(tab: string, run: BillingRunRow): string {
  if (tab === "failures") {
    return run.status === "PENDING"
      ? "The run has not started yet."
      : "Nothing failed. Every account that was due either billed or had nothing to bill.";
  }
  if (tab === "skipped") return "No account was skipped — every one that was due had something to bill.";
  return run.billedCount === 0
    ? "Nothing has billed yet."
    : "No bills to show.";
}

function Banner({ tone, children }: { tone: "warning" | "success"; children: React.ReactNode }) {
  const color = tone === "warning" ? "var(--warning)" : "var(--success)";
  return (
    <div
      style={{
        background: tone === "warning" ? "var(--warning-subtle)" : "var(--success-subtle)",
        border: `1px solid ${color}`,
        borderRadius: "var(--radius)",
        padding: "10px 14px",
        fontSize: 12.5,
        color,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | React.ReactNode;
  accent?: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${accent ?? "var(--accent-primary)"}`,
        borderRadius: "var(--radius)",
        padding: "12px 16px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", gap: 16, fontSize: 13, padding: "4px 0" }}>
      <div style={{ width: 120, color: "var(--text-muted)" }}>{k}</div>
      <div>{v}</div>
    </div>
  );
}

const CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "auto",
};

const CARD_PAD: React.CSSProperties = { ...CARD, padding: "16px 20px" };

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

const MONEY: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  fontWeight: 600,
};

const PRIMARY_BTN: React.CSSProperties = {
  padding: "7px 16px",
  background: "var(--accent-primary)",
  border: "1px solid var(--accent-primary)",
  borderRadius: "var(--radius)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

const WARNING_BTN: React.CSSProperties = {
  padding: "7px 16px",
  background: "transparent",
  border: "1px solid var(--warning)",
  borderRadius: "var(--radius)",
  color: "var(--warning)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

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
