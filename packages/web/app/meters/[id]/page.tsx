"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import type { FieldDefinition } from "@utility-cis/shared";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/ui/status-badge";
import { CommodityBadge } from "@/components/ui/commodity-badge";
import { DataTable } from "@/components/ui/data-table";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { DatePicker } from "@/components/ui/date-picker";
import { AttachmentsTab } from "@/components/ui/attachments-tab";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { HistoryTimeline, type HistoryEvent } from "@/components/effective-dating/history-timeline";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Meter {
  id: string;
  meterNumber: string;
  meterType: string;
  status: string;
  multiplier?: number;
  installDate?: string;
  removalDate?: string;
  notes?: string;
  customFields?: Record<string, unknown>;
  premise?: { id: string; addressLine1: string; city: string; state: string };
  commodity?: { id: string; name: string };
  uom?: { id: string; name: string; code: string };
  serviceAgreementMeters?: Array<{
    id: string;
    isPrimary: boolean;
    serviceAgreement: {
      id: string;
      agreementNumber: string;
      status: string;
      startDate: string;
    };
  }>;
}

const METER_TYPES = ["AMI", "AMR", "MANUAL", "SMART", "OTHER"];
const METER_STATUSES = ["ACTIVE", "INACTIVE", "REMOVED", "FAULTY"];

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
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

