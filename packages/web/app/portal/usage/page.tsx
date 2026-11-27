"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { MonthPicker } from "@/components/ui/month-picker";

interface Agreement {
  id: string;
  agreementNumber: string;
  status: string;
  commodity?: { name: string };
  servicePoints?: Array<{
    premise: { id: string; addressLine1: string; city: string; state: string; zip: string };
  }>;
}

interface AccountWithAgreements {
  id: string;
  accountNumber: string;
  // Slice 5b.1 — billing cycle moved to Account.
  billingCycle?: { id: string; name: string };
  serviceAgreements: Agreement[];
}

interface ReadRow {
  id: string;
  readDate: string;
  /** Null for a TOU bucket, which has a quantity and no dial behind it. */
  reading: string | null;
  consumption: string;
  readType: string;
  /** The TOU period a bucket row belongs to; null for a total read. */
  peakCode: string | null;
  meter: { meterNumber: string };
  uom?: { code: string; name: string };
}

interface MonthlyTotal {
  month: string;
  total: number;
}

interface BilledPeriod {
  segmentId: string;
  periodStart: string;
  periodEnd: string;
  billNumber: string;
  tou: boolean;
}

/** One billed period's usage by TOU period (the bill's own table) and by hour of day. */
interface BilledPeriodUsage {
  byPeriod: {
    heading: string;
    rows: Array<{ label: string; usage: string; share: string; amount: string }>;
    footnote: string[];
  } | null;
  hourly: {
    unit: string | null;
    periods: Array<{ code: string; label: string }>;
    hours: Array<{ hour: number; byPeriod: Record<string, number> }>;
  } | null;
}

/** A colour per TOU period, in the tenant's display order. */
const PERIOD_COLOURS = ["var(--danger)", "var(--warning)", "var(--accent-primary)", "var(--success)", "var(--text-muted)"];

const hourLabel = (h: number) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);

