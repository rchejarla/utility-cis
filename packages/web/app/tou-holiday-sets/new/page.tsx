"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * Create a holiday set — the header only. The dates are a list saved
 * whole on the editor, the way the seasons of a season set are.
 */

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

export default function NewTouHolidaySetPage() {
  const router = useRouter();
  const { canCreate } = usePermission("rate_schedules");

  const [form, setForm] = useState({ name: "", effectiveDate: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await apiClient.post<{ id: string }>("/api/v1/tou-holiday-sets", {
        name: form.name,
        effectiveDate: form.effectiveDate,
      });
      router.push(`/tou-holiday-sets/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this holiday set");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "640px" }}>
      <PageHeader title="New Holiday Set" subtitle="Which dates a tariff prices as holidays" />

      <form onSubmit={submit}>
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
          <FormField
            label="Name"
            required
            tooltip="Half the version key: a later set with this same name supersedes this one from its own date. So name the list, not the years in it — &quot;Observed holidays 2026&quot; cannot be a version of itself."
          >
            <input
              style={inputStyle}
              value={form.name}
              placeholder="Observed holidays"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </FormField>

          <FormField
            label="In force from"
            required
            tooltip="A published TOU calendar names a published set, so a correction to a holiday is a new version with its own effective date — never an edit to the set that priced bills."
          >
            <input
              type="date"
              style={inputStyle}
              value={form.effectiveDate}
              onChange={(e) => setForm({ ...form, effectiveDate: e.target.value })}
              required
            />
          </FormField>

          <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            The dates are added next, on the editor. Put in the day the utility actually observes —
            if Independence Day falls on a Saturday and the Friday is taken, the Friday is the date
            that belongs here.
          </div>

          {error && (
            <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/tou-holiday-sets")}
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
                fontWeight: 500,
                cursor: submitting ? "not-allowed" : "pointer",
                opacity: submitting ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {submitting ? "Creating…" : "Create holiday set"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
