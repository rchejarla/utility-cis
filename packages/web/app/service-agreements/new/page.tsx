"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { FieldDefinition } from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { HelpTooltip } from "@/components/ui/tooltip";
import { DatePicker } from "@/components/ui/date-picker";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface Account {
  id: string;
  accountNumber: string;
}

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
}

interface Commodity {
  id: string;
  name: string;
}

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  commodityId: string;
}

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
}

interface Meter {
  id: string;
  meterNumber: string;
  commodityId: string;
  premiseId: string;
  commodity?: { name: string };
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

interface MeterEntry {
  meterId: string;
  isPrimary: boolean;
}

export default function NewServiceAgreementPage() {
  const router = useRouter();
  const { canCreate } = usePermission("agreements");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [premises, setPremises] = useState<Premise[]>([]);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [allRateSchedules, setAllRateSchedules] = useState<RateSchedule[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);
  const [allMeters, setAllMeters] = useState<Meter[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tenant custom-field schema for service agreements.
  const [customSchema, setCustomSchema] = useState<FieldDefinition[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});

  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/service_agreement",
        );
        setCustomSchema(res.fields ?? []);
      } catch (err) {
        console.error("[service-agreements/new] failed to load schema", err);
        setCustomSchema([]);
      }
    })();
  }, []);

  const [form, setForm] = useState({
    accountId: "",
    premiseId: "",
    commodityId: "",
    billingCycleId: "",
    startDate: "",
    endDate: "",
  });

  const [meterEntries, setMeterEntries] = useState<MeterEntry[]>([{ meterId: "", isPrimary: true }]);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: Account[] }>("/api/v1/accounts", { limit: "200" }),
      apiClient.get<{ data: Premise[] }>("/api/v1/premises", { limit: "200" }),
      apiClient.get<{ data: Commodity[] }>("/api/v1/commodities"),
      apiClient.get<{ data: RateSchedule[] }>("/api/v1/rate-schedules", { limit: "200" }),
      apiClient.get<{ data: BillingCycle[] }>("/api/v1/billing-cycles"),
      apiClient.get<{ data: Meter[] }>("/api/v1/meters", { limit: "500" }),
    ])
      .then(([accRes, premRes, comRes, rsRes, bcRes, mRes]) => {
        setAccounts(accRes.data ?? []);
        setPremises(premRes.data ?? []);
        setCommodities(comRes.data ?? []);
        setAllRateSchedules(rsRes.data ?? []);
        setBillingCycles(bcRes.data ?? []);
        setAllMeters(mRes.data ?? []);
      })
      .catch(console.error);
  }, []);

  const set = (key: string, value: unknown) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const filteredMeters = allMeters.filter(
    (m) =>
      (!form.premiseId || m.premiseId === form.premiseId) &&
      (!form.commodityId || m.commodityId === form.commodityId)
  );

  const addMeter = () =>
    setMeterEntries((prev) => [...prev, { meterId: "", isPrimary: false }]);

  const removeMeter = (i: number) =>
    setMeterEntries((prev) => prev.filter((_, idx) => idx !== i));

  const updateMeter = (i: number, key: keyof MeterEntry, value: unknown) =>
    setMeterEntries((prev) =>
      prev.map((entry, idx) => (idx === i ? { ...entry, [key]: value } : entry))
    );

  const setPrimary = (i: number) =>
    setMeterEntries((prev) =>
      prev.map((entry, idx) => ({ ...entry, isPrimary: idx === i }))
    );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validMeters = meterEntries.filter((m) => m.meterId);
    if (validMeters.length === 0) {
      setError("At least one meter is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        accountId: form.accountId,
        premiseId: form.premiseId,
        commodityId: form.commodityId,
        startDate: form.startDate,
        meters: validMeters,
      };
      if (form.billingCycleId) body.billingCycleId = form.billingCycleId;
      if (form.endDate) body.endDate = form.endDate;
      if (Object.keys(customValues).length > 0) body.customFields = customValues;

      await apiClient.post("/api/v1/service-agreements", body);
      router.push("/service-agreements");
    } catch (err: any) {
      setError(err.message || "Failed to create service agreement");
    } finally {
      setSubmitting(false);
    }
  };

  if (!canCreate) return <AccessDenied />;

  return (
    <div style={{ maxWidth: "800px" }}>
      <PageHeader title="New Service Agreement" subtitle="Create a utility service agreement" />

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
          <SectionLabel>Account & Premise</SectionLabel>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Account" required>
              <select
                style={inputStyle}
                value={form.accountId}
                onChange={(e) => set("accountId", e.target.value)}
                required
              >
                <option value="">Select account...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.accountNumber}
                  </option>
                ))}
              </select>
            </FormField>

            <FormField label="Premise" required>
              <select
                style={inputStyle}
                value={form.premiseId}
                onChange={(e) => {
                  set("premiseId", e.target.value);
                  setMeterEntries([{ meterId: "", isPrimary: true }]);
                }}
                required
              >
                <option value="">Select premise...</option>
                {premises.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.addressLine1}, {p.city}, {p.state}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <SectionLabel>Service Details</SectionLabel>

          <FormField label="Commodity" required hint="All meters must match this commodity (BR-SA-003)">
            <select
              style={inputStyle}
              value={form.commodityId}
              onChange={(e) => {
                set("commodityId", e.target.value);
                setMeterEntries([{ meterId: "", isPrimary: true }]);
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Billing Cycle">
              <select
                style={inputStyle}
                value={form.billingCycleId}
                onChange={(e) => set("billingCycleId", e.target.value)}
              >
                <option value="">Select billing cycle...</option>
                {billingCycles.map((bc) => (
                  <option key={bc.id} value={bc.id}>
                    {bc.name} ({bc.cycleCode})
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <FormField label="Start Date" required>
              <DatePicker
                value={form.startDate}
                onChange={(v) => set("startDate", v)}
              />
            </FormField>
            <FormField label="End Date" hint="Optional — leave blank for open-ended">
              <DatePicker
                value={form.endDate}
                onChange={(v) => set("endDate", v)}
                placeholder="Leave blank for open-ended"
              />
            </FormField>
          </div>

          <div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "-8px" }}>
              Starts as PENDING. Status: PENDING → ACTIVE → FINAL → CLOSED (BR-SA-006)
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "-8px", marginTop: "4px" }}>
            <span style={{ fontSize: "12px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Meters</span>
            <HelpTooltip text="A meter can only be in one active agreement per commodity at a time" ruleId="BR-SA-004" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {meterEntries.map((entry, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "center",
                  padding: "10px 14px",
                  borderRadius: "var(--radius)",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                }}
              >
                <select
                  style={{ ...inputStyle, flex: 1 }}
                  value={entry.meterId}
                  onChange={(e) => updateMeter(i, "meterId", e.target.value)}
                >
                  <option value="">Select meter...</option>
                  {filteredMeters.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.meterNumber} {m.commodity ? `(${m.commodity.name})` : ""}
                    </option>
                  ))}
                </select>
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={entry.isPrimary}
                    onChange={() => setPrimary(i)}
                  />
                  Primary
                </label>
                {meterEntries.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeMeter(i)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--danger)",
                      background: "var(--danger-subtle)",
                      color: "var(--danger)",
                      fontSize: "12px",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addMeter}
              style={{
                padding: "7px 14px",
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
              + Add Meter
            </button>
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

          {/* Tenant-configurable custom fields. Renders nothing when
              the tenant has no schema configured for service_agreement. */}
          <CustomFieldsSection
            schema={customSchema}
            values={customValues}
            onChange={setCustomValues}
          />

          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/service-agreements")}
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
              {submitting ? "Creating..." : "Create Agreement"}
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
