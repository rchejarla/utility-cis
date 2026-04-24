"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface MeasureTypeDef {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

interface CreateForm {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

interface EditForm {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

const EMPTY_CREATE: CreateForm = {
  code: "",
  label: "",
  description: "",
  sortOrder: 0,
  isActive: true,
};

export default function MeasureTypesPage() {
  const { toast } = useToast();
  const { canView, canCreate, canEdit } = usePermission("commodities");
  const [rows, setRows] = useState<MeasureTypeDef[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState<CreateForm>(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({
    code: "",
    label: "",
    description: "",
    sortOrder: 0,
    isActive: true,
  });
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: MeasureTypeDef[] }>("/api/v1/measure-types");
      setRows(res.data ?? []);
    } catch (err) {
      console.error("Failed to fetch measure types", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!canView) return <AccessDenied />;

  const handleCreate = async () => {
    if (!newForm.code.trim() || !newForm.label.trim()) {
      toast("Code and Label are required", "error");
      return;
    }
    setCreating(true);
    try {
      await apiClient.post("/api/v1/measure-types", {
        code: newForm.code.trim(),
        label: newForm.label.trim(),
        description: newForm.description.trim() || undefined,
        sortOrder: newForm.sortOrder,
        isActive: newForm.isActive,
      });
      toast("Measure type created", "success");
      setShowNewForm(false);
      setNewForm(EMPTY_CREATE);
      fetchData();
    } catch (err: any) {
      toast(err?.message ?? "Failed to create measure type", "error");
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (id: string) => {
    if (!editForm.code.trim() || !editForm.label.trim()) {
      toast("Code and Label are required", "error");
      return;
    }
    setSaving(true);
    try {
      await apiClient.patch(`/api/v1/measure-types/${id}`, {
        code: editForm.code.trim(),
        label: editForm.label.trim(),
        description: editForm.description.trim() || undefined,
        sortOrder: editForm.sortOrder,
        isActive: editForm.isActive,
      });
      toast("Measure type updated", "success");
      setEditingId(null);
      fetchData();
    } catch (err: any) {
      toast(err?.message ?? "Failed to update measure type", "error");
    } finally {
      setSaving(false);
    }
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
  };

  const btnStyle = {
    padding: "6px 14px",
    fontSize: "12px",
    fontWeight: 500 as const,
    border: "none",
    borderRadius: "var(--radius)",
    cursor: "pointer",
    fontFamily: "inherit",
  };

  // Globals first, then tenant rows. Within each scope, respect
  // sortOrder then code so the table stays deterministic.
  const sorted = [...rows].sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.code.localeCompare(b.code);
  });

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }

  const globalCount = rows.filter((r) => r.isGlobal).length;
  const tenantCount = rows.length - globalCount;

  return (
    <div>
      <PageHeader
        title="Measure Types"
        subtitle={`Semantic categories for meter readings — usage, demand, TOU, etc. Globals are shared across all tenants and can't be edited here. (${globalCount} global · ${tenantCount} tenant)`}
        action={
          canCreate
            ? { label: "+ Add Measure Type", onClick: () => setShowNewForm(true) }
            : undefined
        }
      />

      <PageDescription storageKey="measure-types">
        A <b>measure type</b> is the semantic category a reading represents —
        usage totalizer, demand peak, TOU window, reactive power — so a meter
        register or UOM can be tagged with what it actually means rather than
        just what unit it reports. <b>Global</b> types are seeded and read-only;
        tenants can add local codes for anything the shared catalog doesn't cover.
      </PageDescription>

      {showNewForm && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 16,
            marginBottom: 16,
            display: "flex",
            gap: 10,
            alignItems: "flex-end",
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Code</div>
            <input
              style={{ ...inputStyle, width: 120, fontFamily: "monospace" }}
              value={newForm.code}
              onChange={(e) => setNewForm({ ...newForm, code: e.target.value.toUpperCase() })}
              placeholder="USAGE"
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Label</div>
            <input
              style={{ ...inputStyle, width: 200 }}
              value={newForm.label}
              onChange={(e) => setNewForm({ ...newForm, label: e.target.value })}
              placeholder="Usage"
            />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              Description
            </div>
            <input
              style={{ ...inputStyle, width: "100%" }}
              value={newForm.description}
              onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
              placeholder="Consumption totalizer"
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              Sort Order
            </div>
            <input
              style={{ ...inputStyle, width: 70 }}
              type="number"
              value={newForm.sortOrder}
              onChange={(e) => setNewForm({ ...newForm, sortOrder: Number(e.target.value) })}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              color: "var(--text-secondary)",
              cursor: "pointer",
              paddingBottom: 7,
            }}
          >
            <input
              type="checkbox"
              checked={newForm.isActive}
              onChange={(e) => setNewForm({ ...newForm, isActive: e.target.checked })}
            />
            Active
          </label>
          <button
            onClick={handleCreate}
            disabled={creating}
            style={{
              ...btnStyle,
              background: "var(--accent-primary)",
              color: "#fff",
              opacity: creating ? 0.7 : 1,
              cursor: creating ? "not-allowed" : "pointer",
            }}
          >
            {creating ? "Creating..." : "Create"}
          </button>
          <button
            onClick={() => {
              setShowNewForm(false);
              setNewForm(EMPTY_CREATE);
            }}
            style={{
              ...btnStyle,
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={thCell}>Code</th>
              <th style={thCell}>Label</th>
              <th style={thCell}>Description</th>
              <th style={thCell}>Sort Order</th>
              <th style={thCell}>Active</th>
              <th style={thCell}>Scope</th>
              <th style={{ ...thCell, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const isEditing = editingId === r.id;
              return (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <td style={{ ...tdCell, fontFamily: "monospace" }}>
                    {isEditing ? (
                      <input
                        style={{ ...inputStyle, width: 110, fontFamily: "monospace" }}
                        value={editForm.code}
                        onChange={(e) =>
                          setEditForm({ ...editForm, code: e.target.value.toUpperCase() })
                        }
                      />
                    ) : (
                      r.code
                    )}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? (
                      <input
                        style={{ ...inputStyle, width: 180 }}
                        value={editForm.label}
                        onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                      />
                    ) : (
                      r.label
                    )}
                  </td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                    {isEditing ? (
                      <input
                        style={{ ...inputStyle, width: "100%", minWidth: 200 }}
                        value={editForm.description}
                        onChange={(e) =>
                          setEditForm({ ...editForm, description: e.target.value })
                        }
                      />
                    ) : (
                      r.description ?? (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )
                    )}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? (
                      <input
                        style={{ ...inputStyle, width: 70 }}
                        type="number"
                        value={editForm.sortOrder}
                        onChange={(e) =>
                          setEditForm({ ...editForm, sortOrder: Number(e.target.value) })
                        }
                      />
                    ) : (
                      r.sortOrder
                    )}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? (
                      <label
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 12,
                          color: "var(--text-secondary)",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={editForm.isActive}
                          onChange={(e) =>
                            setEditForm({ ...editForm, isActive: e.target.checked })
                          }
                        />
                        Active
                      </label>
                    ) : r.isActive ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 500,
                          color: "var(--success)",
                          background: "var(--success-subtle)",
                          padding: "2px 8px",
                          borderRadius: 10,
                        }}
                      >
                        Yes
                      </span>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No</span>
                    )}
                  </td>
                  <td style={tdCell}>
                    {r.isGlobal ? (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--text-secondary)",
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--border)",
                          padding: "2px 8px",
                          borderRadius: 10,
                          textTransform: "uppercase" as const,
                          letterSpacing: "0.04em",
                        }}
                      >
                        Global
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--accent-primary)",
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--accent-primary)",
                          padding: "2px 8px",
                          borderRadius: 10,
                          textTransform: "uppercase" as const,
                          letterSpacing: "0.04em",
                        }}
                      >
                        Tenant
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdCell, textAlign: "right" }}>
                    {r.isGlobal ? (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        Global — read-only
                      </span>
                    ) : isEditing ? (
                      <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                        <button
                          onClick={() => handleUpdate(r.id)}
                          disabled={saving}
                          style={{
                            ...btnStyle,
                            background: "var(--accent-primary)",
                            color: "#fff",
                            padding: "4px 12px",
                            opacity: saving ? 0.7 : 1,
                            cursor: saving ? "not-allowed" : "pointer",
                          }}
                        >
                          {saving ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          style={{
                            ...btnStyle,
                            background: "transparent",
                            color: "var(--text-muted)",
                            padding: "4px 12px",
                            border: "1px solid var(--border)",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : canEdit ? (
                      <button
                        onClick={() => {
                          setEditingId(r.id);
                          setEditForm({
                            code: r.code,
                            label: r.label,
                            description: r.description ?? "",
                            sortOrder: r.sortOrder,
                            isActive: r.isActive,
                          });
                        }}
                        style={{
                          ...btnStyle,
                          background: "transparent",
                          color: "var(--text-secondary)",
                          padding: "4px 12px",
                          border: "1px solid var(--border)",
                        }}
                      >
                        Edit
                      </button>
                    ) : (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  style={{ padding: "24px 18px", color: "var(--text-muted)", textAlign: "center" }}
                >
                  No measure types defined.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thCell = {
  padding: "10px 14px",
  textAlign: "left" as const,
  fontSize: 10,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const tdCell = {
  padding: "10px 14px",
  color: "var(--text-primary)",
  verticalAlign: "middle" as const,
};
