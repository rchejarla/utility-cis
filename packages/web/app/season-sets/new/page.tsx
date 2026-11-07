"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { AccessDenied } from "@/components/ui/access-denied";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * Create a season set — the header only. The seasons themselves are a
 * list that has to cover the year exactly once, which a create form
 * cannot hold halfway, so they are added on the editor.
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

export default function NewSeasonSetPage() {
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
      const created = await apiClient.post<{ id: string }>("/api/v1/season-sets", {
        name: form.name,
        effectiveDate: form.effectiveDate,
      });
      router.push(`/season-sets/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create this season set");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "640px" }}>
      <PageHeader title="New Season Set" subtitle="How the year divides, from a given date" />

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
          <FormField label="Name" required>
            <input
              style={inputStyle}
              value={form.name}
              placeholder="Summer and winter"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </FormField>

          <FormField
            label="In force from"
            required
            tooltip="Only one set is in force at a time: the published one with the latest effective date on or before the bill period's start. Non-TOU charges follow it; a published TOU calendar keeps the set it names."
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
            The seasons are added next, on the editor. The set cannot be published until they
            cover every day of the year exactly once.
          </div>

          {error && (
            <div role="alert" style={{ fontSize: "12px", color: "var(--danger)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/season-sets")}
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
              {submitting ? "Creating…" : "Create season set"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
