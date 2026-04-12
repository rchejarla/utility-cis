"use client";

import { useEffect, useMemo, useState } from "react";

interface ReadRow {
  id: string;
  readDate: string;
  reading: string;
  consumption: string;
  readType: string;
  meter: { meterNumber: string };
}

function portalFetch<T>(path: string): Promise<T> {
  const token = localStorage.getItem("portal_token") ?? "";
  return fetch(`http://localhost:3001${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json() as Promise<T>;
  });
}

/**
 * Portal usage page. Shows a simple bar chart of monthly consumption
 * from the MeterRead table, plus a data table underneath.
 *
 * This is a read-only view scoped to the authenticated customer's
 * agreements. When interval reads land in Phase 3, this will also
 * show hourly/daily granularity from the hypertable.
 */
export default function PortalUsagePage() {
  const [reads, setReads] = useState<ReadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [agreementId, setAgreementId] = useState<string | null>(null);
  const [agreements, setAgreements] = useState<Array<{ id: string; agreementNumber: string }>>([]);

  useEffect(() => {
    portalFetch<{ accounts: Array<{ serviceAgreements: Array<{ id: string; agreementNumber: string }> }> }>(
      "/portal/api/dashboard",
    )
      .then((data) => {
        const all = data.accounts.flatMap((a) => a.serviceAgreements);
        setAgreements(all);
        if (all.length > 0 && !agreementId) setAgreementId(all[0].id);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!agreementId) return;
    setLoading(true);
    portalFetch<{ data: ReadRow[] }>(
      `/portal/api/agreements/${agreementId}/usage?months=12`,
    )
      .then((res) => setReads(res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [agreementId]);

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

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: "var(--text-primary)",
            margin: "0 0 4px",
          }}
        >
          Usage
        </h1>
        <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
          Monthly consumption from meter reads
        </p>
      </div>

      {agreements.length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, display: "block", marginBottom: 6 }}>
            Agreement
          </label>
          <select
            value={agreementId ?? ""}
            onChange={(e) => setAgreementId(e.target.value)}
            style={{
              padding: "8px 12px",
              fontSize: 13,
              background: "var(--bg-deep)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              fontFamily: "inherit",
            }}
          >
            {agreements.map((a) => (
              <option key={a.id} value={a.id}>
                {a.agreementNumber}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
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
          No usage data available for this agreement
        </div>
      ) : (
        <>
          {/* Simple bar chart */}
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px 24px 16px",
              marginBottom: 20,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 6,
                height: 180,
              }}
            >
              {monthlyData.map((d) => (
                <div
                  key={d.month}
                  style={{
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      maxWidth: 40,
                      background: "var(--accent-primary)",
                      borderRadius: "4px 4px 0 0",
                      height: `${Math.max(4, (d.total / maxVal) * 160)}px`,
                      transition: "height 0.3s ease",
                    }}
                    title={`${d.month}: ${d.total}`}
                  />
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {d.month.slice(5)}
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
                  <th style={{ ...thStyle, textAlign: "right" }}>Consumption</th>
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
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        {Number(r.consumption).toLocaleString()}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        {r.readType}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
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
