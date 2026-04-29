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
import { MetersTab } from "@/components/premises/meters-tab";
import { AgreementsTab } from "@/components/premises/agreements-tab";
import { AttachmentsTab } from "@/components/ui/attachments-tab";
import { HistoryTimeline, type HistoryEvent } from "@/components/effective-dating/history-timeline";
import { CustomFieldsSection } from "@/components/ui/custom-fields-section";
import { usePermission } from "@/lib/use-permission";
import { usePremiseTypes } from "@/lib/use-type-defs";
import { AccessDenied } from "@/components/ui/access-denied";

interface Premise {
  id: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  premiseType: string;
  status: string;
  geoLat?: number;
  geoLng?: number;
  serviceTerritoryId?: string;
  municipalityCode?: string;
  commodityIds?: string[];
  ownerId?: string;
  customFields?: Record<string, unknown>;
  owner?: {
    id: string;
    customerType: string;
    firstName?: string;
    lastName?: string;
    organizationName?: string;
  };
  commodities?: Array<{ commodity: { id: string; name: string } }>;
  meters?: Array<{
    id: string;
    meterNumber: string;
    meterType: string;
    status: string;
    commodityId?: string;
    commodity?: { id: string; name: string };
  }>;
  serviceAgreements?: Array<{
    id: string;
    agreementNumber: string;
    status: string;
    startDate: string;
    endDate?: string | null;
    commodity?: { id: string; name: string };
    account?: { accountNumber: string };
  }>;
}

interface Customer {
  id: string;
  customerType: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
}

interface AuditEntry {
  id: string;
  action: string;
  actorId?: string;
  actorName?: string;
  createdAt: string;
  changes?: unknown;
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

const PREMISE_STATUSES = ["ACTIVE", "INACTIVE", "PENDING", "DEMOLISHED"];

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: "8px",
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};

const labelStyle = {
  fontSize: "12px",
  color: "var(--text-muted)",
  fontWeight: "500" as const,
};

const valueStyle = {
  fontSize: "13px",
  color: "var(--text-primary)",
};

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

