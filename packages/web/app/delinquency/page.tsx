"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface ActionRow {
  id: string;
  tier: number;
  actionType: string;
  status: string;
  balanceAtAction: string;
  daysPastDueAtAction: number;
  triggeredBy: string;
  createdAt: string;
  account: { accountNumber: string; balance: string; customerId?: string };
  rule: { name: string };
}

interface Summary {
  totalAccounts: number;
  totalBalance: number;
  byTier: Record<number, { count: number; balance: number }>;
}

const statusMap: Record<string, string> = {
  PENDING: "Pending",
  COMPLETED: "Active",
  RESOLVED: "Active",
  CANCELLED: "Inactive",
};

export default function DelinquencyDashboardPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("delinquency");
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [evaluating, setEvaluating] = useState(false);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: ActionRow[] }>("/api/v1/delinquency-actions", { limit: "50", status: "PENDING" }),
      apiClient.get<{ data: ActionRow[] }>("/api/v1/delinquency-actions", { limit: "50", status: "COMPLETED" }),
      apiClient.get<Summary>("/api/v1/delinquency/summary"),
    ])
      .then(([pending, completed, sum]) => {
        setActions([...(pending.data ?? []), ...(completed.data ?? [])]);
        setSummary(sum);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (!canView) return <AccessDenied />;

  const handleEvaluate = async () => {
    setEvaluating(true);
    try {
      const result = await apiClient.post<{ accountsEvaluated: number; actionsCreated: number }>("/api/v1/delinquency/evaluate", {});
      alert(`Evaluated ${result.accountsEvaluated} accounts, created ${result.actionsCreated} actions`);
      window.location.reload();
    } catch (err) {
      console.error(err);
    } finally {
      setEvaluating(false);
    }
  };

  const shutoffCount = summary
    ? Object.entries(summary.byTier).filter(([t]) => Number(t) >= 4).reduce((s, [, v]) => s + v.count, 0)
    : 0;

  return (
    <div>
      <PageHeader
        title="Delinquency"
        subtitle="Past-due accounts, escalation tiers, and shut-off eligibility"
        action={canCreate ? { label: evaluating ? "Evaluating..." : "Run Evaluation", onClick: handleEvaluate } : undefined}
      />

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
            <StatCard label="Delinquent accounts" value={summary?.totalAccounts ?? 0} icon="⚠" />
            <StatCard label="Total balance" value={`$${(summary?.totalBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} icon="💰" />
            <StatCard label="Shut-off eligible" value={shutoffCount} icon="🔌" />
            <StatCard label="Pending actions" value={actions.filter((a) => a.status === "PENDING").length} icon="📋" />
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
                  <Th>Account</Th>
                  <Th>Tier</Th>
                  <Th>Rule</Th>
                  <Th>Action</Th>
                  <Th style={{ textAlign: "right" }}>Balance</Th>
                  <Th>Days Past Due</Th>
                  <Th>Triggered</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {actions.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
                      No active delinquency actions. Run evaluation to check for past-due accounts.
                    </td>
                  </tr>
                ) : (
                  actions.map((a) => (
                    <tr
                      key={a.id}
                      style={{ cursor: "pointer", transition: "background 0.1s" }}
                      onClick={() => router.push(`/accounts/${a.account?.accountNumber ? "" : ""}#delinquency`)}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                    >
                      <Td><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{a.account?.accountNumber ?? "—"}</span></Td>
                      <Td><span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{a.tier}</span></Td>
                      <Td>{a.rule?.name ?? "—"}</Td>
                      <Td><span style={{ fontSize: 11, color: "var(--text-muted)" }}>{a.actionType}</span></Td>
                      <Td style={{ textAlign: "right" }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600 }}>
                          ${Number(a.balanceAtAction).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </Td>
                      <Td>{a.daysPastDueAtAction}d</Td>
                      <Td><span style={{ fontSize: 11, color: "var(--text-muted)" }}>{a.triggeredBy}</span></Td>
                      <Td><StatusBadge status={statusMap[a.status] ?? a.status} /></Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", ...style }}>{children}</th>;
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap", ...style }}>{children}</td>;
}
