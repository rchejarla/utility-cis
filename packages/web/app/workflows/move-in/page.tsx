"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { SearchableEntitySelect } from "@/components/ui/searchable-entity-select";

/**
 * Move-in wizard — a three-step guided flow for onboarding a customer
 * at a premise. Design intent: each step focuses the operator on one
 * decision, the review step shows the entire transaction before commit,
 * and the submit posts everything atomically to the backend so partial
 * states are never possible. No form shell — the step progression is
 * enough structure and each step has its own shape.
 */

type CustomerMode = "NEW" | "EXISTING";

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
}

interface Customer {
  id: string;
  customerType: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  email?: string;
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

interface Commodity {
  id: string;
  name: string;
}

type Step = 1 | 2 | 3;

export default function MoveInWizardPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("workflows");
  const { toast } = useToast();

  const [step, setStep] = useState<Step>(1);
  const [submitting, setSubmitting] = useState(false);

  // Step 1: premise + move-in date + customer mode
  const [premiseId, setPremiseId] = useState("");
  const [moveInDate, setMoveInDate] = useState(new Date().toISOString().slice(0, 10));
  const [customerMode, setCustomerMode] = useState<CustomerMode>("NEW");

  // Step 2a: new customer fields
  const [customerType, setCustomerType] = useState<"INDIVIDUAL" | "ORGANIZATION">("INDIVIDUAL");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  // Step 2b: existing customer lookup
  const [existingCustomerId, setExistingCustomerId] = useState("");

  // Step 2 (shared): account fields
  const [accountNumber, setAccountNumber] = useState("");
  const [accountType, setAccountType] = useState("RESIDENTIAL");
  const [depositAmount, setDepositAmount] = useState("");

  // Step 3: service agreements
  interface AgreementDraft {
    key: string;
    commodityId: string;
    billingCycleId: string;
    agreementNumber: string;
  }
  const [agreements, setAgreements] = useState<AgreementDraft[]>([
    { key: "a1", commodityId: "", billingCycleId: "", agreementNumber: "" },
  ]);

