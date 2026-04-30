"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import type { FieldDefinition } from "@utility-cis/shared";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { DatePicker } from "@/components/ui/date-picker";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { MeterManagementTab } from "@/components/service-agreements/meters-tab";
import { AgreementBillingTab } from "@/components/billing/agreement-billing-tab";
import { AttachmentsTab } from "@/components/ui/attachments-tab";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface ServiceAgreement {
  id: string;
  agreementNumber: string;
  status: string;
  startDate: string;
  endDate?: string;
  readSequence?: number;
  customFields?: Record<string, unknown>;
  account?: { id: string; accountNumber: string };
  servicePoints?: Array<{
    id: string;
    premise: {
      id: string;
      addressLine1: string;
      city: string;
      state: string;
    };
  }>;
  commodity?: { name: string };
  rateSchedule?: { id: string; name: string; code: string };
  billingCycle?: { id: string; name: string; cycleCode: string };
  rateScheduleId?: string;
  billingCycleId?: string;
  commodityId?: string;
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
  actorName?: string;
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

// BR-SA-006: PENDING → ACTIVE → FINAL → CLOSED (no skipping)
const STATUS_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["ACTIVE"],
  ACTIVE: ["FINAL"],
  FINAL: ["CLOSED"],
};

export default function ServiceAgreementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("agreements");
  const { canEdit: canEditMeter } = usePermission("meters");
  const [sa, setSa] = useState<ServiceAgreement | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [transitioning, setTransitioning] = useState(false);
  const [stopDialog, setStopDialog] = useState<{ endDate: string } | null>(null);
  const [closeBillDialog, setCloseBillDialog] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editCustomFields, setEditCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldSchema, setCustomFieldSchema] = useState<FieldDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [rateSchedules, setRateSchedules] = useState<RateSchedule[]>([]);
  const [billingCycles, setBillingCycles] = useState<BillingCycle[]>([]);
  const [showAddMeter, setShowAddMeter] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

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

  // Load tenant custom-field schema for service agreements.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/service_agreement",
        );
        setCustomFieldSchema(res.fields ?? []);
      } catch (err) {
        console.error("[service-agreements/detail] failed to load schema", err);
        setCustomFieldSchema([]);
      }
    })();
  }, []);

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
    if (newStatus === "ACTIVE") {
      setTransitioning(true);
      try {
        await apiClient.post(`/api/v1/service-agreements/${id}/activate`, {});
        await loadSA();
        toast("Service activated", "success");
      } catch (err: any) {
        toast(err?.message ?? "Activation failed", "error");
      } finally {
        setTransitioning(false);
      }
      return;
    }
    if (newStatus === "FINAL") {
      // Open the Stop Service dialog; the dialog handles the actual close.
      setStopDialog({ endDate: new Date().toISOString().slice(0, 10) });
      return;
    }
    if (newStatus === "CLOSED") {
      // Open the Issue Final Bill dialog. No date input — re-uses the
      // existing endDate that was set at FINAL.
      setCloseBillDialog(true);
      return;
    }
  };

  const confirmStopService = async () => {
    if (!sa || !stopDialog) return;
    setTransitioning(true);
    try {
      await apiClient.post(`/api/v1/service-agreements/${id}/close`, {
        endDate: stopDialog.endDate,
        status: "FINAL",
      });
      await loadSA();
      toast("Service stopped", "success");
      setStopDialog(null);
    } catch (err: any) {
      toast(err?.message ?? "Stop service failed", "error");
    } finally {
      setTransitioning(false);
    }
  };

  const confirmIssueFinalBill = async () => {
    if (!sa) return;
    if (!sa.endDate) {
      toast("Cannot close: end date is missing", "error");
      return;
    }
    setTransitioning(true);
    try {
      await apiClient.post(`/api/v1/service-agreements/${id}/close`, {
        endDate: sa.endDate.slice(0, 10),
        status: "CLOSED",
      });
      await loadSA();
      toast("Final bill issued; agreement closed", "success");
      setCloseBillDialog(false);
    } catch (err: any) {
      toast(err?.message ?? "Close failed", "error");
    } finally {
      setTransitioning(false);
    }
  };

  const handleEdit = async () => {
    if (!sa) return;
    setEditForm({
      rateScheduleId: sa.rateScheduleId ?? sa.rateSchedule?.id ?? "",
      billingCycleId: sa.billingCycleId ?? sa.billingCycle?.id ?? "",
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
    setEditCustomFields({ ...(sa.customFields ?? {}) });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
    setEditCustomFields({});
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
      // endDate is no longer settable via PATCH — it's set via the
      // close endpoint, which also cascades onto meter assignments.
      const readSeqVal = editForm.readSequence !== "" ? parseInt(editForm.readSequence, 10) : null;
      if (readSeqVal !== (sa.readSequence ?? null)) changes.readSequence = readSeqVal;

      // Custom fields: include only when they actually changed.
      const storedCustomJson = JSON.stringify(sa.customFields ?? {});
      const editedCustomJson = JSON.stringify(editCustomFields ?? {});
      if (storedCustomJson !== editedCustomJson) {
        changes.customFields = editCustomFields;
      }

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
  if (!canView) return <AccessDenied />;
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
            {sa.account?.accountNumber} — {sa.servicePoints?.[0]?.premise?.addressLine1 ?? "—"}
          </p>
        </div>
        {canEdit && availableTransitions.length > 0 && (
          <div style={{ display: "flex", gap: "8px" }}>
            {availableTransitions.map((nextStatus) => {
              // Activate is a positive action (filled accent); Stop
              // Service and Issue Final Bill are destructive
              // (outlined red) to match Remove Meter on the meter
              // detail page. Same colour, same prominence, same risk
              // signal across entities.
              const isDestructive = nextStatus === "FINAL" || nextStatus === "CLOSED";
              return (
                <button
                  key={nextStatus}
                  onClick={() => handleTransition(nextStatus)}
                  disabled={transitioning}
                  style={{
                    padding: "7px 16px",
                    borderRadius: "var(--radius)",
                    border: isDestructive
                      ? "1px solid var(--danger)"
                      : "1px solid var(--accent-primary)",
                    background: nextStatus === "ACTIVE" ? "var(--accent-primary)" : "transparent",
                    color: isDestructive
                      ? "var(--danger)"
                      : nextStatus === "ACTIVE"
                        ? "#fff"
                        : "var(--accent-primary)",
                    fontSize: "12px",
                    fontWeight: 500,
                    cursor: transitioning ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                    opacity: transitioning ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  {nextStatus === "ACTIVE"
                    ? "Activate"
                    : nextStatus === "FINAL"
                      ? "Stop Service"
                      : nextStatus === "CLOSED"
                        ? "Issue Final Bill"
                        : nextStatus}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "meters", label: `Meters (${sa.meters?.length ?? 0})` },
          { key: "billing", label: "Billing" },
          { key: "attachments", label: "Attachments" },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setShowAddMeter(false); setShowUpload(false); }}
        action={
          activeTab === "meters" && !showAddMeter && canEditMeter ? (
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
          ) : activeTab === "attachments" && !showUpload ? (
            <button
              onClick={() => setShowUpload(true)}
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
              + Upload
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
              ) : canEdit ? (
                <button
                  onClick={handleEdit}
                  style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}
                >
                  Edit
                </button>
              ) : null}
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
                  textAlign: "left",
                }}
              >
                {sa.account?.accountNumber ?? "—"}
              </button>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Premise</span>
              <button
                onClick={() => {
                  const sp = sa.servicePoints?.[0];
                  if (sp?.premise) router.push(`/premises/${sp.premise.id}`);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--accent-primary)",
                  fontSize: "13px",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                  fontFamily: "inherit",
                  textAlign: "left",
                }}
              >
                {(() => {
                  const p = sa.servicePoints?.[0]?.premise;
                  return p ? `${p.addressLine1}, ${p.city}, ${p.state}` : "—";
                })()}
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
              <span style={valueStyle}>
                {sa.endDate?.slice(0, 10) ?? "Open-ended"}
                {editing && (
                  <span style={{ marginLeft: "8px", fontSize: "11px", color: "var(--text-muted)" }}>
                    (set via Close action)
                  </span>
                )}
              </span>
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

            {/* Tenant-configurable custom fields. */}
            {(() => {
              const stored = sa.customFields ?? {};
              const hasSchema = customFieldSchema.length > 0;
              const hasStoredValues = Object.keys(stored).length > 0;
              if (!hasSchema && !hasStoredValues) return null;

              if (editing) {
                return (
                  <>
                    <div style={{ fontSize: "11px", fontWeight: "600", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: "20px", marginBottom: "4px" }}>
                      Custom Fields
                    </div>
                    <CustomFieldsSection
                      schema={customFieldSchema}
                      values={editCustomFields}
                      onChange={setEditCustomFields}
                      fieldStyle={fieldStyle}
                      labelStyle={labelStyle}
                      hideHeader
                    />
                  </>
                );
              }

              const activeFields = customFieldSchema.filter((f) => !f.deprecated);
              const deprecatedWithValue = customFieldSchema.filter(
                (f) => f.deprecated && stored[f.key] !== undefined && stored[f.key] !== null,
              );
              activeFields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
              deprecatedWithValue.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));

              const renderValue = (field: typeof activeFields[number]) => {
                const v = stored[field.key];
                if (v === undefined || v === null || v === "") return "—";
                if (field.type === "boolean") return v ? "Yes" : "No";
                if (field.type === "enum") {
                  const match = field.enumOptions?.find((o) => o.value === v);
                  return match?.label ?? String(v);
                }
                return String(v);
              };

              return (
                <>
                  <div style={{ fontSize: "11px", fontWeight: "600", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: "20px", marginBottom: "4px" }}>
                    Custom Fields
                  </div>
                  {activeFields.map((field) => (
                    <div key={field.key} style={fieldStyle}>
                      <span style={labelStyle}>{field.label}</span>
                      <span style={valueStyle}>{renderValue(field)}</span>
                    </div>
                  ))}
                  {deprecatedWithValue.map((field) => (
                    <div key={field.key} style={{ ...fieldStyle, opacity: 0.6 }}>
                      <span style={labelStyle}>
                        {field.label}
                        <span style={{ fontSize: 9, color: "var(--danger)", marginLeft: 6, letterSpacing: "0.06em", textTransform: "uppercase" }}>deprecated</span>
                      </span>
                      <span style={valueStyle}>{renderValue(field)}</span>
                    </div>
                  ))}
                </>
              );
            })()}

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
            premiseId={sa.servicePoints?.[0]?.premise?.id ?? ""}
            commodityId={sa.commodityId ?? ""}
            meters={(sa.meters ?? []) as any}
            onMetersChanged={loadSA}
            showForm={showAddMeter}
            onShowFormChange={setShowAddMeter}
          />
        )}

        {activeTab === "billing" && <AgreementBillingTab agreementId={sa.id} />}

        {activeTab === "attachments" && (
          <AttachmentsTab entityType="ServiceAgreement" entityId={id} showForm={showUpload} onShowFormChange={setShowUpload} />
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

      {stopDialog && sa && (
        <ConfirmDialog
          title="Stop service"
          message={`This will close service agreement ${sa.agreementNumber} and remove all ${
            sa.meters?.filter((m: any) => !m.removedDate).length ?? 0
          } currently-assigned meters as of the end date below. The action emits an audit row for each row affected and cannot be undone via Edit. Issuing the final bill is a separate step.`}
          confirmLabel={transitioning ? "Stopping…" : "Stop Service"}
          cancelLabel="Cancel"
          confirmDisabled={transitioning || !stopDialog.endDate}
          destructive
          onConfirm={confirmStopService}
          onCancel={() => !transitioning && setStopDialog(null)}
        >
          <label
            style={{
              display: "block",
              fontSize: "12px",
              color: "var(--text-muted)",
              marginBottom: "6px",
              fontWeight: 500,
            }}
          >
            Service end date
          </label>
          <DatePicker
            value={stopDialog.endDate}
            onChange={(v) => setStopDialog({ endDate: v })}
          />
        </ConfirmDialog>
      )}

      {closeBillDialog && sa && (
        <ConfirmDialog
          title="Issue final bill"
          message={`Mark service agreement ${sa.agreementNumber} as CLOSED. The end date (${
            sa.endDate?.slice(0, 10) ?? "—"
          }) was set when the service was stopped and will not change. Once closed, the agreement is permanently terminal.`}
          confirmLabel={transitioning ? "Closing…" : "Issue Final Bill"}
          cancelLabel="Cancel"
          confirmDisabled={transitioning}
          destructive
          onConfirm={confirmIssueFinalBill}
          onCancel={() => !transitioning && setCloseBillDialog(false)}
        />
      )}
    </div>
  );
}
