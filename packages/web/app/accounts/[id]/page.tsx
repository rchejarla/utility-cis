"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { ContactsTab } from "@/components/accounts/contacts-tab";
import { BillingAddressesTab } from "@/components/accounts/billing-addresses-tab";

interface Contact {
  id: string;
  role: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  isPrimary: boolean;
}

interface BillingAddress {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  isPrimary: boolean;
}

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  creditRating?: string;
  depositAmount?: number;
  depositWaived?: boolean;
  depositWaivedReason?: string;
  languagePref?: string;
  paperlessBilling?: boolean;
  budgetBilling?: boolean;
  customerId?: string;
  saaslogicAccountId?: string;
  serviceAgreements?: Array<{
    id: string;
    agreementNumber: string;
    status: string;
    startDate: string;
    premise?: { addressLine1: string; city: string };
  }>;
  contacts?: Contact[];
  billingAddresses?: BillingAddress[];
  createdAt?: string;
  updatedAt?: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  createdAt: string;
}

const ACCOUNT_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "GOVERNMENT", "OTHER"];
const ACCOUNT_STATUSES = ["ACTIVE", "INACTIVE", "SUSPENDED", "CLOSED"];
const CREDIT_RATINGS = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC", "CC", "C", "D"];
const LANGUAGE_PREFS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "zh", label: "Chinese" },
  { value: "vi", label: "Vietnamese" },
];

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

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