export default function PremiseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { toast } = useToast();
  const { canView, canEdit, canDelete } = usePermission("premises");
  const { canCreate: canCreateMeter } = usePermission("meters");
  const { canCreate: canCreateAgreement } = usePermission("agreements");
  const { types: premiseTypes } = usePremiseTypes();
  const [premise, setPremise] = useState<Premise | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("overview");
  const [history, setHistory] = useState<Array<{
    id: string;
    agreementNumber: string;
    status: string;
    startDate: string;
    endDate: string | null;
    commodity?: { id: string; name: string } | null;
    account?: { id: string; accountNumber: string } | null;
  }>>([]);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editCustomFields, setEditCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldSchema, setCustomFieldSchema] = useState<FieldDefinition[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [saving, setSaving] = useState(false);
  const [showAddMeter, setShowAddMeter] = useState(false);
  const [showAddAgreement, setShowAddAgreement] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [editCommodityIds, setEditCommodityIds] = useState<string[]>([]);
  const [allCommodities, setAllCommodities] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [showDeactivateConfirm, setShowDeactivateConfirm] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const loadPremise = async () => {
    try {
      const data = await apiClient.get<Premise>(`/api/v1/premises/${id}`);
      setPremise(data);
      return data;
    } catch (err) {
      console.error("Failed to load premise", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPremise();
    // Fetch commodities for display (resolving IDs to names)
    apiClient
      .get<Array<{ id: string; code: string; name: string }> | { data: Array<{ id: string; code: string; name: string }> }>("/api/v1/commodities")
      .then((res) => setAllCommodities(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error);
  }, [id]);

  // Tenant custom-field schema for premises.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get<{ fields: FieldDefinition[] }>(
          "/api/v1/custom-fields/premise",
        );
        setCustomFieldSchema(res.fields ?? []);
      } catch (err) {
        console.error("[premises/detail] failed to load custom field schema", err);
        setCustomFieldSchema([]);
      }
    })();
  }, []);

  useEffect(() => {
    if (activeTab === "audit") {
      apiClient
        .get<{ data: AuditEntry[] }>("/api/v1/audit-log", {
          entityType: "Premise",
          entityId: id,
        })
        .then((res) => setAudit(res.data ?? []))
        .catch(console.error);
    }
    if (activeTab === "history") {
      apiClient
        .get<typeof history>(`/api/v1/premises/${id}/agreement-history`)
        .then((res) => setHistory(res ?? []))
        .catch(console.error);
    }
  }, [activeTab, id]);

  const handleEdit = async () => {
    if (!premise) return;
    setEditForm({
      addressLine1: premise.addressLine1 ?? "",
      addressLine2: premise.addressLine2 ?? "",
      city: premise.city ?? "",
      state: premise.state ?? "",
      zip: premise.zip ?? "",
      premiseType: premise.premiseType ?? "",
      municipalityCode: premise.municipalityCode ?? "",
      ownerId: premise.ownerId ?? "",
      status: premise.status ?? "",
    });
    // Fetch customers and commodities for dropdowns
    try {
      const [custRes, commRes] = await Promise.all([
        apiClient.get<{ data: Customer[] }>("/api/v1/customers", { limit: "500" }),
        apiClient.get<Array<{ id: string; code: string; name: string }> | { data: Array<{ id: string; code: string; name: string }> }>("/api/v1/commodities"),
      ]);
      setCustomers(custRes.data ?? []);
      const cList = Array.isArray(commRes) ? commRes : commRes.data ?? [];
      setAllCommodities(cList);
    } catch (err) {
      console.error("Failed to load dropdown data", err);
    }
    setEditCommodityIds(premise.commodityIds ?? []);
    setEditCustomFields({ ...(premise.customFields ?? {}) });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
    setEditForm({});
    setEditCustomFields({});
  };

  const handleDeactivate = async () => {
    if (!premise) return;
    setDeactivating(true);
    try {
      await apiClient.patch(`/api/v1/premises/${id}`, { status: "INACTIVE" });
      await loadPremise();
      setShowDeactivateConfirm(false);
      toast("Premise deactivated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to deactivate premise", "error");
    } finally {
      setDeactivating(false);
    }
  };

  const handleSave = async () => {
    if (!premise) return;
    setSaving(true);
    try {
      const changes: Record<string, unknown> = {};
      if (editForm.addressLine1 !== (premise.addressLine1 ?? "")) changes.addressLine1 = editForm.addressLine1;
      if (editForm.addressLine2 !== (premise.addressLine2 ?? "")) changes.addressLine2 = editForm.addressLine2;
      if (editForm.city !== (premise.city ?? "")) changes.city = editForm.city;
      if (editForm.state !== (premise.state ?? "")) changes.state = editForm.state;
      if (editForm.zip !== (premise.zip ?? "")) changes.zip = editForm.zip;
      if (editForm.premiseType !== (premise.premiseType ?? "")) changes.premiseType = editForm.premiseType;
      if (editForm.municipalityCode !== (premise.municipalityCode ?? "")) changes.municipalityCode = editForm.municipalityCode;
      if (editForm.ownerId !== (premise.ownerId ?? "")) changes.ownerId = editForm.ownerId || null;
      if (editForm.status !== (premise.status ?? "")) changes.status = editForm.status;
      // Check if commodityIds changed
      const origIds = (premise.commodityIds ?? []).slice().sort().join(",");
      const editIds = editCommodityIds.slice().sort().join(",");
      if (origIds !== editIds && editCommodityIds.length > 0) {
        changes.commodityIds = editCommodityIds;
      }

      // Custom fields: include only when they actually changed.
      const storedCustomJson = JSON.stringify(premise.customFields ?? {});
      const editedCustomJson = JSON.stringify(editCustomFields ?? {});
      if (storedCustomJson !== editedCustomJson) {
        changes.customFields = editCustomFields;
      }

      await apiClient.patch(`/api/v1/premises/${id}`, changes);
      await loadPremise();
      setEditing(false);
      toast("Premise updated successfully", "success");
    } catch (err: any) {
      toast(err.message || "Failed to save premise", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>
        Loading...
      </div>
    );
  }

  if (!canView) return <AccessDenied />;

  if (!premise) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: "14px", padding: "40px 0" }}>
        Premise not found.
      </div>
    );
  }

  const address = [premise.addressLine1, premise.addressLine2, premise.city, premise.state, premise.zip]
    .filter(Boolean)
    .join(", ");

  return (
    <div>
      <PageHeader
        title={premise.addressLine1}
        subtitle={`${premise.city}, ${premise.state} ${premise.zip}`}
      />

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "meters", label: `Meters (${premise.meters?.length ?? 0})` },
          { key: "agreements", label: `Agreements (${premise.serviceAgreements?.length ?? 0})` },
          { key: "history", label: "History" },
          { key: "attachments", label: "Attachments" },
          { key: "audit", label: "Audit" },
        ]}
        activeTab={activeTab}
        onTabChange={(t) => { setActiveTab(t); setShowAddMeter(false); setShowAddAgreement(false); setShowUpload(false); }}
        action={
          activeTab === "meters" && !showAddMeter && canCreateMeter ? (
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
          ) : activeTab === "agreements" && !showAddAgreement && canCreateAgreement ? (
            <button
              onClick={() => setShowAddAgreement(true)}
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
              + Add Agreement
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
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px", gap: "8px" }}>
              <div>
                {canDelete && !editing && premise.status === "ACTIVE" && (
                  <button
                    onClick={() => setShowDeactivateConfirm(true)}
                    title="BR-PR-004: Premises cannot be deleted, only deactivated."
                    style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--danger)", borderRadius: "var(--radius)", color: "var(--danger)", cursor: "pointer", fontFamily: "inherit" }}
                  >
                    Deactivate Premise
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
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
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Status</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.status}
                  onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}
                >
                  {PREMISE_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              ) : (
                <StatusBadge status={premise.status} />
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Property Owner</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.ownerId}
                  onChange={(e) => setEditForm((f) => ({ ...f, ownerId: e.target.value }))}
                >
                  <option value="">No owner assigned</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.customerType === "ORGANIZATION"
                        ? c.organizationName
                        : `${c.firstName} ${c.lastName}`}
                    </option>
                  ))}
                </select>
              ) : premise.owner ? (
                <button
                  onClick={() => router.push(`/customers/${premise.owner!.id}`)}
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
                  {premise.owner.customerType === "ORGANIZATION"
                    ? premise.owner.organizationName
                    : `${premise.owner.firstName} ${premise.owner.lastName}`}
                </button>
              ) : (
                <span style={{ ...valueStyle, color: "var(--text-muted)" }}>No owner assigned</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Address Line 1</span>
              {editing ? (
                <input
                  style={inputStyle}
                  value={editForm.addressLine1}
                  onChange={(e) => setEditForm((f) => ({ ...f, addressLine1: e.target.value }))}
                />
              ) : (
                <span style={valueStyle}>{address}</span>
              )}
            </div>

            {editing && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Address Line 2</span>
                <input
                  style={inputStyle}
                  value={editForm.addressLine2}
                  onChange={(e) => setEditForm((f) => ({ ...f, addressLine2: e.target.value }))}
                  placeholder="Apt / Suite (optional)"
                />
              </div>
            )}

            {editing && (
              <div style={fieldStyle}>
                <span style={labelStyle}>City</span>
                <input
                  style={inputStyle}
                  value={editForm.city}
                  onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                />
              </div>
            )}

            {editing && (
              <div style={fieldStyle}>
                <span style={labelStyle}>State</span>
                <select
                  style={inputStyle}
                  value={editForm.state}
                  onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))}
                >
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            )}

            {editing && (
              <div style={fieldStyle}>
                <span style={labelStyle}>ZIP Code</span>
                <input
                  style={inputStyle}
                  value={editForm.zip}
                  onChange={(e) => setEditForm((f) => ({ ...f, zip: e.target.value }))}
                />
              </div>
            )}

            <div style={fieldStyle}>
              <span style={labelStyle}>Premise Type</span>
              {editing ? (
                <select
                  style={inputStyle}
                  value={editForm.premiseType}
                  onChange={(e) => setEditForm((f) => ({ ...f, premiseType: e.target.value }))}
                >
                  {premiseTypes.map((t) => (
                    <option key={t.code} value={t.code}>{t.label}</option>
                  ))}
                </select>
              ) : (
                <span style={valueStyle}>{premise.premiseType}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Municipality Code</span>
              {editing ? (
                <input
                  style={inputStyle}
                  value={editForm.municipalityCode}
                  onChange={(e) => setEditForm((f) => ({ ...f, municipalityCode: e.target.value }))}
                  placeholder="Optional"
                />
              ) : (
                <span style={valueStyle}>{premise.municipalityCode || "—"}</span>
              )}
            </div>

            <div style={fieldStyle}>
              <span style={labelStyle}>Commodities</span>
              {editing ? (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {allCommodities.map((c) => {
                    const selected = editCommodityIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setEditCommodityIds((prev) =>
                            selected ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                          );
                        }}
                        style={{
                          padding: "4px 12px",
                          borderRadius: "16px",
                          border: selected ? "1px solid var(--accent-primary)" : "1px solid var(--border)",
                          background: selected ? "var(--accent-primary-subtle)" : "transparent",
                          color: selected ? "var(--accent-primary)" : "var(--text-secondary)",
                          fontSize: "12px",
                          fontWeight: selected ? 600 : 400,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          transition: "all 0.15s ease",
                        }}
                      >
                        {c.name} ({c.code})
                      </button>
                    );
                  })}
                  {editCommodityIds.length === 0 && (
                    <span style={{ fontSize: "11px", color: "var(--danger)" }}>At least one commodity required (BR-PR-003)</span>
                  )}
                </div>
              ) : (
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {premise.commodityIds && premise.commodityIds.length > 0
                    ? premise.commodityIds.map((cId, i) => {
                        const comm = allCommodities.find((c) => c.id === cId);
                        return <CommodityBadge key={i} commodity={comm?.code ?? comm?.name ?? ""} />;
                      })
                    : <span style={valueStyle}>—</span>}
                </div>
              )}
            </div>

            {premise.geoLat != null && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Coordinates</span>
                <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "12px" }}>
                  {premise.geoLat}, {premise.geoLng}
                </span>
              </div>
            )}

            {premise.serviceTerritoryId && (
              <div style={fieldStyle}>
                <span style={labelStyle}>Service Territory</span>
                <span style={valueStyle}>{premise.serviceTerritoryId}</span>
              </div>
            )}

            {/* Tenant-configurable custom fields. View mode renders
                stored values as label/value rows; edit mode swaps in
                CustomFieldsSection with host styles passed through. */}
            {(() => {
              const stored = premise.customFields ?? {};
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
              <span style={labelStyle}>Premise ID</span>
              <span style={{ ...valueStyle, fontFamily: "monospace", fontSize: "11px", color: "var(--text-muted)" }}>
                {premise.id}
              </span>
            </div>
          </div>
        )}

        {showDeactivateConfirm && (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "420px", width: "100%" }}>
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Confirm Deactivation</div>
              <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
                Are you sure you want to deactivate this premise? Active meters and agreements will not be affected.
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button onClick={() => setShowDeactivateConfirm(false)} style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
                <button onClick={handleDeactivate} disabled={deactivating} style={{ padding: "6px 14px", fontSize: "12px", background: "var(--danger)", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: deactivating ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: deactivating ? 0.7 : 1 }}>
                  {deactivating ? "Processing..." : "Confirm"}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "meters" && (
          <MetersTab
            premise={premise}
            onMeterAdded={() => { loadPremise(); setShowAddMeter(false); }}
            onRowClick={(id: string) => router.push(`/meters/${id}`)}
            showForm={showAddMeter}
            onShowFormChange={setShowAddMeter}
          />
        )}

        {activeTab === "agreements" && (
          <AgreementsTab
            premise={premise}
            onAgreementAdded={() => { loadPremise(); setShowAddAgreement(false); }}
            onRowClick={(id: string) => router.push(`/service-agreements/${id}`)}
            showForm={showAddAgreement}
            onShowFormChange={setShowAddAgreement}
          />
        )}

        {activeTab === "history" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {(() => {
              const byCommodity = new Map<string, { name: string; events: HistoryEvent[] }>();
              for (const sa of history) {
                const commodityKey = sa.commodity?.id ?? "_uncategorized";
                const commodityName = sa.commodity?.name ?? "Other";
                if (!byCommodity.has(commodityKey)) {
                  byCommodity.set(commodityKey, { name: commodityName, events: [] });
                }
                byCommodity.get(commodityKey)!.events.push({
                  id: sa.id,
                  label: sa.agreementNumber,
                  sublabel: sa.account?.accountNumber
                    ? `Account ${sa.account.accountNumber}`
                    : undefined,
                  startDate: sa.startDate.slice(0, 10),
                  endDate: sa.endDate ? sa.endDate.slice(0, 10) : null,
                  status: sa.status,
                  href: `/service-agreements/${sa.id}`,
                });
              }
              const groups = [...byCommodity.values()];
              if (groups.length === 0) {
                return (
                  <div style={{ color: "var(--text-muted)", fontSize: "13px", padding: "12px 0" }}>
                    No service agreements have covered this premise yet.
                  </div>
                );
              }
              return groups.map((g) => (
                <HistoryTimeline key={g.name} title={g.name} events={g.events} />
              ));
            })()}
          </div>
        )}

        {activeTab === "attachments" && (
          <AttachmentsTab entityType="Premise" entityId={id} showForm={showUpload} onShowFormChange={setShowUpload} />
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
    </div>
  );
}