/** "off_peak" → "Off peak". The tenant's own labels are not on this endpoint. */
const periodLabel = (code: string) => {
  const words = code.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type Granularity = "monthly" | "daily" | "hourly";

// Reads `?agreementId=` + `?month=` via useSearchParams (for deep-
// linking from the account detail). Next.js 15's static-prerender
// pass requires any component calling useSearchParams to sit inside
// a <Suspense> boundary.
export default function PortalUsagePage() {
  return (
    <Suspense fallback={<div style={{ padding: 24, color: "var(--text-muted)" }}>Loading…</div>}>
      <PortalUsagePageInner />
    </Suspense>
  );
}

function PortalUsagePageInner() {
  const searchParams = useSearchParams();
  const presetAgreement = searchParams.get("agreement");
  const [accounts, setAccounts] = useState<AccountWithAgreements[]>([]);
  const [selectedAgreementId, setSelectedAgreementId] = useState<string | null>(presetAgreement);
  const [reads, setReads] = useState<ReadRow[]>([]);
  const [monthlyData, setMonthlyData] = useState<MonthlyTotal[]>([]);
  const [billedPeriods, setBilledPeriods] = useState<BilledPeriod[]>([]);
  const [segmentId, setSegmentId] = useState<string | null>(null);
  const [periodUsage, setPeriodUsage] = useState<BilledPeriodUsage | null>(null);
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
    apiClient.get<{ data: ReadRow[]; monthly: MonthlyTotal[] }>(
      `/portal/api/agreements/${selectedAgreementId}/usage`,
      { from: fromMonth, to: toMonth },
    )
      .then((res) => {
        setReads(res.data ?? []);
        setMonthlyData(res.monthly ?? []);
      })
      .catch(console.error)
      .finally(() => setReadsLoading(false));
  }, [selectedAgreementId, fromMonth, toMonth]);

  /*
   * Billed time-of-use periods, for the Hourly view (spec 26, TOU-BIL-3).
   * Only billed ones: the breakdown is the bill's own, and a period nobody
   * has billed yet has no bill to agree with.
   */
  useEffect(() => {
    setBilledPeriods([]);
    setSegmentId(null);
    setPeriodUsage(null);
    if (!selectedAgreementId) return;
    apiClient
      .get<{ data: BilledPeriod[] }>(`/portal/api/agreements/${selectedAgreementId}/billed-periods`)
      .then((res) => {
        const tou = (res.data ?? []).filter((p) => p.tou);
        setBilledPeriods(tou);
        setSegmentId(tou[0]?.segmentId ?? null);
      })
      .catch(() => setBilledPeriods([]));
  }, [selectedAgreementId]);

  useEffect(() => {
    setPeriodUsage(null);
    if (!selectedAgreementId || !segmentId || granularity !== "hourly") return;
    apiClient
      .get<BilledPeriodUsage>(
        `/portal/api/agreements/${selectedAgreementId}/billed-periods/${segmentId}/usage`,
      )
      .then(setPeriodUsage)
      .catch(() => setPeriodUsage(null));
  }, [selectedAgreementId, segmentId, granularity]);

  // Back to monthly when the agreement has no billed TOU period to show.
  useEffect(() => {
    if (granularity === "hourly" && billedPeriods.length === 0) setGranularity("monthly");
  }, [billedPeriods, granularity]);

  const uomLabel = reads[0]?.uom?.code ?? "";
  const uomName = reads[0]?.uom?.name ?? "";

  const selectedAgreement = useMemo(() => {
    for (const acct of accounts) {
      const found = acct.serviceAgreements.find((sa) => sa.id === selectedAgreementId);
      if (found) return found;
    }
    return null;
  }, [accounts, selectedAgreementId]);

  /*
   * The monthly figures come from the API, not from adding up `reads`
   * here. A TOU meter's month holds a total read *and* a row per TOU
   * period that reconcile to it, so summing every row counted the month
   * about twice — what the customer saw was not what they were billed for.
   * The API applies the rating engine's own rule (the total wins, the
   * buckets stand in where there is none).
   */
  const hasTouRows = useMemo(() => reads.some((r) => r.peakCode !== null), [reads]);

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
                        {(() => {
                          const p = sa.servicePoints?.[0]?.premise;
                          return p ? `${p.addressLine1}, ${p.city}` : "—";
                        })()}
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
          // Hourly is the billed time-of-use breakdown; daily has no data behind it yet.
          const isDisabled = g === "daily" || (g === "hourly" && billedPeriods.length === 0);
          const why =
            g === "daily"
              ? "Daily usage is not available yet"
              : "Hourly usage is shown for billed time-of-use periods";
          return (
            <button
              key={g}
              onClick={() => !isDisabled && setGranularity(g)}
              disabled={isDisabled}
              title={isDisabled ? why : undefined}
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
            {(() => {
              const p = selectedAgreement.servicePoints?.[0]?.premise;
              return p ? `${p.addressLine1}, ${p.city}` : "—";
            })()}
          </strong>
          {uomLabel && (
            <> · measured in <strong style={{ color: "var(--text-secondary)" }}>{uomName || uomLabel}</strong> ({uomLabel})</>
          )}
          {" "}· {fromMonth} to {toMonth}
        </div>
      )}

      {granularity === "hourly" ? (
        <div data-testid="tou-view">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <label htmlFor="billed-period" style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500 }}>
              Billed period
            </label>
            <select
              id="billed-period"
              value={segmentId ?? ""}
              onChange={(e) => setSegmentId(e.target.value)}
              style={{
                padding: "6px 10px",
                fontSize: 13,
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                fontFamily: "inherit",
              }}
            >
              {billedPeriods.map((p) => (
                <option key={p.segmentId} value={p.segmentId}>
                  {p.periodStart} – {p.periodEnd}{p.billNumber ? ` (bill ${p.billNumber})` : ""}
                </option>
              ))}
            </select>
          </div>

          {!periodUsage ? (
            <p style={{ color: "var(--text-muted)" }}>Loading…</p>
          ) : (
            <>
              {periodUsage.hourly ? (
                <div
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    padding: "20px 24px 14px",
                    marginBottom: 20,
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
                    Usage by hour of day, across the billed period
                    {periodUsage.hourly.unit ? ` (${periodUsage.hourly.unit})` : ""}
                  </div>
                  {(() => {
                    const hourly = periodUsage.hourly!;
                    const totalOf = (h: { byPeriod: Record<string, number> }) =>
                      Object.values(h.byPeriod).reduce((a, b) => a + b, 0);
                    const max = Math.max(1, ...hourly.hours.map(totalOf));
                    return (
                      <>
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 160 }}>
                          {hourly.hours.map((h) => (
                            <div
                              key={h.hour}
                              data-testid={`hour-${h.hour}`}
                              title={`${hourLabel(h.hour)}: ${Math.round(totalOf(h) * 100) / 100}`}
                              style={{ flex: 1, display: "flex", flexDirection: "column-reverse", height: "100%" }}
                            >
                              {hourly.periods.map((p, i) => {
                                const v = h.byPeriod[p.code] ?? 0;
                                if (v === 0) return null;
                                return (
                                  <div
                                    key={p.code}
                                    style={{
                                      height: `${(v / max) * 100}%`,
                                      background: PERIOD_COLOURS[i % PERIOD_COLOURS.length],
                                    }}
                                  />
                                );
                              })}
                            </div>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
                          {hourly.hours.map((h) => (
                            <span key={h.hour} style={{ flex: 1, fontSize: 9, color: "var(--text-muted)", textAlign: "center" }}>
                              {h.hour % 3 === 0 ? hourLabel(h.hour) : ""}
                            </span>
                          ))}
                        </div>
                        <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
                          {hourly.periods.map((p, i) => (
                            <span key={p.code} style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ width: 10, height: 10, borderRadius: 2, background: PERIOD_COLOURS[i % PERIOD_COLOURS.length] }} />
                              {p.label}
                            </span>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div
                  style={{
                    padding: 16,
                    marginBottom: 20,
                    color: "var(--text-muted)",
                    background: "var(--bg-card)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius)",
                    fontSize: 13,
                  }}
                >
                  Hourly data isn&apos;t available for this meter — it records how much you used in
                  each time-of-use period, not when.
                </div>
              )}

              {periodUsage.byPeriod && (
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
                        <th style={thStyle}>Period</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Usage</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Share</th>
                        <th style={{ ...thStyle, textAlign: "right" }}>Charged</th>
                      </tr>
                    </thead>
                    <tbody>
                      {periodUsage.byPeriod.rows.map((r) => (
                        <tr key={r.label}>
                          <td style={tdStyle}>{r.label}</td>
                          <td style={{ ...tdStyle, textAlign: "right" }}>{r.usage}</td>
                          <td style={{ ...tdStyle, textAlign: "right" }}>{r.share}</td>
                          <td style={{ ...tdStyle, textAlign: "right" }}>${r.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {periodUsage.byPeriod.footnote.length > 0 && (
                    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
                      {periodUsage.byPeriod.footnote.map((line) => (
                        <div key={line}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      ) : readsLoading ? (
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
                  {hasTouRows && <th style={thStyle}>Period</th>}
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
                    {hasTouRows && (
                      <td style={tdStyle} data-testid="usage-period">
                        {r.peakCode ? periodLabel(r.peakCode) : "Total"}
                      </td>
                    )}
                    {/* A TOU bucket has no dial reading, and printed `0` here. */}
                    <td style={tdStyle}>
                      {r.reading === null ? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      ) : (
                        Number(r.reading).toLocaleString()
                      )}
                    </td>
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
        {/* This said cost data was waiting on "the billing integration
            with SaaSLogic" until 2026-10-22, which was wrong twice over:
            SaaSLogic stopped doing the pricing on 2026-10-09, and CIS has
            priced its own charges since rate-model slice 5a. What this
            page genuinely lacks is per-read costing — a charge belongs to
            a billed period, not to a single read. */}
        This page shows the quantities you have used. Charges are worked out per billing
        period rather than per reading, so you will find them on your{" "}
        <a href="/portal/bills" style={{ color: "var(--accent-primary)" }}>
          Bills
        </a>{" "}
        page.
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
