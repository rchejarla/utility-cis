"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { HelpTooltip } from "@/components/ui/tooltip";
import { apiClient } from "@/lib/api-client";

interface Commodity {
  id: string;
  name: string;
}

interface TierRow {
  from: string;
  to: string;
  rate: string;
}

const RATE_TYPES = ["FLAT", "TIERED", "TOU", "DEMAND", "BUDGET"];

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

export default function NewRateSchedulePage() {
  const router = useRouter();
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    code: "",
    commodityId: "",
    rateType: "FLAT",
    effectiveDate: "",
    expirationDate: "",
    description: "",
    regulatoryRef: "",
    // FLAT config
    flatBaseCharge: "",
    flatUnit: "",
    // JSON fallback
    jsonConfig: "",
  });

  const [tiers, setTiers] = useState<TierRow[]>([{ from: "0", to: "", rate: "" }]);

  useEffect(() => {
    apiClient
      .get<{ data: Commodity[] }>("/api/v1/commodities")
      .then((res) => setCommodities(res.data ?? []))
      .catch(console.error);
  }, []);

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const addTier = () => setTiers((prev) => [...prev, { from: "", to: "", rate: "" }]);
  const removeTier = (i: number) => setTiers((prev) => prev.filter((_, idx) => idx !== i));
  const updateTier = (i: number, key: keyof TierRow, value: string) =>
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, [key]: value } : t)));

  const buildRateConfig = (): Record<string, unknown> | null => {
    if (form.rateType === "FLAT") {
      return {
        base_charge: parseFloat(form.flatBaseCharge) || 0,
        unit: form.flatUnit || "kWh",
      };
    }
    if (form.rateType === "TIERED") {
      return {
        base_charge: parseFloat(form.flatBaseCharge) || 0,
        unit: form.flatUnit || "kWh",
        tiers: tiers.map((t) => ({
          from: parseFloat(t.from) || 0,
          to: t.to ? parseFloat(t.to) : null,
          rate: parseFloat(t.rate) || 0,
        })),
      };
    }
    if (form.jsonConfig) {
      try {
        return JSON.parse(form.jsonConfig);
      } catch {
        return null;
      }
    }
    return {};
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const rateConfig = buildRateConfig();
    if (
      ["TOU", "DEMAND", "BUDGET"].includes(form.rateType) &&
      form.jsonConfig &&
      rateConfig === null
    ) {
      setError("Invalid JSON in rate configuration.");
      setSubmitting(false);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        name: form.name,
        code: form.code,
        commodityId: form.commodityId,
        rateType: form.rateType,
        effectiveDate: form.effectiveDate,
        rateConfig: rateConfig ?? {},
      };
      if (form.expirationDate) body.expirationDate = form.expirationDate;
      if (form.description) body.description = form.description;
      if (form.regulatoryRef) body.regulatoryRef = form.regulatoryRef;

      await apiClient.post("/api/v1/rate-schedules", body);
      router.push("/rate-schedules");
    } catch (err: any) {
      setError(err.message || "Failed to create rate schedule");
    } finally {
      setSubmitting(false);
    }
  };

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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
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
            <FormField label="Rate Type" required>
              <select
                style={inputStyle}
                value={form.rateType}
                onChange={(e) => set("rateType", e.target.value)}
              >
                {RATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Effective Date" required hint="BR-RS-003: Billing uses the rate in effect during the billing period">
              <input
                style={inputStyle}
                type="date"
                value={form.effectiveDate}
                onChange={(e) => set("effectiveDate", e.target.value)}
                required
              />
            </FormField>
            <FormField label="Expiration Date" hint="Leave blank for indefinite">
              <input
                style={inputStyle}
                type="date"
                value={form.expirationDate}
                onChange={(e) => set("expirationDate", e.target.value)}
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

          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "-8px", marginTop: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Rate Configuration</span>
            <HelpTooltip text="Structure must match the selected rate type" ruleId="BR-RS-004" />
          </div>

          {form.rateType === "FLAT" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <FormField label="Base Charge">
                <input
                  style={inputStyle}
                  type="number"
                  step="any"
                  value={form.flatBaseCharge}
                  onChange={(e) => set("flatBaseCharge", e.target.value)}
                  placeholder="0.00"
                />
              </FormField>
              <FormField label="Unit">
                <input
                  style={inputStyle}
                  value={form.flatUnit}
                  onChange={(e) => set("flatUnit", e.target.value)}
                  placeholder="kWh"
                />
              </FormField>
            </div>
          )}

          {form.rateType === "TIERED" && (
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <FormField label="Base Charge">
                  <input
                    style={inputStyle}
                    type="number"
                    step="any"
                    value={form.flatBaseCharge}
                    onChange={(e) => set("flatBaseCharge", e.target.value)}
                    placeholder="0.00"
                  />
                </FormField>
                <FormField label="Unit">
                  <input
                    style={inputStyle}
                    value={form.flatUnit}
                    onChange={(e) => set("flatUnit", e.target.value)}
                    placeholder="kWh"
                  />
                </FormField>
              </div>

              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  fontWeight: "500",
                  marginTop: "4px",
                }}
              >
                Tiers
              </div>

              {tiers.map((tier, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr auto",
                    gap: "8px",
                    alignItems: "end",
                  }}
                >
                  <FormField label="From (kWh)">
                    <input
                      style={inputStyle}
                      type="number"
                      step="any"
                      value={tier.from}
                      onChange={(e) => updateTier(i, "from", e.target.value)}
                    />
                  </FormField>
                  <FormField label="To (kWh)">
                    <input
                      style={inputStyle}
                      type="number"
                      step="any"
                      value={tier.to}
                      onChange={(e) => updateTier(i, "to", e.target.value)}
                      placeholder="∞"
                    />
                  </FormField>
                  <FormField label="Rate ($/unit)">
                    <input
                      style={inputStyle}
                      type="number"
                      step="any"
                      value={tier.rate}
                      onChange={(e) => updateTier(i, "rate", e.target.value)}
                    />
                  </FormField>
                  {tiers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeTier(i)}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "var(--radius)",
                        border: "1px solid rgba(239,68,68,0.4)",
                        background: "rgba(239,68,68,0.1)",
                        color: "#f87171",
                        fontSize: "12px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addTier}
                style={{
                  padding: "6px 14px",
                  borderRadius: "var(--radius)",
                  border: "1px dashed var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  alignSelf: "flex-start",
                }}
              >
                + Add Tier
              </button>
            </div>
          )}

          {["TOU", "DEMAND", "BUDGET"].includes(form.rateType) && (
            <FormField
              label="Rate Config (JSON)"
              hint="TOU, Demand, and Budget configs are Phase 3 features — enter raw JSON"
            >
              <textarea
                style={{ ...inputStyle, minHeight: "120px", resize: "vertical", fontFamily: "monospace", fontSize: "12px" }}
                value={form.jsonConfig}
                onChange={(e) => set("jsonConfig", e.target.value)}
                placeholder='{"base_charge": 0}'
              />
            </FormField>
          )}

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
