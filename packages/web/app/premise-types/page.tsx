"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface TypeDef {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

interface Form {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
  isActive: boolean;
}

const EMPTY: Form = {
  code: "",
  label: "",
  description: "",
  sortOrder: 100,
  isActive: true,
};

export default function PremiseTypesPage() {
  const { toast } = useToast();
  const { canView, canCreate, canEdit } = usePermission("premises");
  const [rows, setRows] = useState<TypeDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState<Form>(EMPTY);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: TypeDef[] }>(
        "/api/v1/premise-types?includeInactive=true",
      );
      setRows(res.data ?? []);
    } catch (err) {
      console.error(err);
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
      await apiClient.post("/api/v1/premise-types", {
        code: newForm.code.trim(),
        label: newForm.label.trim(),
        description: newForm.description.trim() || undefined,
        sortOrder: newForm.sortOrder,
        isActive: newForm.isActive,
      });
      toast("Premise type created", "success");
      setShowNew(false);
      setNewForm(EMPTY);
      fetchData();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to create", "error");
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
      await apiClient.patch(`/api/v1/premise-types/${id}`, {
        code: editForm.code.trim(),
        label: editForm.label.trim(),
        description: editForm.description.trim() || undefined,
        sortOrder: editForm.sortOrder,
        isActive: editForm.isActive,
      });
      toast("Premise type updated", "success");
      setEditingId(null);
      fetchData();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to update", "error");
    } finally {
      setSaving(false);
    }
  };

  const sorted = [...rows].sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.code.localeCompare(b.code);
  });

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }

  const standardCount = rows.filter((r) => r.isGlobal).length;
  const customCount = rows.length - standardCount;

  return (
    <div>
      <PageHeader
        title="Premise Types"
        subtitle={`Service-class taxonomy for premises — Residential, Multi-Family, Commercial, etc. Standards are built in and read-only. (${standardCount} standard · ${customCount} custom)`}
        action={canCreate ? { label: "+ Add Premise Type", onClick: () => setShowNew(true) } : undefined}
      />

      <PageDescription storageKey="premise-types">
        A <b>premise type</b> classifies the physical property — e.g. a single-
        family home vs. a multi-family building vs. a commercial storefront.
        It drives GIS rules, density assumptions, and shut-off procedures.
        Standard codes (Residential, Multi-Family, Commercial, Industrial,
        Municipal) are seeded for every tenant and cannot be edited; you can
        add your own codes alongside them.
      </PageDescription>

      {showNew && (
        <FormRow form={newForm} setForm={setNewForm} onSubmit={handleCreate} onCancel={() => { setShowNew(false); setNewForm(EMPTY); }} busy={creating} submitLabel="Create" />
      )}

      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={thCell}>Code</th>
              <th style={thCell}>Label</th>
              <th style={thCell}>Description</th>
              <th style={thCell}>Sort</th>
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
                    {isEditing ? <input style={{ ...inputStyle, width: 110, fontFamily: "monospace" }} value={editForm.code} onChange={(e) => setEditForm({ ...editForm, code: e.target.value.toUpperCase() })} /> : r.code}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? <input style={{ ...inputStyle, width: 180 }} value={editForm.label} onChange={(e) => setEditForm({ ...editForm, label: e.target.value })} /> : r.label}
                  </td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                    {isEditing ? <input style={{ ...inputStyle, width: "100%", minWidth: 200 }} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} /> : (r.description ?? <span style={{ color: "var(--text-muted)" }}>—</span>)}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? <input style={{ ...inputStyle, width: 70 }} type="number" value={editForm.sortOrder} onChange={(e) => setEditForm({ ...editForm, sortOrder: Number(e.target.value) })} /> : r.sortOrder}
                  </td>
                  <td style={tdCell}>
                    {isEditing ? <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}><input type="checkbox" checked={editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })} /> Active</label> : (r.isActive ? <ActiveBadge /> : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>No</span>)}
                  </td>
                  <td style={tdCell}>
                    {r.isGlobal ? <ScopeBadge>Standard</ScopeBadge> : <ScopeBadge custom>Custom</ScopeBadge>}
                  </td>
                  <td style={{ ...tdCell, textAlign: "right" }}>
                    {r.isGlobal ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Standard — read-only</span>
                      : isEditing ? (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button onClick={() => handleUpdate(r.id)} disabled={saving} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 12px" }}>{saving ? "Saving..." : "Save"}</button>
                          <button onClick={() => setEditingId(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)", padding: "4px 12px", border: "1px solid var(--border)" }}>Cancel</button>
                        </div>
                      ) : canEdit ? (
                        <button onClick={() => { setEditingId(r.id); setEditForm({ code: r.code, label: r.label, description: r.description ?? "", sortOrder: r.sortOrder, isActive: r.isActive }); }} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", padding: "4px 12px", border: "1px solid var(--border)" }}>Edit</button>
                      ) : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                    }
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={7} style={{ padding: "24px 18px", color: "var(--text-muted)", textAlign: "center" }}>No premise types defined.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FormRow({ form, setForm, onSubmit, onCancel, busy, submitLabel }: { form: Form; setForm: (f: Form) => void; onSubmit: () => void; onCancel: () => void; busy: boolean; submitLabel: string }) {
  return (
    <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 16, marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div><div style={lblStyle}>Code</div><input style={{ ...inputStyle, width: 120, fontFamily: "monospace" }} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="MULTI_FAMILY" /></div>
      <div><div style={lblStyle}>Label</div><input style={{ ...inputStyle, width: 200 }} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Multi-Family" /></div>
      <div style={{ flex: 1, minWidth: 220 }}><div style={lblStyle}>Description</div><input style={{ ...inputStyle, width: "100%" }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      <div><div style={lblStyle}>Sort Order</div><input style={{ ...inputStyle, width: 70 }} type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} /></div>
      <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)", paddingBottom: 7 }}><input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> Active</label>
      <button onClick={onSubmit} disabled={busy} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>{busy ? "Working..." : submitLabel}</button>
      <button onClick={onCancel} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>Cancel</button>
    </div>
  );
}

function ActiveBadge() {
  return <span style={{ fontSize: 10, fontWeight: 500, color: "var(--success)", background: "var(--success-subtle)", padding: "2px 8px", borderRadius: 10 }}>Yes</span>;
}
function ScopeBadge({ children, custom }: { children: React.ReactNode; custom?: boolean }) {
  return <span style={{ fontSize: 10, fontWeight: 600, color: custom ? "var(--accent-primary)" : "var(--text-secondary)", background: "var(--bg-elevated)", border: `1px solid ${custom ? "var(--accent-primary)" : "var(--border)"}`, padding: "2px 8px", borderRadius: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>{children}</span>;
}

const inputStyle = { padding: "6px 10px", fontSize: "13px", background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-primary)", fontFamily: "inherit", outline: "none" };
const btnStyle = { padding: "6px 14px", fontSize: "12px", fontWeight: 500 as const, border: "none", borderRadius: "var(--radius)", cursor: "pointer", fontFamily: "inherit" };
const lblStyle = { fontSize: 11, color: "var(--text-muted)", marginBottom: 4 };
const thCell = { padding: "10px 14px", textAlign: "left" as const, fontSize: 10, fontWeight: 600 as const, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-muted)" };
const tdCell = { padding: "10px 14px", color: "var(--text-primary)", verticalAlign: "middle" as const };
