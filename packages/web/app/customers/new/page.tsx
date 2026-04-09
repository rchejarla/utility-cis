"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";

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

type CustomerMode = "INDIVIDUAL" | "ORGANIZATION";

export default function NewCustomerPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<CustomerMode>("INDIVIDUAL");

  const [form, setForm] = useState({
    // Individual
    firstName: "",
    lastName: "",
    dateOfBirth: "",
    driversLicense: "",
    // Organization
    organizationName: "",
    taxId: "",
    // Shared
    email: "",
    phone: "",
    altPhone: "",
  });

  const set = (key: string, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        customerType: mode,
        email: form.email || undefined,
        phone: form.phone || undefined,
        altPhone: form.altPhone || undefined,
      };

      if (mode === "INDIVIDUAL") {
        body.firstName = form.firstName;
        body.lastName = form.lastName;
        if (form.dateOfBirth) body.dateOfBirth = form.dateOfBirth;
        if (form.driversLicense) body.driversLicense = form.driversLicense;
      } else {
        body.organizationName = form.organizationName;
        if (form.taxId) body.taxId = form.taxId;
      }

      const created = await apiClient.post<{ id: string }>("/api/v1/customers", body);
      toast("Customer created successfully", "success");
      router.push(`/customers/${created.id}`);
    } catch (err: any) {
      toast(err.message || "Failed to create customer", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const toggleStyle = (active: boolean) => ({
    flex: 1,
    padding: "9px 0",
    borderRadius: "calc(var(--radius) - 2px)",
    border: "none",
    background: active ? "var(--accent-primary)" : "transparent",
    color: active ? "#fff" : "var(--text-secondary)",
    fontSize: "13px",
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all 0.15s ease",
  });

  return (
    <div style={{ maxWidth: "640px" }}>
      <PageHeader title="Add Customer" subtitle="Create a new customer record" />

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
          {/* Customer type toggle */}
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: "500",
                color: "var(--text-secondary)",
                marginBottom: "8px",
              }}
            >
              Customer Type
            </div>
            <div
              style={{
                display: "flex",
                gap: "4px",
                padding: "4px",
                background: "var(--bg-elevated)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
              }}
            >
              <button
                type="button"
                onClick={() => setMode("INDIVIDUAL")}
                style={toggleStyle(mode === "INDIVIDUAL")}
              >
                Individual
              </button>
              <button
                type="button"
                onClick={() => setMode("ORGANIZATION")}
                style={toggleStyle(mode === "ORGANIZATION")}
              >
                Organization
              </button>
            </div>
            <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "4px" }}>
              BR-CU-003: Customer type cannot be changed after creation
            </div>
          </div>

          {/* Individual fields */}
          {mode === "INDIVIDUAL" && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <FormField label="First Name" required>
                  <input
                    style={inputStyle}
                    value={form.firstName}
                    onChange={(e) => set("firstName", e.target.value)}
                    placeholder="Jane"
                    required
                  />
                </FormField>
                <FormField label="Last Name" required>
                  <input
                    style={inputStyle}
                    value={form.lastName}
                    onChange={(e) => set("lastName", e.target.value)}
                    placeholder="Smith"
                    required
                  />
                </FormField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <FormField label="Date of Birth" hint="YYYY-MM-DD">
                  <input
                    style={inputStyle}
                    type="date"
                    value={form.dateOfBirth}
                    onChange={(e) => set("dateOfBirth", e.target.value)}
                  />
                </FormField>
                <FormField label="Driver's License">
                  <input
                    style={inputStyle}
                    value={form.driversLicense}
                    onChange={(e) => set("driversLicense", e.target.value)}
                    placeholder="DL-12345678"
                  />
                </FormField>
              </div>
            </>
          )}

          {/* Organization fields */}
          {mode === "ORGANIZATION" && (
            <>
              <FormField label="Organization Name" required>
                <input
                  style={inputStyle}
                  value={form.organizationName}
                  onChange={(e) => set("organizationName", e.target.value)}
                  placeholder="Acme Corporation"
                  required
                />
              </FormField>
              <FormField label="Tax ID / EIN" hint="e.g. 12-3456789">
                <input
                  style={inputStyle}
                  value={form.taxId}
                  onChange={(e) => set("taxId", e.target.value)}
                  placeholder="12-3456789"
                />
              </FormField>
            </>
          )}

          {/* Shared contact fields */}
          <div
            style={{
              borderTop: "1px solid var(--border)",
              paddingTop: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "16px",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: "600",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Contact Information
            </div>

            <FormField label="Email" hint="Used for notifications and portal access">
              <input
                style={inputStyle}
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                placeholder="customer@example.com"
              />
            </FormField>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <FormField label="Phone">
                <input
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  type="tel"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  placeholder="(555) 000-0000"
                />
              </FormField>
              <FormField label="Alternate Phone">
                <input
                  style={{ ...inputStyle, fontFamily: "monospace" }}
                  type="tel"
                  value={form.altPhone}
                  onChange={(e) => set("altPhone", e.target.value)}
                  placeholder="(555) 000-0000"
                />
              </FormField>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => router.push("/customers")}
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
              {submitting ? "Creating..." : "Create Customer"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
