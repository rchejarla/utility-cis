"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { apiClient } from "@/lib/api-client";

const FREQUENCIES = ["MONTHLY", "BIMONTHLY", "QUARTERLY", "ANNUAL"];

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

export default function NewBillingCyclePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    cycleCode: "",
    readDayOfMonth: "",
    billDayOfMonth: "",
    frequency: "MONTHLY",
  });

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        cycleCode: form.cycleCode,
        frequency: form.frequency,
      };
      if (form.readDayOfMonth) body.readDayOfMonth = parseInt(form.readDayOfMonth);
      if (form.billDayOfMonth) body.billDayOfMonth = parseInt(form.billDayOfMonth);

      await apiClient.post("/api/v1/billing-cycles", body);
      router.push("/billing-cycles");
    } catch (err: any) {
      setError(err.message || "Failed to create billing cycle");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: "560px" }}>
      <PageHeader title="New Billing Cycle" subtitle="Define a billing cycle schedule" />

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
          <FormField label="Name" required>
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Monthly — Cycle A"
              required
            />
          </FormField>

          <FormField label="Cycle Code" required hint="Short identifier code">
            <input
              style={inputStyle}
              value={form.cycleCode}
              onChange={(e) => set("cycleCode", e.target.value)}
              placeholder="MON-A"
              required
            />
          </FormField>

          <FormField label="Frequency" required>
            <select
              style={inputStyle}
              value={form.frequency}
              onChange={(e) => set("frequency", e.target.value)}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {f.charAt(0) + f.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Read Day of Month" hint="1–31">
              <input
                style={inputStyle}
                type="number"
                min="1"
                max="31"
                value={form.readDayOfMonth}
                onChange={(e) => set("readDayOfMonth", e.target.value)}
                placeholder="15"
              />
            </FormField>
            <FormField label="Bill Day of Month" hint="1–31">
              <input
                style={inputStyle}
                type="number"
                min="1"
                max="31"
                value={form.billDayOfMonth}
                onChange={(e) => set("billDayOfMonth", e.target.value)}
                placeholder="25"
              />
            </FormField>
          </div>

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
              onClick={() => router.push("/billing-cycles")}
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
              {submitting ? "Creating..." : "Create Billing Cycle"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
