"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/components/ui/toast";
import { SearchableEntitySelect } from "@/components/ui/searchable-entity-select";

/**
 * Transfer-of-service wizard. Side-by-side "from → to" layout makes
 * the core mental model visible: you're moving a service from one
 * account to another. The diff panel at the bottom shows what the
 * transaction will actually do before you commit.
 */

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  account?: {
    id: string;
    accountNumber: string;
    customer?: {
      firstName?: string | null;
      lastName?: string | null;
      organizationName?: string | null;
      customerType?: string;
    };
  };
  premise?: {
    id: string;
    addressLine1: string;
    city: string;
  };
  commodity?: {
    name: string;
  };
}

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

const customerName = (c?: { firstName?: string | null; lastName?: string | null; organizationName?: string | null; customerType?: string }) => {
  if (!c) return "(no customer)";
  return c.customerType === "ORGANIZATION"
    ? c.organizationName ?? "(unnamed org)"
    : `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "(unnamed)";
};

export default function TransferWizardPage() {
  const router = useRouter();
  const { canView, canCreate } = usePermission("workflows");
  const { toast } = useToast();

  const [agreements, setAgreements] = useState<ServiceAgreement[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [targetAccountId, setTargetAccountId] = useState("");
  const [transferDate, setTransferDate] = useState(new Date().toISOString().slice(0, 10));
  const [newAgreementNumber, setNewAgreementNumber] = useState("");
  const [finalReading, setFinalReading] = useState("");
  const [initialReading, setInitialReading] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      apiClient.get<{ data: ServiceAgreement[] }>("/api/v1/service-agreements", {
        limit: "500",
        status: "ACTIVE",
      }),
      apiClient.get<{ data: Account[] }>("/api/v1/accounts", {
        limit: "500",
        status: "ACTIVE",
      }),
    ])
      .then(([sa, ac]) => {
        setAgreements(sa.data ?? []);
        setAccounts(ac.data ?? []);
      })
      .catch(console.error);
  }, []);

  if (!canView) return <AccessDenied />;

  const source = agreements.find((a) => a.id === sourceId);
  const target = accounts.find((a) => a.id === targetAccountId);

  // newAgreementNumber is optional — backend auto-generates when blank.
  const valid = sourceId && targetAccountId && transferDate;

  const submit = async () => {
    if (!canCreate) {
      toast("No permission", "error");
      return;
    }
    if (sourceId && target && source?.account?.id === target.id) {
      toast("Source and target must be different accounts", "error");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        targetAccountId,
        transferDate,
        ...(newAgreementNumber ? { newAgreementNumber } : {}),
      };
      if (finalReading) body.finalMeterReading = parseFloat(finalReading);
      if (initialReading) body.initialMeterReading = parseFloat(initialReading);
      if (reason) body.reason = reason;
      const result = await apiClient.post<{ target: { id: string } }>(
        `/api/v1/service-agreements/${sourceId}/transfer`,
        body,
      );
      toast("Service transferred", "success");
      router.push(`/service-agreements/${result.target.id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Transfer failed", "error");
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
    <div style={{ maxWidth: "960px" }}>
      <PageHeader
        title="Transfer Service"
        subtitle="Reassign an active service agreement from one account to another. The source is finalized and a new agreement is opened on the target account at the transfer date."
      />

      {/* Source / arrow / target layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 60px 1fr",
          gap: "12px",
          alignItems: "stretch",
          marginBottom: "18px",
        }}
      >
        {/* SOURCE */}
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--danger)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--danger)",
              marginBottom: "12px",
            }}
          >
            SOURCE — WILL BE FINALIZED
          </div>
          <label style={labelStyle}>SERVICE AGREEMENT</label>
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} style={fieldStyle}>
            <option value="">Select agreement...</option>
            {agreements.map((a) => (
              <option key={a.id} value={a.id}>
                {a.agreementNumber} — {a.commodity?.name ?? "?"}
              </option>
            ))}
          </select>
          {source && (
            <div
              style={{
                marginTop: "14px",
                padding: "12px",
                background: "var(--bg-elevated)",
                borderRadius: "4px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "var(--text-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div>
                account: <strong style={{ color: "var(--text-primary)" }}>{source.account?.accountNumber}</strong>
              </div>
              <div>
                customer: <strong style={{ color: "var(--text-primary)" }}>{customerName(source.account?.customer)}</strong>
              </div>
              <div>
                premise: <strong style={{ color: "var(--text-primary)" }}>{source.premise?.addressLine1}, {source.premise?.city}</strong>
              </div>
              <div>
                commodity: <strong style={{ color: "var(--text-primary)" }}>{source.commodity?.name}</strong>
              </div>
            </div>
          )}
          <div style={{ marginTop: "14px" }}>
            <label style={labelStyle}>FINAL READING (optional)</label>
            <input
              type="number"
              step="any"
              min="0"
              value={finalReading}
              onChange={(e) => setFinalReading(e.target.value)}
              placeholder="—"
              style={fieldStyle}
            />
          </div>
        </div>

        {/* ARROW */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "28px",
            color: "var(--accent-primary)",
          }}
        >
          →
        </div>

        {/* TARGET */}
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderLeft: "3px solid var(--success)",
            borderRadius: "var(--radius)",
            padding: "18px",
          }}
        >
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--success)",
              marginBottom: "12px",
            }}
          >
            TARGET — NEW AGREEMENT
          </div>
          <label style={labelStyle}>TARGET ACCOUNT</label>
          <select
            value={targetAccountId}
            onChange={(e) => setTargetAccountId(e.target.value)}
            style={fieldStyle}
          >
            <option value="">Select account...</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.accountNumber} — {customerName(a.customer)}
              </option>
            ))}
          </select>
          {target && (
            <div
              style={{
                marginTop: "14px",
                padding: "12px",
                background: "var(--bg-elevated)",
                borderRadius: "4px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "11px",
                color: "var(--text-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div>
                account: <strong style={{ color: "var(--text-primary)" }}>{target.accountNumber}</strong>
              </div>
              <div>
                customer: <strong style={{ color: "var(--text-primary)" }}>{customerName(target.customer)}</strong>
              </div>
              <div>
                status: <strong style={{ color: "var(--success)" }}>{target.status}</strong>
              </div>
            </div>
          )}
          <div style={{ marginTop: "14px" }}>
            <label style={labelStyle}>NEW AGREEMENT NUMBER (OPTIONAL)</label>
            <input
              value={newAgreementNumber}
              onChange={(e) => setNewAgreementNumber(e.target.value)}
              placeholder="Auto-generate"
              style={fieldStyle}
            />
          </div>
          <div style={{ marginTop: "10px" }}>
            <label style={labelStyle}>INITIAL READING (optional)</label>
            <input
              type="number"
              step="any"
              min="0"
              value={initialReading}
              onChange={(e) => setInitialReading(e.target.value)}
              placeholder="—"
              style={fieldStyle}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "20px",
          display: "grid",
          gridTemplateColumns: "1fr 2fr",
          gap: "16px",
          marginBottom: "18px",
        }}
      >
        <div>
          <label style={labelStyle}>TRANSFER DATE</label>
          <input
            type="date"
            value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)}
            style={fieldStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>REASON (optional)</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Sale of property, ownership change, etc."
            style={fieldStyle}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: "12px", justifyContent: "space-between" }}>
        <Link
          href="/workflows"
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
            textDecoration: "none",
          }}
        >
          ← CANCEL
        </Link>
        <button
          type="button"
          disabled={!valid || submitting}
          onClick={submit}
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
            cursor: submitting ? "not-allowed" : "pointer",
            opacity: !valid || submitting ? 0.5 : 1,
          }}
        >
          {submitting ? "TRANSFERRING..." : "COMMIT TRANSFER ⇄"}
        </button>
      </div>
    </div>
  );
}
