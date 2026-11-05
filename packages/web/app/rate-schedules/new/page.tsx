"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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

interface TouCalendar {
  id: string;
  name: string;
  effectiveDate: string;
  publishedAt?: string | null;
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
  const [calendars, setCalendars] = useState<TouCalendar[]>([]);
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
    touCalendarId: "",
  });

  useEffect(() => {
    /*
     * `/api/v1/commodities` answers with a bare array: `listCommodities`
     * is a `findMany` and the CRUD factory sends it unwrapped. Reading
     * `res.data` off an array gave `undefined` and emptied the select —
     * and a commodity is required, so this form could not be submitted
     * at all. Both shapes are accepted here for the same reason
     * `entity-list-page.tsx` accepts both: the envelope is the house
     * style for a paginated list and this endpoint is not one, so the
     * next person to paginate it must not re-break the page.
     */
    apiClient
      .get<Commodity[] | { data: Commodity[] }>("/api/v1/commodities")
      .then((res) => setCommodities(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
    apiClient
      .get<{ data: TouCalendar[] }>("/api/v1/tou-calendars")
      .then((res) => setCalendars(res.data ?? []))
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
      if (form.touCalendarId) body.touCalendarId = form.touCalendarId;

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
            <FormField
              label="Code"
              required
              hint="This tariff's short identifier, used to assign it and to refer to it in your tariff book — unlike the name, it never changes. Revising makes a new version under the same code."
              tooltip="Code + version must be unique within the utility. The code cannot be changed after creation: a rate schedule is immutable and changes go through Revise, which keeps the code and bumps the version."
              tooltipRuleId="BR-RS-007"
            >
              <input
                style={inputStyle}
                value={form.code}
                onChange={(e) => set("code", e.target.value)}
                placeholder="RES-ELEC-BASIC"
                required
              />
            </FormField>
          </div>

          <FormField
            label="Commodity"
            required
            hint={
              commodities.length === 0
                ? undefined
                : "What this tariff bills — it fixes the units the charges are priced in."
            }
          >
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
          {commodities.length === 0 && (
            /*
             * A required select with nothing in it is a dead end, and it
             * looks identical whether the tenant has no commodities or
             * the fetch failed. Say which, and where to go.
             */
            <p style={{ margin: "-4px 0 0", fontSize: 12, color: "var(--warning, #b45309)" }}>
              No commodities are set up for this utility, so there is nothing to
              price yet. Add one under <Link href="/commodities" style={{ color: "inherit", textDecoration: "underline" }}>Commodities</Link> first.
            </p>
          )}

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

          {/*
            Only for a time-of-use tariff, and it can be named later
            from the schedule itself — the publish gate is what insists,
            once there is a charge pricing a period.
          */}
          <FormField
            label="TOU Calendar"
            hint="Only for time-of-use tariffs. It says which hours each period covers; charges name the periods. Can be set later."
          >
            <select
              style={inputStyle}
              value={form.touCalendarId}
              onChange={(e) => set("touCalendarId", e.target.value)}
            >
              <option value="">None — this tariff is not time-of-use</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — from {c.effectiveDate?.slice(0, 10)}
                  {c.publishedAt ? "" : " (draft)"}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Description">
            <textarea
              style={{ ...inputStyle, minHeight: "70px", resize: "vertical" }}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </FormField>

          <FormField
            label="Regulatory Reference"
            hint="What authorised these rates — a council resolution, ordinance, PUC docket or tariff sheet number. Free text, shown on the schedule's overview, and carried to the next version when you revise. Optional, but it is the only record of who approved this tariff."
          >
            <input
              style={inputStyle}
              value={form.regulatoryRef}
              onChange={(e) => set("regulatoryRef", e.target.value)}
              placeholder="Resolution 5378"
              maxLength={100}
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
