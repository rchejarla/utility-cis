"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

const PREMISE_TYPES = ["RESIDENTIAL","COMMERCIAL","INDUSTRIAL","AGRICULTURAL","OTHER"];

interface Commodity {
  id: string;
  name: string;
  code: string;
}

interface Customer {
  id: string;
  customerType: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
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

export default function NewPremisePage() {
  const router = useRouter();
  const { canCreate } = usePermission("premises");
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "CA",
    zip: "",
    geoLat: "",
    geoLng: "",
    premiseType: "RESIDENTIAL",
    commodityIds: [] as string[],
    serviceTerritoryId: "",
    municipalityCode: "",
    ownerId: "",
  });

  useEffect(() => {
    Promise.all([
      apiClient.get<Commodity[] | { data: Commodity[] }>("/api/v1/commodities"),
      apiClient.get<{ data: Customer[] }>("/api/v1/customers", { limit: "500" }),
    ]).then(([cRes, cuRes]) => {
      setCommodities(Array.isArray(cRes) ? cRes : cRes.data ?? []);
      setCustomers(cuRes.data ?? []);
    }).catch(console.error);
  }, []);

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const toggleCommodity = (id: string) => {
    setForm((prev) => ({
      ...prev,
      commodityIds: prev.commodityIds.includes(id)
        ? prev.commodityIds.filter((c) => c !== id)
        : [...prev.commodityIds, id],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        addressLine1: form.addressLine1,
        city: form.city,
        state: form.state,
        zip: form.zip,
        premiseType: form.premiseType,
        commodityIds: form.commodityIds,
      };
      if (form.addressLine2) body.addressLine2 = form.addressLine2;
      if (form.geoLat) body.geoLat = parseFloat(form.geoLat);
      if (form.geoLng) body.geoLng = parseFloat(form.geoLng);
      if (form.serviceTerritoryId) body.serviceTerritoryId = form.serviceTerritoryId;
      if (form.municipalityCode) body.municipalityCode = form.municipalityCode;
      if (form.ownerId) body.ownerId = form.ownerId;

      await apiClient.post("/api/v1/premises", body);
      router.push("/premises");
    } catch (err: any) {
      setError(err.message || "Failed to create premise");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "720px" }}>
      <PageHeader title="Add Premise" subtitle="Create a new service premise" />

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
          <div
            style={{
              fontSize: "12px",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-muted)",
              marginBottom: "-8px",
            }}
          >
            Address
          </div>

          <FormField label="Address Line 1" required>
            <input
              style={inputStyle}
              value={form.addressLine1}
              onChange={(e) => set("addressLine1", e.target.value)}
              placeholder="123 Main St"
              required
            />
          </FormField>

          <FormField label="Address Line 2">
            <input
              style={inputStyle}
              value={form.addressLine2}
              onChange={(e) => set("addressLine2", e.target.value)}
              placeholder="Apt 4B (optional)"
            />
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 120px", gap: "12px" }}>
            <FormField label="City" required>
              <input
                style={inputStyle}
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
                placeholder="Springfield"
                required
              />
            </FormField>
            <FormField label="State" required hint="2-letter state code">
              <select
                style={inputStyle}
                value={form.state}
                onChange={(e) => set("state", e.target.value)}
              >
                {US_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="ZIP Code" required>
              <input
                style={inputStyle}
                value={form.zip}
                onChange={(e) => set("zip", e.target.value)}
                placeholder="90210"
                required
              />
            </FormField>
          </div>

          <div
            style={{
              fontSize: "12px",
              fontWeight: "600",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--text-muted)",
              marginBottom: "-8px",
              marginTop: "4px",
            }}
          >
            Details
          </div>

          <FormField label="Premise Type" required>
            <select
              style={inputStyle}
              value={form.premiseType}
              onChange={(e) => set("premiseType", e.target.value)}
            >
              {PREMISE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Commodities" tooltip="At least one commodity required" tooltipRuleId="BR-PR-003">
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {commodities.map((c) => {
                const selected = form.commodityIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleCommodity(c.id)}
                    style={{
                      padding: "5px 14px",
                      borderRadius: "999px",
                      border: selected
                        ? "1px solid var(--accent-primary)"
                        : "1px solid var(--border)",
                      background: selected ? "rgba(59,130,246,0.15)" : "transparent",
                      color: selected ? "var(--accent-primary)" : "var(--text-secondary)",
                      fontSize: "12px",
                      fontWeight: "500",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {c.name}
                  </button>
                );
              })}
              {commodities.length === 0 && (
                <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                  Loading commodities...
                </span>
              )}
            </div>
          </FormField>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Latitude" hint="Optional — for map view">
              <input
                style={inputStyle}
                type="number"
                step="any"
                value={form.geoLat}
                onChange={(e) => set("geoLat", e.target.value)}
                placeholder="34.0522"
              />
            </FormField>
            <FormField label="Longitude" hint="Optional — for map view">
              <input
                style={inputStyle}
                type="number"
                step="any"
                value={form.geoLng}
                onChange={(e) => set("geoLng", e.target.value)}
                placeholder="-118.2437"
              />
            </FormField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Service Territory ID">
              <input
                style={inputStyle}
                value={form.serviceTerritoryId}
                onChange={(e) => set("serviceTerritoryId", e.target.value)}
                placeholder="Optional"
              />
            </FormField>
            <FormField label="Municipality Code">
              <input
                style={inputStyle}
                value={form.municipalityCode}
                onChange={(e) => set("municipalityCode", e.target.value)}
                placeholder="Optional"
              />
            </FormField>
            <FormField label="Property Owner" tooltip="Property owner may differ from the service account holder (landlord/tenant)" tooltipRuleId="BR-PR-002">
              <select
                style={inputStyle}
                value={form.ownerId}
                onChange={(e) => set("ownerId", e.target.value)}
              >
                <option value="">No owner assigned</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customerType === "ORGANIZATION"
                      ? c.organizationName
                      : `${c.firstName} ${c.lastName}`}
                  </option>
                ))}
              </select>
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
              onClick={() => router.push("/premises")}
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
              {submitting ? "Creating..." : "Create Premise"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
