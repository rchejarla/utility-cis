"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";

interface MeterInfo {
  meter: {
    id: string;
    meterNumber: string;
    meterType: string;
    status: string;
    uom: { code: string; name: string };
  };
}

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
  state: string;
  zip: string;
}

interface Agreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  endDate?: string;
  commodity: { id: string; name: string };
  servicePoints: Array<{ id: string; premise: Premise }>;
  billingCycle: { id: string; name: string };
  rateSchedule: { id: string; name: string };
  meters: MeterInfo[];
}

interface AccountDetail {
  id: string;
  accountNumber: string;
  accountType: string;
  status: string;
  serviceAgreements: Agreement[];
}

export default function PortalAccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [account, setAccount] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<{ data: AccountDetail }>(`/portal/api/accounts/${id}`)
      .then((res) => setAccount(res.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading account…</p>;
  }

  if (!account) {
    return <p style={{ color: "var(--danger)", padding: 24 }}>Account not found.</p>;
  }

  // Group agreements by premise
  const premiseMap = new Map<string, { premise: Premise; agreements: Agreement[] }>();
  for (const sa of account.serviceAgreements) {
    const sp = sa.servicePoints?.[0];
    if (!sp?.premise) continue;
    const key = sp.premise.id;
    if (!premiseMap.has(key)) {
      premiseMap.set(key, { premise: sp.premise, agreements: [] });
    }
    premiseMap.get(key)!.agreements.push(sa);
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Link
          href="/portal/dashboard"
          style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none", marginBottom: 8, display: "inline-block" }}
        >
          ← Back to dashboard
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
            Account {account.accountNumber}
          </h1>
          <StatusBadge status={account.status} />
        </div>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: "4px 0 0" }}>
          {account.accountType} · {account.serviceAgreements.length} service{account.serviceAgreements.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Premises with agreements and meters */}
      {Array.from(premiseMap.values()).map(({ premise, agreements }) => (
        <div
          key={premise.id}
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            marginBottom: 16,
            overflow: "hidden",
          }}
        >
          {/* Premise header */}
          <div
            style={{
              padding: "14px 20px",
              background: "var(--bg-elevated)",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {premise.addressLine1}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {premise.city}, {premise.state} {premise.zip}
            </span>
          </div>

          {/* Agreements at this premise */}
          {agreements.map((sa) => (
            <div
              key={sa.id}
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border-subtle)",
              }}
            >
              {/* Agreement row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                      {sa.commodity.name}
                    </span>
                    <StatusBadge status={sa.status} />
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                    {sa.agreementNumber} · {sa.rateSchedule.name} · {sa.billingCycle.name}
                  </div>
                </div>
                <Link
                  href={`/portal/usage?agreement=${sa.id}`}
                  style={{
                    fontSize: 12,
                    color: "var(--accent-primary)",
                    textDecoration: "none",
                    padding: "4px 10px",
                    border: "1px solid var(--accent-primary)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  View usage →
                </Link>
              </div>

              {/* Meters */}
              {sa.meters.length > 0 && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {sa.meters.map((am) => (
                    <div
                      key={am.meter.id}
                      style={{
                        padding: "8px 14px",
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius)",
                        fontSize: 12,
                      }}
                    >
                      <div style={{ fontWeight: 600, color: "var(--text-primary)", fontFamily: "'JetBrains Mono', monospace" }}>
                        {am.meter.meterNumber}
                      </div>
                      <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                        {am.meter.meterType} · {am.meter.uom.code}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {account.serviceAgreements.length === 0 && (
        <div
          style={{
            padding: 32,
            textAlign: "center",
            color: "var(--text-muted)",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          No services on this account
        </div>
      )}
    </div>
  );
}
