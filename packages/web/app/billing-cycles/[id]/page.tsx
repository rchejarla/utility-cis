"use client";

import { useState, useEffect, use } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth: number;
  billDayOfMonth: number;
  frequency: string;
  active: boolean;
}

/**
 * An account as this page needs it: who it is, and whether it is in a
 * state that bills. A run only picks up ACTIVE accounts, so status is
 * the column that explains why a cycle with nine accounts bills seven.
 */
interface CycleAccount {
  id: string;
  accountNumber: string;
  status: string;
  accountType: string;
  customer: { firstName: string | null; lastName: string | null; organizationName: string | null } | null;
}

const FREQUENCIES = ["MONTHLY", "BIMONTHLY", "QUARTERLY", "ANNUAL"];

const ACCOUNTS_PER_PAGE = 25;

function customerLabel(c: CycleAccount["customer"]): string {
  if (!c) return "—";
  if (c.organizationName) return c.organizationName;
  const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
  return name === "" ? "—" : name;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

const thStyle: React.CSSProperties = {
  padding: "10px 16px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: 13,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
  whiteSpace: "nowrap",
};

const pageBtnStyle = (disabled: boolean): React.CSSProperties => ({
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

const inputStyle = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

export default function BillingCycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("billing_cycles");
  const [cycle, setCycle] = useState<BillingCycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [accounts, setAccounts] = useState<CycleAccount[]>([]);
  const [accountMeta, setAccountMeta] = useState<{ total: number; pages: number } | null>(null);
  const [accountPage, setAccountPage] = useState(1);
  const [accountsLoading, setAccountsLoading] = useState(false);

  const loadCycle = async () => {
    try {
      const data = await apiClient.get<BillingCycle>(`/api/v1/billing-cycles/${id}`);
      setCycle(data);
      return data;
    } catch (err) {
      console.error("Failed to load billing cycle", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCycle();
  }, [id]);

  /*
   * The accounts on this cycle, fetched only when the tab is opened.
   *
   * The FK points from account to cycle, so the cycle cannot answer
   * "who do I bill?" from its own row — this is the account list
   * filtered by `billingCycleId`, paginated, rather than a second
   * endpoint that would duplicate its sorting and its shape.
   */
  useEffect(() => {
    if (activeTab !== "accounts") return;
    let cancelled = false;
    setAccountsLoading(true);
    apiClient
      .get<{ data: CycleAccount[]; meta: { total: number; pages: number } }>("/api/v1/accounts", {
        billingCycleId: id,
        page: String(accountPage),
        limit: String(ACCOUNTS_PER_PAGE),
      })
      .then((res) => {
        if (cancelled) return;
        setAccounts(res.data ?? []);
        setAccountMeta(res.meta ?? null);
      })
      .catch((err) => {
        if (!cancelled) toast(err instanceof Error ? err.message : "Failed to load accounts", "error");
      })
      .finally(() => {
        if (!cancelled) setAccountsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, id, accountPage]);

  const handleEdit = () => {
    if (!cycle) return;
    setEditForm({
      name: cycle.name ?? "",
      readDayOfMonth: String(cycle.readDayOfMonth),
      billDayOfMonth: String(cycle.billDayOfMonth),
      frequency: cycle.frequency ?? "",
      active: cycle.active,
    });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
  };

  const handleDeactivate = async () => {
    if (!cycle) return;
    setDeactivating(true);
    try {
      await apiClient.patch(`/api/v1/billing-cycles/${id}`, { active: false });
      await loadCycle();
      setShowDeactivateConfirm(false);
      toast("Billing cycle deactivated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to deactivate billing cycle", "error");
    } finally {
      setDeactivating(false);
    }
  };

  const handleSave = async () => {
    if (!cycle) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.name !== cycle.name) changes.name = editForm.name;
      const billDay = parseInt(editForm.billDayOfMonth as string, 10);
      if (billDay !== cycle.billDayOfMonth) changes.billDayOfMonth = billDay;
      const readDay = parseInt(editForm.readDayOfMonth as string, 10);
      if (readDay !== cycle.readDayOfMonth) changes.readDayOfMonth = readDay;
      if (editForm.frequency !== cycle.frequency) changes.frequency = editForm.frequency;
      if (editForm.active !== cycle.active) changes.active = editForm.active;

      await apiClient.patch(`/api/v1/billing-cycles/${id}`, changes);
      await loadCycle();
      setEditing(false);
      toast("Billing cycle updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save billing cycle", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Loading...</div>;
  }
  if (!canView) return <AccessDenied />;
  if (!cycle) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Billing cycle not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={cycle.name}
        subtitle={`Cycle Code: ${cycle.cycleCode}`}
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          {
            key: "accounts",
            label: accountMeta ? `Accounts (${accountMeta.total})` : "Accounts",
          },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "overview" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            {/* Edit / Save / Cancel buttons */}
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px", gap: "8px" }}>
              <div>
                {canDelete && !editing && cycle.active && (
                  <button
                    onClick={() => setShowDeactivateConfirm(true)}
                    title="BR-BC-003: Billing cycles cannot be deleted, only deactivated."
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--danger)", borderRadius: "var(--radius)", color: "var(--danger)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Deactivate Cycle
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {editing ? (
                  <>
                    <button
                      onClick={handleCancel}
                      style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      style={{ padding: "6px 14px", fontSize: "12px", background: "var(--accent-primary)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}
                    >
                      {saving ? "Saving..." : "Save"}
                    </button>
                  </>
                ) : canEdit ? (
                  <button
                    onClick={handleEdit}
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.active as boolean}
                    onChange={(e) => setEditForm((f) => ({ ...f, active: e.target.checked }))}
                  />
                  Active
                </label>
              ) : (
                <StatusBadge status={cycle.active ? "ACTIVE" : "INACTIVE"} />
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Name</span>
              {editing ? (
                <input
                  style={inputStyle}
                  value={editForm.name as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.name}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Cycle Code</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{cycle.cycleCode}</span>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Read Day of Month</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  max="28"
                  value={editForm.readDayOfMonth as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, readDayOfMonth: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.readDayOfMonth}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Bill Day of Month</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  max="31"
                  value={editForm.billDayOfMonth as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, billDayOfMonth: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.billDayOfMonth}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Frequency</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.frequency as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, frequency: e.target.value }))}
                >
                  {FREQUENCIES.map((freq) => (
                    <option key={freq} value={freq}>{freq.charAt(0) + freq.slice(1).toLowerCase()}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{cycle.frequency}</span>
              )}
            </div>

            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Cycle ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {cycle.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "accounts" && (
          <div>
            {/*
              Said once, here, because it is the question this tab
              raises: being on a cycle is not the same as being billed by
              its run. A run takes ACTIVE accounts that also have a
              service agreement covering the window, so this total is
              always the ceiling and rarely the figure.
            */}
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
              Every account on this cycle. A run bills the ACTIVE ones that also have a
              service agreement covering its window, so it may pick up fewer than these.
            </p>

            {accountsLoading ? (
              <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
            ) : accounts.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: "center",
                  color: "var(--text-muted)",
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                }}
              >
                No account is on this cycle, so a run for it would have nothing to bill.
              </div>
            ) : (
              <div
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  overflow: "auto",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                      <th style={thStyle}>Account</th>
                      <th style={thStyle}>Customer</th>
                      <th style={thStyle}>Type</th>
                      <th style={thStyle}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td style={tdStyle}>
                          <a
                            href={`/accounts/${a.id}`}
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 12,
                              fontWeight: 600,
                              color: "var(--accent-primary)",
                              textDecoration: "none",
                            }}
                          >
                            {a.accountNumber}
                          </a>
                        </td>
                        <td style={tdStyle}>{customerLabel(a.customer)}</td>
                        <td style={{ ...tdStyle, color: "var(--text-muted)", fontSize: 12 }}>
                          {a.accountType}
                        </td>
                        <td style={tdStyle}>
                          <StatusBadge status={a.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {accountMeta && accountMeta.pages > 1 && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 14 }}>
                <button
                  onClick={() => setAccountPage((p) => p - 1)}
                  disabled={accountPage <= 1}
                  style={pageBtnStyle(accountPage <= 1)}
                >
                  Previous
                </button>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Page {accountPage} of {accountMeta.pages}
                </span>
                <button
                  onClick={() => setAccountPage((p) => p + 1)}
                  disabled={accountPage >= accountMeta.pages}
                  style={pageBtnStyle(accountPage >= accountMeta.pages)}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}

        {showDeactivateConfirm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "420px", width: "100%" }}>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Confirm Deactivation</div>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
                Are you sure you want to deactivate this billing cycle? Existing agreements will retain their cycle assignment.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button onClick={() => setShowDeactivateConfirm(false)} style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                <button onClick={handleDeactivate} disabled={deactivating} style={{ padding: "6px 14px", fontSize: "12px", background: "var(--danger)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: deactivating ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: deactivating ? 0.7 : 1 }}>
                  {deactivating ? "Processing..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}
      </Tabs>
    </div>
  );
}
