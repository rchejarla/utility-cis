"use client";

import { useState, useEffect, use } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface BillingCycle {
  id: string;
  name: string;
  cycleCode: string;
  readDayOfMonth: number;
  billDayOfMonth: number;
  frequency: string;
  active: boolean;
}

const FREQUENCIES = ["MONTHLY", "BIMONTHLY", "QUARTERLY", "ANNUAL"];

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

export default function BillingCycleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { toast } = useToast();
  const [cycle, setCycle] = useState<BillingCycle | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string | boolean>>({});
  const [saving, setSaving] = useState(false);

  const loadCycle = async () => {
    try {
      const data = await apiClient.get<BillingCycle>(`/api/v1/billing-cycles/${id}`);
      setCycle(data);
      return data;
    } catch (err) {
      console.error("Failed to load billing cycle", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCycle();
  }, [id]);

  const handleEdit = () => {
    if (!cycle) return;
    setEditForm({
      name: cycle.name ?? "",
      readDayOfMonth: String(cycle.readDayOfMonth),
      billDayOfMonth: String(cycle.billDayOfMonth),
      frequency: cycle.frequency ?? "",
      active: cycle.active,
    });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
  };

  const handleSave = async () => {
    if (!cycle) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.name !== cycle.name) changes.name = editForm.name;
      const readDay = parseInt(editForm.readDayOfMonth as string, 10);
      if (readDay !== cycle.readDayOfMonth) changes.readDayOfMonth = readDay;
      const billDay = parseInt(editForm.billDayOfMonth as string, 10);
      if (billDay !== cycle.billDayOfMonth) changes.billDayOfMonth = billDay;
      if (editForm.frequency !== cycle.frequency) changes.frequency = editForm.frequency;
      if (editForm.active !== cycle.active) changes.active = editForm.active;

      await apiClient.patch(`/api/v1/billing-cycles/${id}`, changes);
      await loadCycle();
      setEditing(false);
      toast("Billing cycle updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save billing cycle", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Loading...</div>;
  }
  if (!cycle) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Billing cycle not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={cycle.name}
        subtitle={`Cycle Code: ${cycle.cycleCode}`}
      />

      <Tabs
        tabs={[{ key: "overview", label: "Overview" }]}
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
              {editing ? (
                <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={editForm.active as boolean}
                    onChange={(e) => setEditForm((f) => ({ ...f, active: e.target.checked }))}
                  />
                  Active
                </label>
              ) : (
                <StatusBadge status={cycle.active ? "ACTIVE" : "INACTIVE"} />
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Name</span>
              {editing ? (
                <input
                  style={inputStyle}
                  value={editForm.name as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.name}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Cycle Code</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{cycle.cycleCode}</span>
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Read Day of Month</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  max="31"
                  value={editForm.readDayOfMonth as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, readDayOfMonth: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.readDayOfMonth}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Bill Day of Month</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  min="1"
                  max="31"
                  value={editForm.billDayOfMonth as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, billDayOfMonth: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{cycle.billDayOfMonth}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Frequency</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.frequency as string}
                  onChange={(e) => setEditForm((f) => ({ ...f, frequency: e.target.value }))}
                >
                  {FREQUENCIES.map((freq) => (
                    <option key={freq} value={freq}>{freq.charAt(0) + freq.slice(1).toLowerCase()}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{cycle.frequency}</span>
              )}
            </div>

            <div style={{ ...fieldStyle, borderBottom: "none" }}>
              <span style={labelStyle}>Cycle ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {cycle.id}
              </span>
            </div>
          </div>
        )}
      </Tabs>
    </div>
  );
}
