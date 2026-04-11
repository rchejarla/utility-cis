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
 * Move-out wizard. Flow:
 *   1. Pick account → load its active agreements at any premise
 *   2. Pick the premise the customer is leaving → load the meters
 *      attached to the active agreements there
 *   3. Capture final meter readings + optional forwarding address +
 *      decision to close the account
 *   4. Atomic commit on the backend (all SAs FINAL, all meters
 *      detached, optional account close)
 */

interface Account {
  id: string;
  accountNumber: string;
  status: string;
  customer?: {
    firstName?: string | null;
    lastName?: string | null;
    organizationName?: string | null;
    customerType?: string;
  };
}

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  premise?: {
    id: string;
    addressLine1: string;
    city: string;
  };
  meters?: Array<{
    meterId: string;
    meter: {
      id: string;
      meterNumber: string;
      multiplier: string;
    };
  }>;
}

export default function MoveOutWizardPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("workflows");
  const { toast } = useToast();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountAgreements, setAccountAgreements] = useState<ServiceAgreement[]>([]);
  const [premiseId, setPremiseId] = useState("");
  const [moveOutDate, setMoveOutDate] = useState(new Date().toISOString().slice(0, 10));

  const [readings, setReadings] = useState<Record<string, string>>({});
  const [closeAccount, setCloseAccount] = useState(false);
  const [refundDeposit, setRefundDeposit] = useState(false);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    apiClient
      .get<{ data: Account[] }>("/api/v1/accounts", { limit: "500", status: "ACTIVE" })
      .then((res) => setAccounts(res.data ?? []))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!accountId) {
      setAccountAgreements([]);
      return;
    }
    apiClient
      .get<{ data: ServiceAgreement[] }>("/api/v1/service-agreements", {
        accountId,
        limit: "100",
      })
      .then((res) => setAccountAgreements((res.data ?? []).filter((a) => a.status === "ACTIVE" || a.status === "PENDING")))
      .catch(console.error);
  }, [accountId]);

  if (!canView) return <AccessDenied />;

  const premisesAtAccount = Array.from(
    new Map(
      accountAgreements
        .filter((a) => a.premise)
        .map((a) => [a.premise!.id, a.premise!]),
    ).values(),
  );

  const agreementsAtPremise = accountAgreements.filter(
    (a) => a.premise?.id === premiseId,
  );

  const metersAtPremise = Array.from(
    new Map(
      agreementsAtPremise
        .flatMap((a) => a.meters ?? [])
        .map((m) => [m.meterId, m.meter]),
    ).values(),
  );

  const accountLabel = (a: Account) => {
    const c = a.customer;
    if (!c) return a.accountNumber;
    const name =
      c.customerType === "ORGANIZATION"
        ? c.organizationName ?? ""
        : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
    return `${a.accountNumber} — ${name || "(unnamed)"}`;
  };

  const step1Valid = accountId;
  const step2Valid = premiseId && moveOutDate;
  const step3Valid = metersAtPremise.every((m) => readings[m.id]?.length);

  const submit = async () => {
    if (!canCreate) {
      toast("No permission", "error");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        accountId,
        premiseId,
        moveOutDate,
        finalMeterReadings: metersAtPremise.map((m) => ({
          meterId: m.id,
          reading: parseFloat(readings[m.id] ?? "0"),
        })),
        closeAccount,
        refundDeposit,
      };
      if (notes) body.notes = notes;
      await apiClient.post("/api/v1/workflows/move-out", body);
      toast("Move-out complete", "success");
      router.push(`/accounts/${accountId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Move-out failed", "error");
    } finally {
      setSubmitting(false);
    }
  };

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
        title="Move Out"
        subtitle="Finalize all active service agreements on an account at a premise. Final reads are captured in the same transaction."
      />

      {/* Stepper */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "24px" }}>
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
                borderLeft: active
                  ? "4px solid var(--warning)"
                  : done
                    ? "4px solid var(--success)"
                    : "4px solid var(--border)",
                borderRadius: "var(--radius)",
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
                  color: active ? "var(--warning)" : done ? "var(--success)" : "var(--text-muted)",
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
                {n === 1 && "Account"}
                {n === 2 && "Premise & Date"}
                {n === 3 && "Final Reads"}
              </div>
            </div>
          );
        })}
      </div>

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
         * mounted. Keeping the account SearchableEntitySelect mounted
         * across step navigation preserves its `knownLabels` cache so
         * clicking Back from step 2 doesn't show the raw UUID in the
         * account trigger.
         */}
        <div hidden={step !== 1}>
          <div>
            <label style={labelStyle}>ACCOUNT</label>
            <SearchableEntitySelect<Account>
              value={accountId || undefined}
              onChange={(v) => setAccountId(v ?? "")}
              endpoint="/api/v1/accounts"
              extraParams={{ status: "ACTIVE" }}
              placeholder="Search accounts by number or name..."
              label="Account"
              mapOption={(a) => ({
                value: String(a.id),
                label: accountLabel(a),
                sublabel: a.accountNumber,
              })}
            />
            {accountId && (
              <div
                style={{
                  marginTop: "16px",
                  padding: "12px",
                  background: "var(--bg-elevated)",
                  borderRadius: "var(--radius)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                }}
              >
                active_agreements: <strong style={{ color: "var(--text-primary)" }}>{accountAgreements.length}</strong>
              </div>
            )}
          </div>
        </div>

        <div hidden={step !== 2}>
          <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
            <div>
              <label style={labelStyle}>PREMISE TO LEAVE</label>
              <select
                value={premiseId}
                onChange={(e) => setPremiseId(e.target.value)}
                style={fieldStyle}
              >
                <option value="">Select premise...</option>
                {premisesAtAccount.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.addressLine1}, {p.city}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>MOVE-OUT DATE</label>
              <input
                type="date"
                value={moveOutDate}
                onChange={(e) => setMoveOutDate(e.target.value)}
                style={fieldStyle}
              />
            </div>
            {premiseId && (
              <div
                style={{
                  padding: "12px",
                  background: "var(--bg-elevated)",
                  borderRadius: "var(--radius)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                }}
              >
                agreements_to_finalize:{" "}
                <strong style={{ color: "var(--warning)" }}>{agreementsAtPremise.length}</strong>
                {" · "}
                meters_to_read:{" "}
                <strong style={{ color: "var(--warning)" }}>{metersAtPremise.length}</strong>
              </div>
            )}
          </div>
        </div>

        <div hidden={step !== 3}>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <label style={labelStyle}>FINAL METER READINGS</label>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {metersAtPremise.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 180px",
                      gap: "12px",
                      alignItems: "center",
                      padding: "10px 14px",
                      background: "var(--bg-elevated)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: "12px",
                        fontWeight: 600,
                      }}
                    >
                      {m.meterNumber}
                    </div>
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={readings[m.id] ?? ""}
                      onChange={(e) =>
                        setReadings((prev) => ({ ...prev, [m.id]: e.target.value }))
                      }
                      placeholder="Final reading"
                      style={{
                        ...fieldStyle,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    />
                  </div>
                ))}
                {metersAtPremise.length === 0 && (
                  <div style={{ color: "var(--text-muted)", fontSize: "12px", padding: "12px" }}>
                    No meters linked to active agreements at this premise.
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: "20px",
                padding: "14px",
                background: "var(--bg-elevated)",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={closeAccount}
                  onChange={(e) => setCloseAccount(e.target.checked)}
                />
                Close account (only if no other premises remain)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={refundDeposit}
                  onChange={(e) => setRefundDeposit(e.target.checked)}
                />
                Refund deposit
              </label>
            </div>

            <div>
              <label style={labelStyle}>NOTES</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                placeholder="Forwarding address, reason for move-out, etc."
                style={{ ...fieldStyle, minHeight: "72px", resize: "vertical" }}
              />
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: "12px", marginTop: "18px", justifyContent: "space-between" }}>
        <button
          type="button"
          onClick={() => (step > 1 ? setStep((s) => (s - 1) as 1 | 2 | 3) : router.push("/workflows"))}
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
            onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}
            style={{
              padding: "10px 24px",
              background: "var(--warning)",
              border: "none",
              borderRadius: "var(--radius)",
              color: "#000",
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
              background: "var(--warning)",
              border: "none",
              borderRadius: "var(--radius)",
              color: "#000",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "11px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting || !step3Valid ? 0.6 : 1,
            }}
          >
            {submitting ? "COMMITTING..." : "COMMIT MOVE-OUT ✓"}
          </button>
        )}
      </div>
    </div>
  );
}
