"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  rateType: string;
  effectiveDate: string;
  expirationDate?: string;
  version: number;
  description?: string;
  regulatoryRef?: string;
  rateConfig?: Record<string, unknown>;
  commodity?: { name: string };
  supersededById?: string;
  supersedes?: { id: string; version: number; name: string; effectiveDate: string };
  serviceAgreements?: Array<{
    id: string;
    agreementNumber: string;
    status: string;
  }>;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  createdAt: string;
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "180px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: "12px", color: "var(--text-muted)", fontWeight: "500" as const };
const valueStyle = { fontSize: "13px", color: "var(--text-primary)" };

export default function RateScheduleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [rs, setRs] = useState<RateSchedule | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [showReviseDialog, setShowReviseDialog] = useState(false);
  const [reviseDate, setReviseDate] = useState("");
  const [revising, setRevising] = useState(false);

  useEffect(() => {
    apiClient
      .get<RateSchedule>(`/api/v1/rate-schedules/${id}`)
      .then((data) => setRs(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (activeTab === "audit") {
      apiClient
        .get<{ data: AuditEntry[] }>("/api/v1/audit-log", {
          entityType: "RateSchedule",
          entityId: id,
        })
        .then((res) => setAudit(res.data ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  const handleRevise = async () => {
    if (!rs || !reviseDate) return;
    setRevising(true);
    try {
      const newRS = await apiClient.post<{ id: string }>(`/api/v1/rate-schedules/${id}/revise`, {
        effectiveDate: reviseDate,
      });
      router.push(`/rate-schedules/${newRS.id}`);
    } catch (err) {
      console.error("Revise failed", err);
    } finally {
      setRevising(false);
      setShowReviseDialog(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!rs) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Rate schedule not found.</div>;
  }

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: "24px",
          gap: "16px",
        }}
      >
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: "600", color: "var(--text-primary)", margin: "0 0 4px" }}>
            {rs.name}
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0 }}>
            {rs.code} — v{rs.version}
          </p>
        </div>
        {!rs.supersededById && (
          <button
            onClick={() => setShowReviseDialog(true)}
            style={{
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--accent-primary)",
              background: "transparent",
              color: "var(--accent-primary)",
              fontSize: "12px",
              fontWeight: "500",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Revise
          </button>
        )}
      </div>

      {showReviseDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              width: "380px",
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: "16px", color: "var(--text-primary)" }}>
              Revise Rate Schedule
            </h3>
            <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "16px" }}>
              Creates a new version of this schedule. The current version will be superseded.
            </p>
            <div style={{ marginBottom: "16px" }}>
              <label
                style={{ fontSize: "12px", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}
              >
                New Effective Date
              </label>
              <input
                type="date"
                value={reviseDate}
                onChange={(e) => setReviseDate(e.target.value)}
                style={{
                  padding: "8px 12px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                  fontFamily: "inherit",
                  width: "100%",
                  boxSizing: "border-box" as const,
                }}
              />
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
              <button
                onClick={() => setShowReviseDialog(false)}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "12px",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleRevise}
                disabled={revising || !reviseDate}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "none",
                  background: "var(--accent-primary)",
                  color: "#fff",
                  fontSize: "12px",
                  fontWeight: "500",
                  cursor: revising || !reviseDate ? "not-allowed" : "pointer",
                  opacity: revising || !reviseDate ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {revising ? "Creating..." : "Create Revision"}
              </button>
            </div>
          </div>
        </div>
      )}

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "versions", label: "Version History" },
          { key: "agreements", label: `Agreements (${rs.serviceAgreements?.length ?? 0})` },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        {activeTab === "overview" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            <div style={fieldStyle}>
              <span style={labelStyle}>Name</span>
              <span style={valueStyle}>{rs.name}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Code</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{rs.code}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Commodity</span>
              <CommodityBadge commodity={rs.commodity?.name ?? ""} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Rate Type</span>
              <span style={valueStyle}>{rs.rateType}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Version</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>v{rs.version}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Effective Date</span>
              <span style={valueStyle}>{rs.effectiveDate?.slice(0, 10) ?? "—"}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Expiration Date</span>
              <span style={valueStyle}>{rs.expirationDate?.slice(0, 10) ?? "None"}</span>
            </div>
            {rs.description && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Description</span>
                <span style={valueStyle}>{rs.description}</span>
              </div>
            )}
            {rs.regulatoryRef && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Regulatory Ref</span>
                <span style={valueStyle}>{rs.regulatoryRef}</span>
              </div>
            )}
            {rs.supersededById && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Superseded By</span>
                <button
                  onClick={() => router.push(`/rate-schedules/${rs.supersededById}`)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent-primary)",
                    fontSize: "13px",
                    cursor: "pointer",
                    padding: 0,
                    textDecoration: "underline",
                    fontFamily: "inherit",
                  }}
                >
                  View new version →
                </button>
              </div>
            )}
            <div style={fieldStyle}>
              <span style={labelStyle}>Rate Config</span>
              <pre
                style={{
                  fontFamily: "monospace",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  margin: 0,
                  background: "var(--bg-elevated)",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  overflowX: "auto",
                }}
              >
                {JSON.stringify(rs.rateConfig ?? {}, null, 2)}
              </pre>
            </div>
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Schedule ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {rs.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "versions" && (
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "20px 24px",
            }}
          >
            <div style={{ color: "var(--text-muted)", fontSize: "13px" }}>
              {rs.supersedes ? (
                <div>
                  <div style={{ marginBottom: "12px", color: "var(--text-secondary)", fontSize: "13px" }}>
                    This schedule supersedes:
                  </div>
                  <div
                    style={{
                      padding: "12px 16px",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-elevated)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <div>
                      <span style={{ fontWeight: 500 }}>{rs.supersedes.name}</span>
                      <span style={{ fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)", marginLeft: "8px" }}>
                        v{rs.supersedes.version}
                      </span>
                    </div>
                    <button
                      onClick={() => router.push(`/rate-schedules/${rs.supersedes!.id}`)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-primary)",
                        fontSize: "12px",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      View →
                    </button>
                  </div>
                </div>
              ) : (
                "This is the original version of this schedule."
              )}
            </div>
          </div>
        )}

        {activeTab === "agreements" && (
          <DataTable
            columns={[
              { key: "agreementNumber", header: "Agreement Number" },
              {
                key: "status",
                header: "Status",
                render: (row: any) => <StatusBadge status={row.status} />,
              },
            ]}
            data={(rs.serviceAgreements ?? []) as any}
            onRowClick={(row: any) => router.push(`/service-agreements/${row.id}`)}
          />
        )}

        {activeTab === "audit" && (
          <DataTable
            columns={[
              {
                key: "createdAt",
                header: "Timestamp",
                render: (row: any) => new Date(row.createdAt).toLocaleString(),
              },
              { key: "action", header: "Action" },
              { key: "actorId", header: "Actor", render: (row: any) => row.actorId ?? "System" },
            ]}
            data={audit as any}
          />
        )}
      </Tabs>
    </div>
  );
}
