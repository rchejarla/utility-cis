"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

// Must match shared validators (packages/shared/src/validators/account.ts)
const ACCOUNT_TYPES = ["RESIDENTIAL", "COMMERCIAL", "INDUSTRIAL", "MUNICIPAL"] as const;
const CREDIT_RATINGS = ["EXCELLENT", "GOOD", "FAIR", "POOR", "UNRATED"] as const;
const LANGUAGE_PREFS = [
  { value: "en-US", label: "English" },
  { value: "es-US", label: "Spanish" },
  { value: "fr-CA", label: "French" },
  { value: "zh-CN", label: "Chinese" },
  { value: "vi-VN", label: "Vietnamese" },
];

const inputStyle = {
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

export default function NewAccountPage() {
  const router = useRouter();
  const { canCreate } = usePermission("accounts");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    accountNumber: "",
    accountType: "RESIDENTIAL" as (typeof ACCOUNT_TYPES)[number],
    creditRating: "",
    depositAmount: "",
    languagePref: "en-US",
  });

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        accountNumber: form.accountNumber,
        accountType: form.accountType,
        languagePref: form.languagePref,
      };
      if (form.creditRating) body.creditRating = form.creditRating;
      if (form.depositAmount) body.depositAmount = parseFloat(form.depositAmount);

      await apiClient.post("/api/v1/accounts", body);
      router.push("/accounts");
    } catch (err: any) {
      setError(err.message || "Failed to create account");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "640px" }}>
      <PageHeader title="Add Account" subtitle="Create a new customer account" />

      <form onSubmit={handleSubmit}>
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
          }}
        >
          <FormField label="Account Number" required tooltip="Cannot be changed after creation" tooltipRuleId="BR-AC-005">
            <input
              style={inputStyle}
              value={form.accountNumber}
              onChange={(e) => set("accountNumber", e.target.value)}
              placeholder="ACC-000001"
              required
            />
          </FormField>

          <FormField label="Account Type" required hint="Determines default rate eligibility">
            <select
              style={inputStyle}
              value={form.accountType}
              onChange={(e) => set("accountType", e.target.value)}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Credit Rating">
              <select
                style={inputStyle}
                value={form.creditRating}
                onChange={(e) => set("creditRating", e.target.value)}
              >
                <option value="">None</option>
                {CREDIT_RATINGS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Deposit Amount" hint="Optional security deposit" tooltip="May be required for certain account types (e.g., renters)" tooltipRuleId="BR-AC-008">
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="0"
                value={form.depositAmount}
                onChange={(e) => set("depositAmount", e.target.value)}
                placeholder="0.00"
              />
            </FormField>
          </div>

          <FormField label="Language Preference">
            <select
              style={inputStyle}
              value={form.languagePref}
              onChange={(e) => set("languagePref", e.target.value)}
            >
              {LANGUAGE_PREFS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </FormField>

          {error && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                background: "rgba(239,68,68,0.1)",
                border: "1px solid rgba(239,68,68,0.3)",
                color: "#f87171",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/accounts")}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: "13px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius)",
                border: "none",
                background: "var(--accent-primary)",
                color: "#fff",
                fontSize: "13px",
                fontWeight: "500",
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {submitting ? "Creating..." : "Create Account"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
