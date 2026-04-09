"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { apiClient } from "@/lib/api-client";

interface Commodity {
  id: string;
  name: string;
}

interface UOM {
  id: string;
  name: string;
  code: string;
  commodityId: string;
}

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
}

const METER_TYPES = ["STANDARD", "SMART", "AMR", "AMI", "SUBMETER", "MASTER", "OTHER"];

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

export default function NewMeterPage() {
  const router = useRouter();
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [allUoms, setAllUoms] = useState<UOM[]>([]);
  const [premises, setPremises] = useState<Premise[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    premiseId: "",
    meterNumber: "",
    commodityId: "",
    meterType: "STANDARD",
    uomId: "",
    multiplier: "1",
    installDate: "",
    notes: "",
  });

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: Commodity[] }>("/api/v1/commodities"),
      apiClient.get<{ data: UOM[] }>("/api/v1/uoms"),
      apiClient.get<{ data: Premise[] }>("/api/v1/premises", { limit: "200" }),
    ])
      .then(([comRes, uomRes, premRes]) => {
        setCommodities(comRes.data ?? []);
        setAllUoms(uomRes.data ?? []);
        setPremises(premRes.data ?? []);
      })
      .catch(console.error);
  }, []);

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const filteredUoms = form.commodityId
    ? allUoms.filter((u) => u.commodityId === form.commodityId)
    : allUoms;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        premiseId: form.premiseId,
        meterNumber: form.meterNumber,
        commodityId: form.commodityId,
        meterType: form.meterType,
        multiplier: parseFloat(form.multiplier) || 1,
      };
      if (form.uomId) body.uomId = form.uomId;
      if (form.installDate) body.installDate = form.installDate;
      if (form.notes) body.notes = form.notes;

      await apiClient.post("/api/v1/meters", body);
      router.push("/meters");
    } catch (err: any) {
      setError(err.message || "Failed to create meter");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: "720px" }}>
      <PageHeader title="Add Meter" subtitle="Register a new meter at a premise" />

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
          <FormField label="Premise" required hint="Meter is permanently tied to this premise (BR-MT-009)">
            <select
              style={inputStyle}
              value={form.premiseId}
              onChange={(e) => set("premiseId", e.target.value)}
              required
            >
              <option value="">Select a premise...</option>
              {premises.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.addressLine1}, {p.city}, {p.state}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Meter Number" required tooltip="Must be unique within the utility" tooltipRuleId="BR-MT-002">
            <input
              style={inputStyle}
              value={form.meterNumber}
              onChange={(e) => set("meterNumber", e.target.value)}
              placeholder="MTR-001234"
              required
            />
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Commodity" required hint="Must match one of the premise's commodities (BR-MT-003)">
              <select
                style={inputStyle}
                value={form.commodityId}
                onChange={(e) => {
                  set("commodityId", e.target.value);
                  set("uomId", "");
                }}
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

            <FormField label="Unit of Measure">
              <select
                style={inputStyle}
                value={form.uomId}
                onChange={(e) => set("uomId", e.target.value)}
              >
                <option value="">Select UOM...</option>
                {filteredUoms.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.code})
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Meter Type" required>
              <select
                style={inputStyle}
                value={form.meterType}
                onChange={(e) => set("meterType", e.target.value)}
              >
                {METER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Multiplier">
              <input
                style={inputStyle}
                type="number"
                step="any"
                min="0"
                value={form.multiplier}
                onChange={(e) => set("multiplier", e.target.value)}
                placeholder="1"
              />
            </FormField>
          </div>

          <FormField label="Install Date">
            <input
              style={inputStyle}
              type="date"
              value={form.installDate}
              onChange={(e) => set("installDate", e.target.value)}
            />
          </FormField>

          <FormField label="Notes">
            <textarea
              style={{ ...inputStyle, minHeight: "80px", resize: "vertical" }}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Optional notes..."
            />
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
              onClick={() => router.push("/meters")}
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
              {submitting ? "Creating..." : "Create Meter"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
