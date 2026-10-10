"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";

/**
 * Ledger integrity — proof that `account.balance` still equals the sum of
 * that account's open ledger entries.
 *
 * Not "reconciliation", though that is what the endpoint is still called.
 * In utility billing that word means tying receipts to a bank deposit, or
 * the AR subledger to a GL control account, and this does neither. It is
 * an integrity check on a denormalisation: `balance` is a cache written
 * inside the posting transaction so delinquency sweeps and list screens
 * need not sum the ledger on every read, and a cache drifts when
 * something writes around it. It lives under Settings for the same
 * reason -- an admin runs it after a migration or a data repair, not a
 * CSR during a call.
 *
 * The healthy result is the usual result, so this page is written around
 * reassurance rather than around a work queue: the common case has to say
 * something a reader can trust, and the rare case has to be impossible to
 * miss.
 *
 * That is why `checked` is on the screen. "No drift" is also what a check
 * that could see no accounts returns, so a green panel that does not say
 * how many accounts it examined is not evidence of anything.
 */

interface BalanceDrift {
  accountId: string;
  accountNumber: string;
  cached: string;
  ledger: string;
}

interface ReconciliationReport {
  ok: boolean;
  checked: number;
  drift: BalanceDrift[];
}

export default function LedgerIntegrityPage() {
  const { canView } = usePermission("accounts");
  const { toast } = useToast();

  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [ranAt, setRanAt] = useState<Date | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<ReconciliationReport>("/api/v1/ar/reconciliation");
      setReport(res);
      setRanAt(new Date());
    } catch (err) {
      toast(err instanceof Error ? err.message : "The integrity check failed to run", "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (canView) void run();
  }, [canView, run]);

  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Ledger Integrity"
        subtitle="Checks every account's stored balance against the sum of its open ledger entries"
        actions={
          <button onClick={() => void run()} disabled={loading} style={BTN(loading)}>
            {loading ? "Checking…" : "Run check"}
          </button>
        }
      />

      <p style={{ color: "var(--text-muted)", fontSize: 13, maxWidth: 760, marginBottom: 20 }}>
        An account&apos;s balance is <strong>stored</strong>, not worked out each time it is
        shown — it is written inside the same transaction that writes a ledger entry, so that
        account lists, the delinquency sweep and the portal do not have to add up the ledger
        on every read. The two should therefore never disagree. This check is the proof. A
        difference means something changed a balance outside that path — a hand-edit, an
        import, a code path that skipped the recompute — and that account needs looking at.
      </p>

      {loading && !report ? (
        <p style={{ color: "var(--text-muted)" }}>Running the check…</p>
      ) : !report ? (
        <Panel tone="warn" title="The check did not run">
          Nothing was verified. Use <strong>Run check</strong> to try again.
        </Panel>
      ) : report.checked === 0 ? (
        // Deliberately not the green state: no accounts examined means the
        // check is silent, not satisfied.
        <Panel tone="warn" title="No accounts were checked">
          This proves nothing about the ledger — it only means the check found no accounts to
          examine. Expected on a brand-new utility with no accounts yet; anywhere else it points
          at the check itself rather than at the books.
        </Panel>
      ) : report.ok ? (
        <Panel tone="ok" title={`All ${report.checked.toLocaleString()} accounts match the ledger`}>
          For each of them the balance stored on the account is exactly the sum of what is
          still outstanding on its ledger entries. Nothing has changed a balance outside the
          posting path, so the figures shown on account pages, in the delinquency sweep and
          on the portal are the real ones.
          {ranAt && <Ran at={ranAt} />}
        </Panel>
      ) : (
        <>
          <Panel
            tone="bad"
            title={`${report.drift.length.toLocaleString()} of ${report.checked.toLocaleString()} accounts do not match the ledger`}
          >
            The stored balance disagrees with the ledger on the accounts below. The ledger is
            authoritative for what is owed, so treat the stored balance as the wrong number and
            investigate what wrote it.
            {ranAt && <Ran at={ranAt} />}
          </Panel>

          <div style={CARD}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <Th>Account</Th>
                  <Th style={{ textAlign: "right" }}>Stored balance</Th>
                  <Th style={{ textAlign: "right" }}>Ledger total</Th>
                  <Th style={{ textAlign: "right" }}>Difference</Th>
                </tr>
              </thead>
              <tbody>
                {report.drift.map((d) => {
                  // Stored minus ledger: positive means the stored balance
                  // claims more is owed than the ledger supports. Shown with
                  // an explicit sign rather than the brackets the AR tab uses
                  // for credits, because this is a discrepancy, not a credit.
                  const diff = Number(d.cached) - Number(d.ledger);
                  return (
                    <tr key={d.accountId}>
                      <Td>
                        <Link href={`/accounts/${d.accountId}?tab=ar`} style={LINK}>
                          {d.accountNumber}
                        </Link>
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <Money value={d.cached} />
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <Money value={d.ledger} />
                      </Td>
                      <Td style={{ textAlign: "right" }}>
                        <Money value={diff.toFixed(2)} signed tone="var(--danger)" />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Ran({ at }: { at: Date }) {
  return (
    <span style={{ display: "block", marginTop: 6, fontSize: 12, opacity: 0.75 }}>
      Checked at {at.toLocaleTimeString()}
    </span>
  );
}

function Money({
  value,
  signed = false,
  tone,
}: {
  value: string;
  signed?: boolean;
  tone?: string;
}) {
  const n = Number(value);
  const body = `$${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 13,
        fontWeight: 600,
        color: tone ?? "var(--text-primary)",
      }}
    >
      {signed && n !== 0 ? (n > 0 ? "+" : "−") : n < 0 ? "−" : ""}
      {body}
    </span>
  );
}

const TONES = {
  ok: { fg: "var(--success)", label: "In balance" },
  warn: { fg: "var(--warning)", label: "Inconclusive" },
  bad: { fg: "var(--danger)", label: "Out of balance" },
} as const;

function Panel({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div
      role={tone === "ok" ? "status" : "alert"}
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${t.fg}40`,
        borderLeft: `3px solid ${t.fg}`,
        borderRadius: "var(--radius)",
        padding: "14px 18px",
        marginBottom: 20,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: t.fg,
          marginBottom: 4,
        }}
      >
        {t.label}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, maxWidth: 760 }}>
        {children}
      </div>
    </div>
  );
}

const CARD: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

const LINK: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--primary)",
  textDecoration: "none",
};

const BTN = (disabled: boolean): React.CSSProperties => ({
  padding: "7px 14px",
  fontSize: 12,
  fontWeight: 600,
  background: "var(--primary)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius)",
  cursor: disabled ? "default" : "pointer",
  opacity: disabled ? 0.6 : 1,
  fontFamily: "inherit",
});

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
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
