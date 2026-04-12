"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { MonthPicker } from "@/components/ui/month-picker";

interface Agreement {
  id: string;
  agreementNumber: string;
  status: string;
  commodity?: { name: string };
  premise?: { addressLine1: string; city: string; state: string; zip: string };
  billingCycle?: { name: string };
}

interface AccountWithAgreements {
  id: string;
  accountNumber: string;
  serviceAgreements: Agreement[];
}

interface ReadRow {
  id: string;
  readDate: string;
  reading: string;
  consumption: string;
  readType: string;
  meter: { meterNumber: string };
  uom?: { code: string; name: string };
}

type Granularity = "monthly" | "daily" | "hourly";

export default function PortalUsagePage() {
  const searchParams = useSearchParams();
  const presetAgreement = searchParams.get("agreement");
  const [accounts, setAccounts] = useState<AccountWithAgreements[]>([]);
  const [selectedAgreementId, setSelectedAgreementId] = useState<string | null>(presetAgreement);
  const [reads, setReads] = useState<ReadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [readsLoading, setReadsLoading] = useState(false);
  const [granularity, setGranularity] = useState<Granularity>("monthly");

  // Date range — default trailing 12 months
  const defaultTo = new Date().toISOString().slice(0, 7);
  const defaultFrom = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 11);
    return d.toISOString().slice(0, 7);
  })();
  const [fromMonth, setFromMonth] = useState(defaultFrom);
  const [toMonth, setToMonth] = useState(defaultTo);

  useEffect(() => {
    apiClient.get<{ accounts: AccountWithAgreements[] }>("/portal/api/dashboard")
      .then((data) => {
        setAccounts(data.accounts ?? []);
        const all = (data.accounts ?? []).flatMap((a) => a.serviceAgreements);
        if (all.length > 0 && !selectedAgreementId && !presetAgreement) {
          setSelectedAgreementId(all[0].id);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedAgreementId) return;
    setReadsLoading(true);
    apiClient.get<{ data: ReadRow[] }>(
      `/portal/api/agreements/${selectedAgreementId}/usage`,
      { from: fromMonth, to: toMonth },
    )
      .then((res) => setReads(res.data ?? []))
      .catch(console.error)
      .finally(() => setReadsLoading(false));
  }, [selectedAgreementId, fromMonth, toMonth]);

  const uomLabel = reads[0]?.uom?.code ?? "";
  const uomName = reads[0]?.uom?.name ?? "";

  const selectedAgreement = useMemo(() => {
    for (const acct of accounts) {
      const found = acct.serviceAgreements.find((sa) => sa.id === selectedAgreementId);
      if (found) return found;
    }
    return null;
  }, [accounts, selectedAgreementId]);

  const monthlyData = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reads) {
      const month = r.readDate.slice(0, 7);
      map.set(month, (map.get(month) ?? 0) + Number(r.consumption));
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, total]) => ({ month, total: Math.round(total * 100) / 100 }));
  }, [reads]);

  const maxVal = Math.max(1, ...monthlyData.map((d) => d.total));

  if (loading) {
    return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading…</p>;
  }

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Usage
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
          Consumption history across your premises and meters
        </p>
      </div>

      {/* Premise / meter selector */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "16px 20px",
          marginBottom: 20,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", marginBottom: 12 }}>
          Select a service point
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {accounts.map((acct) => (
            <div key={acct.id}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontWeight: 500 }}>
                Account {acct.accountNumber}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {acct.serviceAgreements.map((sa) => {
                  const isSelected = sa.id === selectedAgreementId;
                  return (
                    <button
                      key={sa.id}
                      onClick={() => setSelectedAgreementId(sa.id)}
                      style={{
                        padding: "8px 14px",
                        borderRadius: "var(--radius)",
                        fontSize: 12,
                        fontWeight: isSelected ? 600 : 500,
                        color: isSelected ? "var(--accent-primary-hover)" : "var(--text-secondary)",
                        background: isSelected ? "var(--accent-primary-subtle)" : "var(--bg-elevated)",
                        border: isSelected ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        textAlign: "left",
                        transition: "all 0.12s",
                      }}
                    >
                      <div>{sa.commodity?.name ?? "—"} · {sa.agreementNumber}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                        {sa.premise ? `${sa.premise.addressLine1}, ${sa.premise.city}` : "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {accounts.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No accounts found</div>
          )}
        </div>
      </div>

      {/* Date range + granularity */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>From</label>
          <div style={{ width: 150 }}>
            <MonthPicker value={fromMonth} onChange={setFromMonth} placeholder="Start month" />
          </div>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>To</label>
          <div style={{ width: 150 }}>
            <MonthPicker value={toMonth} onChange={setToMonth} placeholder="End month" />
          </div>
        </div>
        <div style={{ width: 1, height: 24, background: "var(--border)", flexShrink: 0 }} />
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
        {(["monthly", "daily", "hourly"] as Granularity[]).map((g) => {
          const isActive = granularity === g;
          const isDisabled = g !== "monthly";
          return (
            <button
              key={g}
              onClick={() => !isDisabled && setGranularity(g)}
              disabled={isDisabled}
              title={isDisabled ? "Interval data available in Phase 3" : undefined}
              style={{
                padding: "6px 14px",
                fontSize: 12,
                fontWeight: isActive ? 600 : 500,
                borderRadius: "var(--radius)",
                border: isActive ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
                background: isActive ? "var(--accent-primary-subtle)" : "var(--bg-card)",
                color: isActive ? "var(--accent-primary-hover)" : isDisabled ? "var(--text-muted)" : "var(--text-secondary)",
                cursor: isDisabled ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: isDisabled ? 0.5 : 1,
              }}
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </button>
          );
        })}
      </div>

      {/* Context banner */}
      {selectedAgreement && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
          Showing {granularity} consumption for{" "}
          <strong style={{ color: "var(--text-secondary)" }}>
            {selectedAgreement.commodity?.name}
          </strong>{" "}
          at{" "}
          <strong style={{ color: "var(--text-secondary)" }}>
            {selectedAgreement.premise?.addressLine1}, {selectedAgreement.premise?.city}
          </strong>
          {uomLabel && (
            <> · measured in <strong style={{ color: "var(--text-secondary)" }}>{uomName || uomLabel}</strong> ({uomLabel})</>
          )}
          {" "}· {fromMonth} to {toMonth}
        </div>
      )}

      {readsLoading ? (
        <p style={{ color: "var(--text-muted)" }}>Loading usage data…</p>
      ) : monthlyData.length === 0 ? (
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
          No usage data available for this service point
        </div>
      ) : (
        <>
          {/* Bar chart */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px 24px 16px",
              marginBottom: 20,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 200 }}>
              {monthlyData.map((d) => (
                <div
                  key={d.month}
                  style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
                >
                  <div
                    style={{ fontSize: 10, color: "var(--text-muted)", whiteSpace: "nowrap" }}
                    title={`${d.total.toLocaleString()} ${uomLabel}`}
                  >
                    {d.total.toLocaleString()}
                  </div>
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 40,
                      background: "var(--accent-primary)",
                      borderRadius: "4px 4px 0 0",
                      height: `${Math.max(4, (d.total / maxVal) * 160)}px`,
                      transition: "height 0.3s ease",
                    }}
                  />
                  <span style={{ fontSize: 9, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {new Date(d.month + "-01").toLocaleDateString(undefined, { month: "short" })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Data table */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--bg-elevated)" }}>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Meter</th>
                  <th style={thStyle}>Reading</th>
                  <th style={{ ...thStyle, textAlign: "right" }}>Consumption{uomLabel ? ` (${uomLabel})` : ""}</th>
                  <th style={thStyle}>Type</th>
                </tr>
              </thead>
              <tbody>
                {reads.map((r) => (
                  <tr key={r.id}>
                    <td style={tdStyle}>{new Date(r.readDate).toLocaleDateString()}</td>
                    <td style={tdStyle}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                        {r.meter.meterNumber}
                      </span>
                    </td>
                    <td style={tdStyle}>{Number(r.reading).toLocaleString()}</td>
                    <td style={{ ...tdStyle, textAlign: "right" }}>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600 }}>
                        {Number(r.consumption).toLocaleString()}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.readType}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Cost note */}
      <div
        style={{
          marginTop: 20,
          padding: "12px 16px",
          background: "var(--bg-card)",
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.6,
        }}
      >
        Cost data will be available here once the billing integration with SaaSLogic is live. Until then, only consumption quantities are shown. For your current charges, check the Bills page.
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 16px",
  textAlign: "left",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: 13,
  color: "var(--text-primary)",
  borderBottom: "1px solid var(--border-subtle)",
  whiteSpace: "nowrap",
};
