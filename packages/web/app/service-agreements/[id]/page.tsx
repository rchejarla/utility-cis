"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { MeterManagementTab } from "@/components/service-agreements/meters-tab";

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  endDate?: string;
  readSequence?: number;
  account?: { id: string; accountNumber: string };
  premise?: { id: string; addressLine1: string; city: string; state: string };
  commodity?: { name: string };
  rateSchedule?: { id: string; name: string; code: string };
  billingCycle?: { id: string; name: string; cycleCode: string };
  rateScheduleId?: string;
  billingCycleId?: string;
  commodityId?: string;
  premiseId?: string;
  meters?: Array<{
    id: string;
    meterId: string;
    isPrimary: boolean;
    addedDate: string;
    removedDate?: string | null;
    meter: {
      id: string;
      meterNumber: string;
      meterType: string;
      status: string;
      commodity?: { name: string };
      uom?: { code: string };
    };
  }>;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  createdAt: string;
}

interface RateSchedule {
  id: string;
  name: string;
  code: string;
}

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
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

const inputStyle = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["INACTIVE", "CLOSED"],
  INACTIVE: ["ACTIVE", "CLOSED"],
};

export default function ServiceAgreementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const [sa, setSa] = useState<ServiceAgreement | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [transitioning, setTransitioning] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [rateSchedules, setRateSchedules] = useState<RateSchedule[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);
  const [showAddMeter, setShowAddMeter] = useState(false);

  const loadSA = async () => {
    try {
      const data = await apiClient.get<ServiceAgreement>(`/api/v1/service-agreements/${id}`);
      setSa(data);
      return data;
    } catch (err) {
      console.error("Failed to load SA", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSA();
  }, [id]);

  useEffect(() => {
    if (activeTab === "audit") {
      apiClient
        .get<{ data: AuditEntry[] }>("/api/v1/audit-log", {
          entityType: "ServiceAgreement",
          entityId: id,
        })
        .then((res) => setAudit(res.data ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  const handleTransition = async (newStatus: string) => {
    if (!sa) return;
    setTransitioning(true);
    try {
      await apiClient.patch(`/api/v1/service-agreements/${id}`, { status: newStatus });
      await loadSA();
    } catch (err) {
      console.error("Transition failed", err);
    } finally {
      setTransitioning(false);
    }
  };

  const handleEdit = async () => {
    if (!sa) return;
    setEditForm({
      rateScheduleId: sa.rateScheduleId ?? sa.rateSchedule?.id ?? "",
      billingCycleId: sa.billingCycleId ?? sa.billingCycle?.id ?? "",
      endDate: sa.endDate ? sa.endDate.slice(0, 10) : "",
      readSequence: sa.readSequence != null ? String(sa.readSequence) : "",
    });
    // Fetch dropdowns
    try {
      const [rsRes, bcRes] = await Promise.all([
        apiClient.get<{ data: RateSchedule[] }>("/api/v1/rate-schedules", { limit: "200" }),
        apiClient.get<{ data: BillingCycle[] }>("/api/v1/billing-cycles"),
      ]);
      setRateSchedules(rsRes.data ?? []);
      setBillingCycles(bcRes.data ?? []);
    } catch (err) {
      console.error("Failed to load dropdowns", err);
    }
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
  };

  const handleSave = async () => {
    if (!sa) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      const currentRsId = sa.rateScheduleId ?? sa.rateSchedule?.id ?? "";
      const currentBcId = sa.billingCycleId ?? sa.billingCycle?.id ?? "";
      if (editForm.rateScheduleId !== currentRsId) changes.rateScheduleId = editForm.rateScheduleId || null;
      if (editForm.billingCycleId !== currentBcId) changes.billingCycleId = editForm.billingCycleId || null;
      const endVal = editForm.endDate || null;
      const currentEnd = sa.endDate ? sa.endDate.slice(0, 10) : null;
      if (endVal !== currentEnd) changes.endDate = endVal;
      const readSeqVal = editForm.readSequence !== "" ? parseInt(editForm.readSequence, 10) : null;
      if (readSeqVal !== (sa.readSequence ?? null)) changes.readSequence = readSeqVal;

      await apiClient.patch(`/api/v1/service-agreements/${id}`, changes);
      await loadSA();
      setEditing(false);
      toast("Service agreement updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save service agreement", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }
  if (!sa) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Agreement not found.</div>;
  }

  const availableTransitions = STATUS_TRANSITIONS[sa.status] ?? [];

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
          <h1
            style={{
              fontSize: "22px",
              fontWeight: "600",
              color: "var(--text-primary)",
              margin: "0 0 4px",
            }}
          >
            {sa.agreementNumber}
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: 0 }}>
            {sa.account?.accountNumber} — {sa.premise?.addressLine1}
          </p>
        </div>
        {availableTransitions.length > 0 && (
          <div style={{ display: "flex", gap: "8px" }}>
            {availableTransitions.map((nextStatus) => (
              <button
                key={nextStatus}
                onClick={() => handleTransition(nextStatus)}
                disabled={transitioning}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--accent-primary)",
                  background: nextStatus === "ACTIVE" ? "var(--accent-primary)" : "transparent",
                  color: nextStatus === "ACTIVE" ? "#fff" : "var(--accent-primary)",
                  fontSize: "12px",
                  fontWeight: "500",
                  cursor: transitioning ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  opacity: transitioning ? 0.6 : 1,
                }}
              >
                {nextStatus === "ACTIVE" ? "Activate" : nextStatus === "CLOSED" ? "Close" : nextStatus}
              </button>
            ))}
          </div>
        )}
      </div>

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "meters", label: `Meters (${sa.meters?.length ?? 0})` },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setShowAddMeter(false); }}
        action={
          activeTab === "meters" && !showAddMeter ? (
            <button
              onClick={() => setShowAddMeter(true)}
              style={{
                padding: "5px 12px",
                fontSize: "12px",
                fontWeight: 500,
                background: "var(--accent-primary)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius, 10px)",
                cursor: "pointer",
                fontFamily: "inherit",
                marginBottom: "2px",
              }}
            >
              + Add Meter
            </button>
          ) : undefined
        }
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
            {/* Edit / Save / Cancel buttons */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "12px", gap: "8px" }}>
              {editing ? (
                <>
                  <button
                    onClick={handleCancel}
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    style={{ padding: "6px 14px", fontSize: "12px", background: "var(--accent-primary)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: saving ? 0.7 : 1 }}
                  >
                    {saving ? "Saving..." : "Save"}
                  </button>
                </>
              ) : (
                <button
                  onClick={handleEdit}
                  style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                >
                  Edit
                </button>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              <StatusBadge status={sa.status} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Agreement Number</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{sa.agreementNumber}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Account</span>
              <button
                onClick={() => sa.account && router.push(`/accounts/${sa.account.id}`)}
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
                {sa.account?.accountNumber ?? "—"}
              </button>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Premise</span>
              <button
                onClick={() => sa.premise && router.push(`/premises/${sa.premise.id}`)}
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
                {sa.premise
                  ? `${sa.premise.addressLine1}, ${sa.premise.city}, ${sa.premise.state}`
                  : "—"}
              </button>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Commodity</span>
              <CommodityBadge commodity={sa.commodity?.name ?? ""} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Rate Schedule</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.rateScheduleId}
                  onChange={(e) => setEditForm((f) => ({ ...f, rateScheduleId: e.target.value }))}
                >
                  <option value="">None</option>
                  {rateSchedules.map((rs) => (
                    <option key={rs.id} value={rs.id}>{rs.name} ({rs.code})</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>
                  {sa.rateSchedule ? `${sa.rateSchedule.name} (${sa.rateSchedule.code})` : "—"}
                </span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Billing Cycle</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.billingCycleId}
                  onChange={(e) => setEditForm((f) => ({ ...f, billingCycleId: e.target.value }))}
                >
                  <option value="">None</option>
                  {billingCycles.map((bc) => (
                    <option key={bc.id} value={bc.id}>{bc.name} ({bc.cycleCode})</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>
                  {sa.billingCycle ? `${sa.billingCycle.name} (${sa.billingCycle.cycleCode})` : "—"}
                </span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Start Date</span>
              <span style={valueStyle}>{sa.startDate?.slice(0, 10) ?? "—"}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>End Date</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="date"
                  value={editForm.endDate}
                  onChange={(e) => setEditForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{sa.endDate?.slice(0, 10) ?? "Open-ended"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Read Sequence</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  min="0"
                  value={editForm.readSequence}
                  onChange={(e) => setEditForm((f) => ({ ...f, readSequence: e.target.value }))}
                  placeholder="Optional"
                />
              ) : (
                <span style={valueStyle}>{sa.readSequence != null ? sa.readSequence : "—"}</span>
              )}
            </div>
            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Agreement ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {sa.id}
              </span>
            </div>
          </div>
        )}

        {activeTab === "meters" && (
          <MeterManagementTab
            agreementId={sa.id}
            premiseId={sa.premise?.id ?? sa.premiseId ?? ""}
            commodityId={sa.commodityId ?? ""}
            meters={(sa.meters ?? []) as any}
            onMetersChanged={loadSA}
            showForm={showAddMeter}
            onShowFormChange={setShowAddMeter}
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