export default function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [account, setAccount] = useState<Account | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [showAddAddress, setShowAddAddress] = useState(false);

  const loadAccount = async () => {
    try {
      const data = await apiClient.get<Account>(`/api/v1/accounts/${id}`);
      setAccount(data);
      return data;
    } catch (err) {
      console.error("Failed to load account", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAccount();
  }, [id]);

  useEffect(() => {
    if (activeTab === "audit") {
      apiClient
        .get<{ data: AuditEntry[] }>("/api/v1/audit-log", {
          entityType: "Account",
          entityId: id,
        })
        .then((res) => setAudit(res.data ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  const handleEdit = () => {
    if (!account) return;
    setEditForm({
      accountType: account.accountType ?? "",
      status: account.status ?? "",
      creditRating: account.creditRating ?? "",
      depositAmount: account.depositAmount != null ? String(account.depositAmount) : "",
      depositWaived: account.depositWaived ?? false,
      depositWaivedReason: account.depositWaivedReason ?? "",
      languagePref: account.languagePref ?? "en",
      paperlessBilling: account.paperlessBilling ?? false,
      budgetBilling: account.budgetBilling ?? false,
    });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
  };

  const handleClose = async () => {
    if (!account) return;
    setClosing(true);
    try {
      await apiClient.patch(`/api/v1/accounts/${id}`, { status: "CLOSED" });
      await loadAccount();
      setShowCloseConfirm(false);
      toast("Account closed successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to close account", "error");
    } finally {
      setClosing(false);
    }
  };

  const handleSave = async () => {
    if (!account) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.accountType !== account.accountType) changes.accountType = editForm.accountType;
      if (editForm.status !== account.status) changes.status = editForm.status;
      if (editForm.creditRating !== (account.creditRating ?? "")) changes.creditRating = editForm.creditRating || null;
      const depositVal = editForm.depositAmount !== "" ? parseFloat(editForm.depositAmount as string) : null;
      if (depositVal !== (account.depositAmount ?? null)) changes.depositAmount = depositVal;
      if (editForm.depositWaived !== (account.depositWaived ?? false)) changes.depositWaived = editForm.depositWaived;
      if (editForm.depositWaivedReason !== (account.depositWaivedReason ?? "")) changes.depositWaivedReason = editForm.depositWaivedReason;
      if (editForm.languagePref !== (account.languagePref ?? "")) changes.languagePref = editForm.languagePref;
      if (editForm.paperlessBilling !== (account.paperlessBilling ?? false)) changes.paperlessBilling = editForm.paperlessBilling;
      if (editForm.budgetBilling !== (account.budgetBilling ?? false)) changes.budgetBilling = editForm.budgetBilling;

      await apiClient.patch(`/api/v1/accounts/${id}`, changes);
      await loadAccount();
      setEditing(false);
      toast("Account updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save account", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!account) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Account not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={account.accountNumber}
        subtitle={`${account.accountType} account`}
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "agreements", label: `Agreements (${account.serviceAgreements?.length ?? 0})` },
          { key: "contacts", label: `Contacts (${account.contacts?.length ?? 0})` },
          { key: "billing-addresses", label: `Billing Addresses (${account.billingAddresses?.length ?? 0})` },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          if (tab !== "contacts") setShowAddContact(false);
          if (tab !== "billing-addresses") setShowAddAddress(false);
        }}
        action={
          activeTab === "contacts" ? (
            <button
              onClick={() => setShowAddContact((v) => !v)}
              style={{
                padding: "6px 14px",
                fontSize: "12px",
                fontWeight: 500,
                background: showAddContact ? "transparent" : "var(--accent-primary)",
                color: showAddContact ? "var(--text-secondary)" : "#fff",
                border: showAddContact ? "1px solid var(--border)" : "none",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showAddContact ? "Cancel" : "+ Add Contact"}
            </button>
          ) : activeTab === "billing-addresses" ? (
            <button
              onClick={() => setShowAddAddress((v) => !v)}
              style={{
                padding: "6px 14px",
                fontSize: "12px",
                fontWeight: 500,
                background: showAddAddress ? "transparent" : "var(--accent-primary)",
                color: showAddAddress ? "var(--text-secondary)" : "#fff",
                border: showAddAddress ? "1px solid var(--border)" : "none",
                borderRadius: "var(--radius)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showAddAddress ? "Cancel" : "+ Add Address"}
            </button>
          ) : undefined
        }
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
                {!editing && (account.status === "ACTIVE" || account.status === "FINAL") && (
                  <button
                    onClick={() => setShowCloseConfirm(true)}
                    title="BR-AC-004: Account cannot be closed while it has active service agreements."
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid rgba(239,68,68,0.4)", borderRadius: "var(--radius)", color: "#f87171", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Close Account
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
                ) : (
                  <button
                    onClick={handleEdit}
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Edit
                  </button>
                )}
              </div>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.status as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                >
                  {ACCOUNT_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={account.status} />
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Account Number</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{account.accountNumber}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Account Type</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.accountType as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, accountType: e.target.value }))}
                >
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{account.accountType}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Credit Rating</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.creditRating as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, creditRating: e.target.value }))}
                >
                  <option value="">None</option>
                  {CREDIT_RATINGS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{account.creditRating ?? "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Deposit Amount</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  step="0.01"
                  min="0"
                  value={editForm.depositAmount as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, depositAmount: e.target.value }))}
                  placeholder="0.00"
                />
              ) : (
                <span style={valueStyle}>
                  {account.depositAmount != null
                    ? `$${Number(account.depositAmount).toFixed(2)}`
                    : "—"}
                </span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Deposit Waived</span>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.depositWaived as boolean}
                    onChange={(e) => setEditForm((f) => ({ ...f, depositWaived: e.target.checked }))}
                  />
                  Waived
                </label>
              ) : (
                <span style={valueStyle}>{account.depositWaived ? "Yes" : "No"}</span>
              )}
            </div>
            {(editing || account.depositWaivedReason) && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Waiver Reason</span>
                {editing ? (
                  <input
                    style={inputStyle}
                    value={editForm.depositWaivedReason as string}
                    onChange={(e) => setEditForm((f) => ({ ...f, depositWaivedReason: e.target.value }))}
                    placeholder="Optional reason"
                  />
                ) : (
                  <span style={valueStyle}>{account.depositWaivedReason ?? "—"}</span>
                )}
              </div>
            )}
            <div style={fieldStyle}>
              <span style={labelStyle}>Language Pref</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.languagePref as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, languagePref: e.target.value }))}
                >
                  {LANGUAGE_PREFS.map((l) => (
                    <option key={l.value} value={l.value}>{l.label}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{account.languagePref ?? "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Paperless Billing</span>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.paperlessBilling as boolean}
                    onChange={(e) => setEditForm((f) => ({ ...f, paperlessBilling: e.target.checked }))}
                  />
                  Enabled
                </label>
              ) : (
                <span style={valueStyle}>{account.paperlessBilling ? "Yes" : "No"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Budget Billing</span>
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.budgetBilling as boolean}
                    onChange={(e) => setEditForm((f) => ({ ...f, budgetBilling: e.target.checked }))}
                  />
                  Enabled
                </label>
              ) : (
                <span style={valueStyle}>{account.budgetBilling ? "Yes" : "No"}</span>
              )}
            </div>
            {account.createdAt && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Created</span>
                <span style={valueStyle}>{new Date(account.createdAt).toLocaleDateString()}</span>
              </div>
            )}
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Account ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {account.id}
              </span>
            </div>
          </div>
        )}

        {showCloseConfirm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "420px", width: "100%" }}>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Confirm Account Closure</div>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
                Are you sure you want to close this account? This cannot be undone.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button onClick={() => setShowCloseConfirm(false)} style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                <button onClick={handleClose} disabled={closing} style={{ padding: "6px 14px", fontSize: "12px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: closing ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: closing ? 0.7 : 1 }}>
                  {closing ? "Processing..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "agreements" && (
          <DataTable
            columns={[
              { key: "agreementNumber", header: "Agreement Number" },
              {
                key: "premise",
                header: "Premise",
                render: (row: any) =>
                  row.premise ? `${row.premise.addressLine1}, ${row.premise.city}` : "—",
              },
              {
                key: "startDate",
                header: "Start Date",
                render: (row: any) => row.startDate?.slice(0, 10) ?? "—",
              },
              {
                key: "status",
                header: "Status",
                render: (row: any) => <StatusBadge status={row.status} />,
              },
            ]}
            data={(account.serviceAgreements ?? []) as any}
            onRowClick={(row: any) => router.push(`/service-agreements/${row.id}`)}
          />
        )}

        {activeTab === "contacts" && (
          <ContactsTab
            accountId={id}
            contacts={account.contacts ?? []}
            onContactsChanged={loadAccount}
            showForm={showAddContact}
            onShowFormChange={setShowAddContact}
          />
        )}

        {activeTab === "billing-addresses" && (
          <BillingAddressesTab
            accountId={id}
            billingAddresses={account.billingAddresses ?? []}
            onAddressesChanged={loadAccount}
            showForm={showAddAddress}
            onShowFormChange={setShowAddAddress}
          />
        )}

        {activeTab === "audit" && (
          <DataTable
            columns={[
              {
                key: "createdAt",
                header: "Timestamp",
                render: (row: any) => new Date(row.createdAt).toLocaleString(),
              },
              { key: "action", header: "Action" },
              { key: "actorId", header: "Actor", render: (row: any) => row.actorId ?? "System" },
            ]}
            data={audit as any}
          />
        )}
      </Tabs>
    </div>
  );
}
