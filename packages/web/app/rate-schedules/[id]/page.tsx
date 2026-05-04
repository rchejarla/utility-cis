"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { useToast } from "@/components/ui/toast";
import { ComponentList, type RateComponent } from "@/components/rate-schedules/component-list";
import { ComponentEditor } from "@/components/rate-schedules/component-editor";

interface RateSchedule {
  id: string;
  name: string;
  code: string;
  effectiveDate: string;
  expirationDate?: string;
  version: number;
  description?: string;
  regulatoryRef?: string;
  commodity?: { name: string };
  supersededById?: string;
  supersedes?: { id: string; version: number; name: string; effectiveDate: string };
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  actorName?: string;
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
  const { canView, canEdit } = usePermission("rate_schedules");
  const { toast } = useToast();
  const [rs, setRs] = useState<RateSchedule | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [showReviseDialog, setShowReviseDialog] = useState(false);
  const [reviseDate, setReviseDate] = useState("");
  const [revising, setRevising] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingComponent, setEditingComponent] = useState<RateComponent | null>(null);

  const handleAdd = () => {
    setEditingComponent(null);
    setEditorOpen(true);
  };
  const handleEdit = (c: RateComponent) => {
    setEditingComponent(c);
    setEditorOpen(true);
  };
  const handleSaved = () => {
    setEditorOpen(false);
    setRefreshKey((k) => k + 1);
  };

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
      setShowReviseDialog(false);
      router.push(`/rate-schedules/${newRS.id}`);
    } catch (err) {
      const message = err instanceof Error
        ? err.message.replace(/^API error \d+:\s*/, "")
        : "Revise failed";
      toast(message, "error");
    } finally {
      setRevising(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!canView) return <AccessDenied />;
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
        {canEdit && !rs.supersededById && (
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
              <DatePicker
                value={reviseDate}
                onChange={(v) => setReviseDate(v)}
              />
              <div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "6px" }}>
                Must be after the current version's effective date ({rs.effectiveDate.split("T")[0]}).
              </div>
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
          { key: "agreements", label: "Agreements" },
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
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Schedule ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {rs.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "overview" && (
          <div style={{ marginTop: 20 }}>
            <ComponentList
              scheduleId={id}
              refreshKey={refreshKey}
              onEdit={handleEdit}
              onAdd={handleAdd}
            />
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
          <div
            style={{
              padding: "32px 24px",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            Agreement assignments will be listed here once the v2 schedule
            assignment join (SAScheduleAssignment) is wired through — see
            slice 1 task 9.
          </div>
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
              { key: "actorId", header: "Actor", render: (row: any) => row.actorName ?? row.actorId ?? "System" },
            ]}
            data={audit as any}
          />
        )}
      </Tabs>

      {editorOpen && (
        <ComponentEditor
          scheduleId={id}
          component={editingComponent}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