export default function MeterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("meters");
  const [meter, setMeter] = useState<Meter | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editCustomFields, setEditCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldSchema, setCustomFieldSchema] = useState<FieldDefinition[]>([]);
  const [saving, setSaving] = useState(false);
  const [uoms, setUoms] = useState<Array<{ id: string; code: string; name: string; commodityId: string }>>([]);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [history, setHistory] = useState<Array<{
    id: string;
    isPrimary: boolean;
    addedDate: string;
    removedDate: string | null;
    serviceAgreement: {
      id: string;
      agreementNumber: string;
      status: string;
      account?: { id: string; accountNumber: string } | null;
      premise?: { id: string; addressLine1: string } | null;
    };
  }>>([]);

  const loadMeter = async () => {
    try {
      const data = await apiClient.get<Meter>(`/api/v1/meters/${id}`);
      setMeter(data);
      return data;
    } catch (err) {
      console.error("Failed to load meter", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMeter();
  }, [id]);

  // Tenant custom-field schema for meters.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/meter",
        );
        setCustomFieldSchema(res.fields ?? []);
      } catch (err) {
        console.error("[meters/detail] failed to load custom field schema", err);
        setCustomFieldSchema([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (activeTab === "history") {
      apiClient
        .get<typeof history>(`/api/v1/meters/${id}/assignment-history`)
        .then((res) => setHistory(res ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  const handleEdit = async () => {
    if (!meter) return;
    setEditForm({
      meterType: meter.meterType ?? "",
      status: meter.status ?? "",
      multiplier: meter.multiplier != null ? String(meter.multiplier) : "1",
      notes: meter.notes ?? "",
      installDate: meter.installDate ? meter.installDate.slice(0, 10) : "",
      removalDate: meter.removalDate ? meter.removalDate.slice(0, 10) : "",
      uomId: meter.uom?.id ?? "",
    });
    // Fetch UOMs filtered by this meter's commodity
    try {
      const res = await apiClient.get<Array<{ id: string; code: string; name: string; commodityId: string }> | { data: Array<{ id: string; code: string; name: string; commodityId: string }> }>("/api/v1/uom", meter.commodity?.id ? { commodityId: meter.commodity.id } : undefined);
      setUoms(Array.isArray(res) ? res : res.data ?? []);
    } catch (err) {
      console.error("Failed to fetch UOMs", err);
    }
    setEditCustomFields({ ...(meter.customFields ?? {}) });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
    setEditCustomFields({});
  };

  const handleRemove = async () => {
    if (!meter) return;
    setRemoving(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await apiClient.patch(`/api/v1/meters/${id}`, { status: "REMOVED", removalDate: today });
      await loadMeter();
      setShowRemoveConfirm(false);
      toast("Meter removed successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to remove meter", "error");
    } finally {
      setRemoving(false);
    }
  };

  const handleSave = async () => {
    if (!meter) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.meterType !== meter.meterType) changes.meterType = editForm.meterType;
      if (editForm.status !== meter.status) changes.status = editForm.status;
      const multVal = editForm.multiplier !== "" ? parseFloat(editForm.multiplier) : 1;
      if (multVal !== (meter.multiplier ?? 1)) changes.multiplier = multVal;
      if (editForm.notes !== (meter.notes ?? "")) changes.notes = editForm.notes || null;
      if (editForm.uomId !== (meter.uom?.id ?? "") && editForm.uomId) changes.uomId = editForm.uomId;
      const installVal = editForm.installDate || null;
      const currentInstall = meter.installDate ? meter.installDate.slice(0, 10) : null;
      if (installVal !== currentInstall) changes.installDate = installVal;
      const removalVal = editForm.removalDate || null;
      const currentRemoval = meter.removalDate ? meter.removalDate.slice(0, 10) : null;
      if (removalVal !== currentRemoval) changes.removalDate = removalVal;

      // Custom fields: include only when they actually changed.
      const storedCustomJson = JSON.stringify(meter.customFields ?? {});
      const editedCustomJson = JSON.stringify(editCustomFields ?? {});
      if (storedCustomJson !== editedCustomJson) {
        changes.customFields = editCustomFields;
      }

      await apiClient.patch(`/api/v1/meters/${id}`, changes);
      await loadMeter();
      setEditing(false);
      toast("Meter updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save meter", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Loading...</div>;
  }
  if (!canView) return <AccessDenied />;
  if (!meter) {
    return <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>Meter not found.</div>;
  }

  return (
    <div>
      <PageHeader
        title={meter.meterNumber}
        subtitle={meter.premise ? `${meter.premise.addressLine1}, ${meter.premise.city}` : "No premise"}
        actions={
          canDelete && meter.status === "ACTIVE" ? (
            <button
              onClick={() => setShowRemoveConfirm(true)}
              disabled={removing}
              title="BR-MT-005: Meters cannot be deleted, only removed. History is retained."
              style={{
                padding: "7px 16px",
                fontSize: "12px",
                fontWeight: 500,
                background: "transparent",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius)",
                color: "var(--danger)",
                cursor: removing ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                opacity: removing ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              Remove Meter
            </button>
          ) : undefined
        }
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "agreements", label: `Agreements (${meter.serviceAgreementMeters?.length ?? 0})` },
          { key: "history", label: "History" },
          { key: "attachments", label: "Attachments" },
        ]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setShowUpload(false); }}
        action={
          activeTab === "attachments" && !showUpload ? (
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
            {/* Edit / Save / Cancel buttons. Remove Meter is in the
                page header so it's available regardless of which tab
                is active and visually grouped with other entity-level
                lifecycle actions. */}
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
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                >
                  {METER_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={meter.status} />
              )}
            </div>
            {meter.premise && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Premise</span>
                <button
                  onClick={() => router.push(`/premises/${meter.premise!.id}`)}
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
                  {meter.premise.addressLine1}, {meter.premise.city}, {meter.premise.state}
                </button>
              </div>
            )}
            <div style={fieldStyle}>
              <span style={labelStyle}>Meter Number</span>
              <span style={{ ...valueStyle, fontFamily: "monospace" }}>{meter.meterNumber}</span>
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Meter Type</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.meterType}
                  onChange={(e) => setEditForm((f) => ({ ...f, meterType: e.target.value }))}
                >
                  {METER_TYPES.map((t) => (
                    <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{meter.meterType}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Commodity</span>
              <CommodityBadge commodity={meter.commodity?.name ?? ""} />
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Unit of Measure</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.uomId}
                  onChange={(e) => setEditForm((f) => ({ ...f, uomId: e.target.value }))}
                >
                  {uoms.map((u) => (
                    <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>
                  {meter.uom ? `${meter.uom.name} (${meter.uom.code})` : "—"}
                </span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Multiplier</span>
              {editing ? (
                <input
                  style={inputStyle}
                  type="number"
                  step="any"
                  min="0"
                  value={editForm.multiplier}
                  onChange={(e) => setEditForm((f) => ({ ...f, multiplier: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{meter.multiplier ?? 1}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Install Date</span>
              {editing ? (
                <DatePicker
                  value={editForm.installDate}
                  onChange={(v) => setEditForm((f) => ({ ...f, installDate: v }))}
                  placeholder="Select install date..."
                />
              ) : (
                <span style={valueStyle}>{meter.installDate ? meter.installDate.slice(0, 10) : "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Removal Date</span>
              {editing ? (
                <DatePicker
                  value={editForm.removalDate}
                  onChange={(v) => setEditForm((f) => ({ ...f, removalDate: v }))}
                  placeholder="Not removed"
                />
              ) : (
                <span style={valueStyle}>{meter.removalDate ? meter.removalDate.slice(0, 10) : "—"}</span>
              )}
            </div>
            <div style={fieldStyle}>
              <span style={labelStyle}>Notes</span>
              {editing ? (
                <textarea
                  style={{ ...inputStyle, minHeight: "70px", resize: "vertical" as const }}
                  value={editForm.notes}
                  onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Optional notes"
                />
              ) : (
                <span style={valueStyle}>{meter.notes || "—"}</span>
              )}
            </div>

            {/* Tenant-configurable custom fields. */}
            {(() => {
              const stored = meter.customFields ?? {};
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
              <span style={labelStyle}>Meter ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {meter.id}
              </span>
            </div>
          </div>
        )}

        {showRemoveConfirm && (
          <ConfirmDialog
            title="Remove meter"
            message={`Mark meter ${meter.meterNumber} as removed. The meter is not deleted — its history is retained, and any open service-agreement assignments must be removed separately. This action sets the removal date to today.`}
            confirmLabel={removing ? "Processing…" : "Remove Meter"}
            cancelLabel="Cancel"
            confirmDisabled={removing}
            destructive
            onConfirm={handleRemove}
            onCancel={() => !removing && setShowRemoveConfirm(false)}
          />
        )}

        {activeTab === "agreements" && (
          <DataTable
            columns={[
              { key: "agreementNumber", header: "Agreement Number", render: (row: any) => row.serviceAgreement.agreementNumber },
              { key: "isPrimary", header: "Primary", render: (row: any) => row.isPrimary ? "Yes" : "No" },
              { key: "startDate", header: "Start Date", render: (row: any) => row.serviceAgreement.startDate?.slice(0, 10) ?? "—" },
              { key: "status", header: "Status", render: (row: any) => <StatusBadge status={row.serviceAgreement.status} /> },
            ]}
            data={(meter.serviceAgreementMeters ?? []) as any}
            onRowClick={(row: any) => router.push(`/service-agreements/${row.serviceAgreement.id}`)}
          />
        )}

        {activeTab === "history" && (
          <HistoryTimeline
            events={history.map<HistoryEvent>((row) => ({
              id: row.id,
              label: row.serviceAgreement.agreementNumber,
              sublabel: [
                row.serviceAgreement.premise?.addressLine1,
                row.serviceAgreement.account?.accountNumber
                  ? `Account ${row.serviceAgreement.account.accountNumber}`
                  : null,
                row.isPrimary ? "Primary" : null,
              ]
                .filter(Boolean)
                .join(" · "),
              startDate: row.addedDate.slice(0, 10),
              endDate: row.removedDate ? row.removedDate.slice(0, 10) : null,
              status: row.serviceAgreement.status,
              href: `/service-agreements/${row.serviceAgreement.id}`,
            }))}
            emptyMessage="This meter has not been assigned to any service agreement yet."
          />
        )}

        {activeTab === "attachments" && (
          <AttachmentsTab entityType="Meter" entityId={id} showForm={showUpload} onShowFormChange={setShowUpload} />
        )}
      </Tabs>
    </div>
  );
}
