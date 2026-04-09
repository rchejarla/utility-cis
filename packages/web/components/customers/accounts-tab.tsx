"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Account {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  _count?: { serviceAgreements: number };
  serviceAgreements?: Array<unknown>;
}

interface AccountsTabProps {
  customerId: string;
  data: Account[];
  onAccountAdded: () => void;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
}

const ACCOUNT_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"] as const;
const CREDIT_RATINGS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "UNRATED"] as const;

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 500,
  border: "none",
  borderRadius: "var(--radius, 10px)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--text-muted)",
  marginBottom: "4px",
  fontWeight: 500,
};

const emptyForm = {
  accountNumber: "",
  accountType: "RESIDENTIAL" as string,
  creditRating: "UNRATED" as string,
  depositAmount: "0",
};

export function AccountsTab({
  customerId,
  data,
  onAccountAdded,
  showForm: showFormProp,
  onShowFormChange,
}: AccountsTabProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [showFormLocal, setShowFormLocal] = useState(false);
  const showForm = showFormProp ?? showFormLocal;
  const setShowForm = (v: boolean) => {
    setShowFormLocal(v);
    onShowFormChange?.(v);
  };

  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = async () => {
    if (!form.accountNumber.trim()) {
      toast("Account number is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/accounts", {
        customerId,
        accountNumber: form.accountNumber.trim(),
        accountType: form.accountType,
        creditRating: form.creditRating,
        depositAmount: parseFloat(form.depositAmount) || 0,
        status: "ACTIVE",
      });
      toast("Account created successfully", "success");
      setShowForm(false);
      setForm({ ...emptyForm });
      onAccountAdded();
    } catch (err: any) {
      toast(err.message || "Failed to create account", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const agreementsCount = (account: Account) =>
    account._count?.serviceAgreements ?? account.serviceAgreements?.length ?? 0;

  return (
    <div>
      {/* Add Account Form */}
      {showForm && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius, 10px)",
            padding: "20px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "16px",
            }}
          >
            Add Account
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr 1fr",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            <div>
              <div style={fieldLabelStyle}>Account Number *</div>
              <input
                style={inputStyle}
                value={form.accountNumber}
                onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))}
                placeholder="e.g. 0001010-00"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Account Type</div>
              <select
                style={inputStyle}
                value={form.accountType}
                onChange={(e) => setForm((f) => ({ ...f, accountType: e.target.value }))}
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={fieldLabelStyle}>Credit Rating</div>
              <select
                style={inputStyle}
                value={form.creditRating}
                onChange={(e) => setForm((f) => ({ ...f, creditRating: e.target.value }))}
              >
                {CREDIT_RATINGS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={fieldLabelStyle}>Deposit Amount ($)</div>
              <input
                style={inputStyle}
                type="number"
                min="0"
                step="0.01"
                value={form.depositAmount}
                onChange={(e) => setForm((f) => ({ ...f, depositAmount: e.target.value }))}
                placeholder="0"
              />
            </div>
          </div>

          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
            BR-AC-003: Accounts can exist without service agreements
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              onClick={() => {
                setShowForm(false);
                setForm({ ...emptyForm });
              }}
              style={{
                ...btnStyle,
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={submitting}
              style={{
                ...btnStyle,
                background: "var(--accent-primary)",
                color: "#fff",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Adding..." : "Add Account"}
            </button>
          </div>
        </div>
      )}

      {/* Accounts Table */}
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
              {["Account Number", "Type", "Agreements", "Status"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-muted)",
                    borderBottom: "1px solid var(--border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: "14px",
                  }}
                >
                  No accounts found
                </td>
              </tr>
            ) : (
              data.map((account) => (
                <tr
                  key={account.id}
                  onClick={() => router.push(`/accounts/${account.id}`)}
                  style={{ cursor: "pointer", transition: "background 0.1s ease" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background =
                      "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
                  }}
                >
                  <td
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontSize: "13px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "monospace",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "var(--text-primary)",
                      }}
                    >
                      {account.accountNumber}
                    </span>
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {account.accountType}
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                      fontSize: "12px",
                      fontFamily: "monospace",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {agreementsCount(account)}
                  </td>
                  <td
                    style={{
                      padding: "12px 16px",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    <StatusBadge status={account.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
