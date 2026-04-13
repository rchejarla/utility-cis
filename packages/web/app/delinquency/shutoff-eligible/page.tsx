"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useToast } from "@/components/ui/toast";
import { AccessDenied } from "@/components/ui/access-denied";

interface ShutoffAction {
  id: string;
  tier: number;
  actionType: string;
  status: string;
  balanceAtAction: string;
  daysPastDueAtAction: number;
  createdAt: string;
  account: {
    id: string;
    accountNumber: string;
    balance: string;
    lastDueDate?: string;
    isProtected: boolean;
    protectionReason?: string;
    customer?: { firstName?: string; lastName?: string; organizationName?: string; customerType: string };
  };
  rule: { name: string };
}

export default function ShutoffEligiblePage() {
  const { canView, canEdit } = usePermission("delinquency");
  const { toast } = useToast();
  const [actions, setActions] = useState<ShutoffAction[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = () => {
    apiClient
      .get<{ data: ShutoffAction[] }>("/api/v1/delinquency/eligible-for-shutoff")
      .then((res) => setActions(res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, []);

  if (!canView) return <AccessDenied />;

  const handleResolve = async (accountId: string, resolutionType: string) => {
    try {
      await apiClient.post(`/api/v1/accounts/${accountId}/delinquency/resolve`, { resolutionType });
      toast("Delinquency resolved", "success");
      loadData();
    } catch (err) {
      toast("Failed to resolve", "error");
    }
  };

  const handleEscalate = async (accountId: string) => {
    try {
      await apiClient.post(`/api/v1/accounts/${accountId}/delinquency/escalate`, {});
      toast("Escalated to disconnect", "success");
      loadData();
    } catch (err) {
      toast("Failed to escalate", "error");
    }
  };

  const customerName = (c?: ShutoffAction["account"]["customer"]) => {
    if (!c) return "—";
    return c.customerType === "ORGANIZATION" ? c.organizationName : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "—";
  };

  return (
    <div>
      <PageHeader
        title="Shut-Off Eligibility Queue"
        subtitle="Accounts eligible for service disconnection — review and authorize"
      />

      {loading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading...</p>
      ) : actions.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
          No accounts currently eligible for shut-off
        </div>
      ) : (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <Th>Account</Th>
                <Th>Customer</Th>
                <Th style={{ textAlign: "right" }}>Balance</Th>
                <Th>Days Past Due</Th>
                <Th>Protected</Th>
                <Th>Since</Th>
                {canEdit && <Th>Actions</Th>}
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <Td><span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600 }}>{a.account.accountNumber}</span></Td>
                  <Td>{customerName(a.account.customer)}</Td>
                  <Td style={{ textAlign: "right" }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: "var(--danger)" }}>
                      ${Number(a.account.balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </span>
                  </Td>
                  <Td>{a.daysPastDueAtAction}d</Td>
                  <Td>
                    {a.account.isProtected ? (
                      <span title={a.account.protectionReason ?? ""} style={{ fontSize: 14 }}>🛡️</span>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>No</span>
                    )}
                  </Td>
                  <Td><span style={{ fontSize: 12, color: "var(--text-muted)" }}>{new Date(a.createdAt).toLocaleDateString()}</span></Td>
                  {canEdit && (
                    <Td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {!a.account.isProtected && (
                          <SmallBtn color="var(--danger)" onClick={() => handleEscalate(a.account.id)}>
                            Authorize Disconnect
                          </SmallBtn>
                        )}
                        <SmallBtn color="var(--warning)" onClick={() => handleResolve(a.account.id, "WAIVED")}>
                          Waive
                        </SmallBtn>
                        <SmallBtn color="var(--info)" onClick={() => handleResolve(a.account.id, "PAYMENT_PLAN")}>
                          Payment Plan
                        </SmallBtn>
                      </div>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SmallBtn({ children, color, onClick }: { children: React.ReactNode; color: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: "3px 8px", fontSize: 10, fontWeight: 600,
        background: `${color}18`, color, border: `1px solid ${color}40`,
        borderRadius: "var(--radius)", cursor: "pointer", fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Th({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", ...style }}>{children}</th>;
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <td style={{ padding: "12px 16px", fontSize: 13, color: "var(--text-primary)", borderBottom: "1px solid var(--border-subtle)", whiteSpace: "nowrap", ...style }}>{children}</td>;
}
