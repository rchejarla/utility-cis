"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface Commodity {
  id: string;
  name: string;
}

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

// v2: rate-schedule create captures schedule-level metadata only.
// Pricing is built up as RateComponents (slice 1 task 5) edited
// in the visual configurator (slice 2). This new-form page is a
// thin shim until that configurator lands.
export default function NewRateSchedulePage() {
  const router = useRouter();
  const { canCreate } = usePermission("rate_schedules");
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    code: "",
    commodityId: "",
    effectiveDate: "",
    expirationDate: "",
    description: "",
    regulatoryRef: "",
  });

  useEffect(() => {
    apiClient
      .get<{ data: Commodity[] }>("/api/v1/commodities")
      .then((res) => setCommodities(res.data ?? []))
      .catch(console.error);
  }, []);

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: form.name,
        code: form.code,
        commodityId: form.commodityId,
        effectiveDate: form.effectiveDate,
      };
      if (form.expirationDate) body.expirationDate = form.expirationDate;
      if (form.description) body.description = form.description;
      if (form.regulatoryRef) body.regulatoryRef = form.regulatoryRef;

      await apiClient.post("/api/v1/rate-schedules", body);
      router.push("/rate-schedules");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create rate schedule";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "800px" }}>
      <PageHeader title="New Rate Schedule" subtitle="Define a tariff rate schedule" />

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
          <SectionLabel>Basic Info</SectionLabel>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Name" required>
              <input
                style={inputStyle}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Residential Electric Basic"
                required
              />
            </FormField>
            <FormField label="Code" required tooltip="Code + version must be unique. Cannot be changed." tooltipRuleId="BR-RS-007">
              <input
                style={inputStyle}
                value={form.code}
                onChange={(e) => set("code", e.target.value)}
                placeholder="RES-ELEC-BASIC"
                required
              />
            </FormField>
          </div>

          <FormField label="Commodity" required>
            <select
              style={inputStyle}
              value={form.commodityId}
              onChange={(e) => set("commodityId", e.target.value)}
              required
            >
              <option value="">Select commodity...</option>
              {commodities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Effective Date" required hint="BR-RS-003: Billing uses the rate in effect during the billing period">
              <DatePicker
                value={form.effectiveDate}
                onChange={(v) => set("effectiveDate", v)}
              />
            </FormField>
            <FormField label="Expiration Date" hint="Leave blank for indefinite">
              <DatePicker
                value={form.expirationDate}
                onChange={(v) => set("expirationDate", v)}
                placeholder="Leave blank for indefinite"
              />
            </FormField>
          </div>

          <FormField label="Description">
            <textarea
              style={{ ...inputStyle, minHeight: "70px", resize: "vertical" }}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </FormField>

          <FormField label="Regulatory Reference">
            <input
              style={inputStyle}
              value={form.regulatoryRef}
              onChange={(e) => set("regulatoryRef", e.target.value)}
              placeholder="Tariff Sheet No. 12"
            />
          </FormField>

          <div
            style={{
              padding: "14px 16px",
              borderRadius: "var(--radius)",
              border: "1px dashed var(--border)",
              background: "var(--bg-elevated)",
              fontSize: "12px",
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            <strong>Components (coming soon)</strong>
            <div style={{ marginTop: 4 }}>
              Pricing components — base charges, tiers, time-of-use, demand —
              will be defined in the visual configurator after this schedule
              is created.
            </div>
          </div>

          {error && (
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "var(--radius)",
                background: "var(--danger-subtle)",
                border: "1px solid var(--danger)",
                color: "var(--danger)",
                fontSize: "13px",
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/rate-schedules")}
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
              {submitting ? "Creating..." : "Create Rate Schedule"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "12px",
        fontWeight: "600",
        textTransform: "uppercase" as const,
        letterSpacing: "0.06em",
        color: "var(--text-muted)",
        marginBottom: "-8px",
        marginTop: "4px",
      }}
    >
      {children}
    </div>
  );
}