  // Data lookups
  const [premises, setPremises] = useState<Premise[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [rateSchedules, setRateSchedules] = useState<RateSchedule[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: Premise[] }>("/api/v1/premises", { limit: "500" }),
      apiClient.get<{ data: Customer[] }>("/api/v1/customers", { limit: "500" }),
      apiClient.get<{ data: Commodity[] } | Commodity[]>("/api/v1/commodities"),
      apiClient.get<{ data: RateSchedule[] }>("/api/v1/rate-schedules", { limit: "500" }),
      apiClient.get<BillingCycle[] | { data: BillingCycle[] }>("/api/v1/billing-cycles"),
    ])
      .then(([pr, cu, co, rs, bc]) => {
        setPremises(pr.data ?? []);
        setCustomers(cu.data ?? []);
        setCommodities(Array.isArray(co) ? co : co.data ?? []);
        setRateSchedules(rs.data ?? []);
        setBillingCycles(Array.isArray(bc) ? bc : bc.data ?? []);
      })
      .catch(console.error);
  }, []);

  if (!canView) return <AccessDenied />;

  const premise = premises.find((p) => p.id === premiseId);
  const existing = customers.find((c) => c.id === existingCustomerId);

  const customerLabel = (c: Customer) =>
    c.customerType === "ORGANIZATION"
      ? c.organizationName ?? "(unnamed org)"
      : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(unnamed)";

  const addAgreement = () =>
    setAgreements((prev) => [
      ...prev,
      {
        key: `a${prev.length + 1}`,
        commodityId: "",
        billingCycleId: "",
        agreementNumber: "",
      },
    ]);

  const removeAgreement = (key: string) =>
    setAgreements((prev) => (prev.length > 1 ? prev.filter((a) => a.key !== key) : prev));

  const updateAgreement = (key: string, patch: Partial<AgreementDraft>) =>
    setAgreements((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const step1Valid = premiseId && moveInDate;
  // accountNumber is optional — backend auto-generates via the tenant
  // template when absent. Same for each agreement number below.
  const step2Valid =
    accountType &&
    ((customerMode === "EXISTING" && existingCustomerId) ||
      (customerMode === "NEW" &&
        ((customerType === "INDIVIDUAL" && firstName && lastName) ||
          (customerType === "ORGANIZATION" && organizationName))));
  const step3Valid = agreements.every(
    (a) => a.commodityId && a.billingCycleId,
  );

  const submit = async () => {
    if (!canCreate) {
      toast("No permission to execute workflows", "error");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        premiseId,
        moveInDate,
        accountType,
        // Omit accountNumber when blank so the backend generates one.
        ...(accountNumber ? { accountNumber } : {}),
        agreements: agreements.map((a) => ({
          commodityId: a.commodityId,
          billingCycleId: a.billingCycleId,
          // Same for each agreement — omit when blank.
          ...(a.agreementNumber ? { agreementNumber: a.agreementNumber } : {}),
        })),
      };
      if (depositAmount) body.depositAmount = parseFloat(depositAmount);
      if (customerMode === "EXISTING") {
        body.existingCustomerId = existingCustomerId;
      } else {
        const nc: Record<string, unknown> = { customerType };
        if (customerType === "INDIVIDUAL") {
          nc.firstName = firstName;
          nc.lastName = lastName;
        } else {
          nc.organizationName = organizationName;
        }
        if (email) nc.email = email;
        if (phone) nc.phone = phone;
        body.newCustomer = nc;
      }
      const result = await apiClient.post<{ account: { id: string } }>(
        "/api/v1/workflows/move-in",
        body,
      );
      toast("Move-in complete", "success");
      router.push(`/accounts/${result.account.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Move-in failed", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const stepperBar = (
    <div style={{ display: "flex", gap: "8px", marginBottom: "28px" }}>
      {[1, 2, 3].map((n) => {
        const active = step === n;
        const done = step > n;
        return (
          <div
            key={n}
            style={{
              flex: 1,
              padding: "14px 16px",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              borderLeft: active
                ? "4px solid var(--accent-primary)"
                : done
                  ? "4px solid var(--success)"
                  : "4px solid var(--border)",
              background: active ? "var(--bg-elevated)" : "var(--bg-card)",
              opacity: done ? 0.85 : 1,
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "10px",
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: active ? "var(--accent-primary)" : done ? "var(--success)" : "var(--text-muted)",
              }}
            >
              STEP {n.toString().padStart(2, "0")}
              {done && " ✓"}
            </div>
            <div
              style={{
                marginTop: "4px",
                fontSize: "13px",
                fontWeight: 600,
                color: active ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {n === 1 && "Premise & Date"}
              {n === 2 && "Customer & Account"}
              {n === 3 && "Services"}
            </div>
          </div>
        );
      })}
    </div>
  );

  const fieldStyle = {
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
  const labelStyle = {
    display: "block",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "10px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    color: "var(--text-muted)",
    marginBottom: "6px",
  };

  return (
    <div style={{ maxWidth: "820px" }}>
      <PageHeader
        title="Move In"
        subtitle="Three steps, one atomic commit. If any part of the submission fails, nothing lands in the database."
      />

      {stepperBar}

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "24px",
        }}
      >
        {/*
         * Steps render inside always-mounted wrappers (hidden via the
         * native `hidden` attribute) instead of being conditionally
         * mounted. Keeping SearchableEntitySelect mounted across step
         * navigation preserves its internal `knownLabels` cache so the
         * trigger button renders the human-readable label after Back —
         * otherwise the component remounts with just the stored UUID
         * and nothing to resolve it to.
         */}
        <div hidden={step !== 1}>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div>
              <label style={labelStyle}>PREMISE</label>
              <SearchableEntitySelect<Premise>
                value={premiseId || undefined}
                onChange={(v) => setPremiseId(v ?? "")}
                endpoint="/api/v1/premises"
                placeholder="Search premises by address..."
                label="Premise"
                mapOption={(p) => ({
                  value: String(p.id),
                  label: String(p.addressLine1),
                  sublabel: `${p.city}, ${p.state} ${p.zip}`,
                })}
              />
            </div>
            <div>
              <label style={labelStyle}>MOVE-IN DATE</label>
              <input
                type="date"
                value={moveInDate}
                onChange={(e) => setMoveInDate(e.target.value)}
                style={fieldStyle}
              />
            </div>
          </div>
        </div>

        <div hidden={step !== 2}>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            {/* Customer mode toggle */}
            <div>
              <label style={labelStyle}>CUSTOMER</label>
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
                {(["NEW", "EXISTING"] as CustomerMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCustomerMode(m)}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: "calc(var(--radius) - 2px)",
                      border: "none",
                      background: customerMode === m ? "var(--accent-primary)" : "transparent",
                      color: customerMode === m ? "#fff" : "var(--text-secondary)",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "11px",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      cursor: "pointer",
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {customerMode === "NEW" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                <div>
                  <label style={labelStyle}>TYPE</label>
                  <div style={{ display: "flex", gap: "4px", padding: "4px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
                    {(["INDIVIDUAL", "ORGANIZATION"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setCustomerType(t)}
                        style={{
                          flex: 1,
                          padding: "7px 0",
                          borderRadius: "4px",
                          border: "none",
                          background: customerType === t ? "var(--accent-primary)" : "transparent",
                          color: customerType === t ? "#fff" : "var(--text-secondary)",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: "10px",
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                {customerType === "INDIVIDUAL" ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div>
                      <label style={labelStyle}>FIRST NAME</label>
                      <input value={firstName} onChange={(e) => setFirstName(e.target.value)} style={fieldStyle} />
                    </div>
                    <div>
                      <label style={labelStyle}>LAST NAME</label>
                      <input value={lastName} onChange={(e) => setLastName(e.target.value)} style={fieldStyle} />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>ORGANIZATION NAME</label>
                    <input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} style={fieldStyle} />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  <div>
                    <label style={labelStyle}>EMAIL</label>
                    <input value={email} onChange={(e) => setEmail(e.target.value)} style={fieldStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>PHONE</label>
                    <input value={phone} onChange={(e) => setPhone(e.target.value)} style={fieldStyle} />
                  </div>
                </div>
              </div>
            )}

            {customerMode === "EXISTING" && (
              <div>
                <label style={labelStyle}>SELECT CUSTOMER</label>
                <SearchableEntitySelect<Customer>
                  value={existingCustomerId || undefined}
                  onChange={(v) => setExistingCustomerId(v ?? "")}
                  endpoint="/api/v1/customers"
                  placeholder="Search customers by name or email..."
                  label="Customer"
                  mapOption={(c) => ({
                    value: String(c.id),
                    label: customerLabel(c),
                    sublabel: c.email ?? undefined,
                  })}
                />
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "12px" }}>
              <div>
                <label style={labelStyle}>ACCOUNT NUMBER (OPTIONAL)</label>
                <input
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="Auto-generate"
                  style={fieldStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>ACCOUNT TYPE</label>
                <select value={accountType} onChange={(e) => setAccountType(e.target.value)} style={fieldStyle}>
                  <option value="RESIDENTIAL">Residential</option>
                  <option value="COMMERCIAL">Commercial</option>
                  <option value="INDUSTRIAL">Industrial</option>
                  <option value="MUNICIPAL">Municipal</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>DEPOSIT</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  style={fieldStyle}
                />
              </div>
            </div>
          </div>
        </div>

        <div hidden={step !== 3}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {agreements.map((a, i) => (
              <div
                key={a.key}
                style={{
                  padding: "14px",
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "12px",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      color: "var(--text-muted)",
                    }}
                  >
                    AGREEMENT {String(i + 1).padStart(2, "0")}
                  </div>
                  {agreements.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeAgreement(a.key)}
                      style={{
                        padding: "2px 8px",
                        border: "1px solid var(--danger)",
                        background: "transparent",
                        color: "var(--danger)",
                        fontSize: "10px",
                        fontFamily: "'JetBrains Mono', monospace",
                        borderRadius: "3px",
                        cursor: "pointer",
                      }}
                    >
                      REMOVE
                    </button>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr 1fr", gap: "10px" }}>
                  <div>
                    <label style={labelStyle}>COMMODITY</label>
                    <select
                      value={a.commodityId}
                      onChange={(e) => updateAgreement(a.key, { commodityId: e.target.value })}
                      style={fieldStyle}
                    >
                      <option value="">Select...</option>
                      {commodities.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>CYCLE</label>
                    <select
                      value={a.billingCycleId}
                      onChange={(e) => updateAgreement(a.key, { billingCycleId: e.target.value })}
                      style={fieldStyle}
                    >
                      <option value="">Select...</option>
                      {billingCycles.map((bc) => (
                        <option key={bc.id} value={bc.id}>
                          {bc.cycleCode}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>NUMBER (OPTIONAL)</label>
                    <input
                      value={a.agreementNumber}
                      onChange={(e) => updateAgreement(a.key, { agreementNumber: e.target.value })}
                      placeholder="Auto-generate"
                      style={fieldStyle}
                    />
                  </div>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={addAgreement}
              style={{
                padding: "10px",
                background: "transparent",
                border: "1px dashed var(--border)",
                borderRadius: "var(--radius)",
                color: "var(--text-secondary)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                fontWeight: 600,
                letterSpacing: "0.04em",
                cursor: "pointer",
              }}
            >
              + ADD ANOTHER AGREEMENT
            </button>

            {/* Review panel */}
            <div
              style={{
                marginTop: "18px",
                padding: "16px",
                background: "var(--bg-deep)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "12px",
                color: "var(--text-primary)",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: "var(--text-muted)",
                  marginBottom: "12px",
                }}
              >
                TRANSACTION PREVIEW
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <div>
                  premise: <span style={{ color: "var(--text-secondary)" }}>{premise ? `${premise.addressLine1}, ${premise.city}` : "—"}</span>
                </div>
                <div>
                  move_in_date: <span style={{ color: "var(--text-secondary)" }}>{moveInDate}</span>
                </div>
                <div>
                  customer:{" "}
                  <span style={{ color: "var(--text-secondary)" }}>
                    {customerMode === "EXISTING"
                      ? existing
                        ? customerLabel(existing)
                        : "—"
                      : customerType === "INDIVIDUAL"
                        ? `${firstName} ${lastName} (new)`
                        : `${organizationName} (new org)`}
                  </span>
                </div>
                <div>
                  account: <span style={{ color: "var(--text-secondary)" }}>{accountNumber || "—"} ({accountType})</span>
                </div>
                <div>
                  service_agreements:{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{agreements.length}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "12px", marginTop: "18px", justifyContent: "space-between" }}>
        <button
          type="button"
          onClick={() => (step > 1 ? setStep((s) => (s - 1) as Step) : router.push("/workflows"))}
          style={{
            padding: "10px 20px",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            color: "var(--text-secondary)",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.04em",
            cursor: "pointer",
          }}
        >
          ← {step === 1 ? "CANCEL" : "BACK"}
        </button>
        {step < 3 ? (
          <button
            type="button"
            disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid)}
            onClick={() => setStep((s) => (s + 1) as Step)}
            style={{
              padding: "10px 24px",
              background: "var(--accent-primary)",
              border: "none",
              borderRadius: "var(--radius)",
              color: "#fff",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              cursor: "pointer",
              opacity:
                (step === 1 && !step1Valid) || (step === 2 && !step2Valid) ? 0.5 : 1,
            }}
          >
            NEXT →
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting || !step3Valid}
            onClick={submit}
            style={{
              padding: "10px 24px",
              background: "var(--success)",
              border: "none",
              borderRadius: "var(--radius)",
              color: "#fff",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting || !step3Valid ? 0.6 : 1,
            }}
          >
            {submitting ? "COMMITTING..." : "COMMIT MOVE-IN ✓"}
          </button>
        )}
      </div>
    </div>
  );
}
