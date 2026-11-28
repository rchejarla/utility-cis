"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { PageDescription } from "@/components/ui/page-description";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Service classes — the customer categories a tariff's charges are
 * conditioned on ("customer class equals residential") and which every
 * agreement must be in (spec 05, required since 2026-11-28).
 *
 * Per commodity, because each service's tariff defines its own: water says
 * "single family" where electric says "residential". So the page works one
 * commodity at a time.
 *
 * **A class's code cannot change once created.** Rating compares the
 * agreement's class code with the code a rate charge names, so renaming the
 * code would silently detach every charge that names it. The label is free
 * to change. A class is retired (inactive), never deleted: agreements in it
 * keep it, and it stops being offered for new ones.
 */

interface Commodity {
  id: string;
  name: string;
  code: string;
}

interface ServiceClass {
  id: string;
  commodityId: string;
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  _count?: { serviceAgreements: number };
}

interface Form {
  code: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
}

const EMPTY: Form = { code: "", label: "", sortOrder: 100, isActive: true };

/** What the API accepts for a code: lowercase letters, digits, underscores. */
const toCode = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, "_");

export default function ServiceClassesPage() {
  const { toast } = useToast();
  const { canView, canEdit } = usePermission("rate_schedules");
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [commodityId, setCommodityId] = useState("");
  const [rows, setRows] = useState<ServiceClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Form>(EMPTY);
  const [confirmRetire, setConfirmRetire] = useState<ServiceClass | null>(null);

  useEffect(() => {
    apiClient
      .get<{ data: Commodity[] } | Commodity[]>("/api/v1/commodities")
      .then((res) => {
        const list = Array.isArray(res) ? res : res.data ?? [];
        setCommodities(list);
        setCommodityId((current) => current || list[0]?.id || "");
      })
      .catch(console.error);
  }, []);

  const fetchRows = useCallback(async () => {
    if (!commodityId) return;
    setLoading(true);
    try {
      setRows(await apiClient.get<ServiceClass[]>("/api/v1/rate-service-classes", { commodityId }));
    } catch (err) {
      console.error(err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [commodityId]);

  useEffect(() => {
    setEditingId(null);
    setShowNew(false);
    void fetchRows();
  }, [fetchRows]);

  if (!canView) return <AccessDenied />;

  const commodity = commodities.find((c) => c.id === commodityId);

  const handleCreate = async () => {
    if (!newForm.code.trim() || !newForm.label.trim()) {
      toast("Code and label are required", "error");
      return;
    }
    setBusy(true);
    try {
      await apiClient.post("/api/v1/rate-service-classes", {
        commodityId,
        code: newForm.code.trim(),
        label: newForm.label.trim(),
        sortOrder: newForm.sortOrder,
        isActive: newForm.isActive,
      });
      toast("Service class created", "success");
      setShowNew(false);
      setNewForm(EMPTY);
      await fetchRows();
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/^API error \d+:\s*/, "") : "Failed to create", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = (row: ServiceClass) => {
    if (!editForm.label.trim()) {
      toast("Label is required", "error");
      return;
    }
    // Retiring a class agreements are in is said out loud first.
    if (row.isActive && !editForm.isActive && (row._count?.serviceAgreements ?? 0) > 0) {
      setConfirmRetire(row);
      return;
    }
    void saveUpdate(row);
  };

  const saveUpdate = async (row: ServiceClass) => {
    setConfirmRetire(null);
    setBusy(true);
    try {
      await apiClient.patch(`/api/v1/rate-service-classes/${row.id}`, {
        label: editForm.label.trim(),
        sortOrder: editForm.sortOrder,
        isActive: editForm.isActive,
      });
      toast("Service class updated", "success");
      setEditingId(null);
      await fetchRows();
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/^API error \d+:\s*/, "") : "Failed to update", "error");
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...rows].sort((a, b) =>
    a.isActive !== b.isActive ? (a.isActive ? -1 : 1) : a.sortOrder - b.sortOrder || a.code.localeCompare(b.code),
  );

  return (
    <div>
      <PageHeader
        title="Service Classes"
        subtitle={commodity ? `${rows.filter((r) => r.isActive).length} active for ${commodity.name}` : undefined}
        action={canEdit && commodityId ? { label: "+ Add Service Class", onClick: () => setShowNew(true) } : undefined}
      />

      <PageDescription storageKey="service-classes">
        A <b>service class</b> is the customer category a service is priced as — residential, single
        family, commercial, irrigation… A rate&apos;s charges can apply only to certain classes, and
        every agreement must be in one. Classes are defined <b>per commodity</b>, because each
        service&apos;s tariff has its own. A class&apos;s <b>code cannot change</b> once created, because
        rate charges refer to it by code; retire a class rather than delete it.
      </PageDescription>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <label htmlFor="commodity" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Commodity
        </label>
        <select
          id="commodity"
          value={commodityId}
          onChange={(e) => setCommodityId(e.target.value)}
          style={{ ...inputStyle, minWidth: 200 }}
        >
          {commodities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {showNew && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14, marginBottom: 12, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div>
            <div style={lblStyle}>Code (permanent)</div>
            <input
              aria-label="Code"
              style={{ ...inputStyle, width: 170, fontFamily: "monospace" }}
              value={newForm.code}
              onChange={(e) => setNewForm({ ...newForm, code: toCode(e.target.value) })}
              placeholder="small_commercial"
            />
          </div>
          <div>
            <div style={lblStyle}>Label</div>
            <input
              aria-label="Label"
              style={{ ...inputStyle, width: 200 }}
              value={newForm.label}
              onChange={(e) => setNewForm({ ...newForm, label: e.target.value })}
              placeholder="Small Commercial"
            />
          </div>
          <div>
            <div style={lblStyle}>Sort order</div>
            <input style={{ ...inputStyle, width: 70 }} type="number" value={newForm.sortOrder} onChange={(e) => setNewForm({ ...newForm, sortOrder: Number(e.target.value) })} />
          </div>
          <button onClick={handleCreate} disabled={busy} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>
            {busy ? "Working..." : "Create"}
          </button>
          <button onClick={() => { setShowNew(false); setNewForm(EMPTY); }} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
            Cancel
          </button>
        </div>
      )}

      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              <th style={thCell}>Code</th>
              <th style={thCell}>Label</th>
              <th style={thCell}>Sort</th>
              <th style={thCell}>Agreements</th>
              <th style={thCell}>Status</th>
              <th style={{ ...thCell, textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ ...tdCell, color: "var(--text-muted)" }}>Loading…</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={6} style={{ ...tdCell, color: "var(--text-muted)", textAlign: "center" }}>No service classes for this commodity yet — agreements for it cannot be created until one exists.</td></tr>
            ) : (
              sorted.map((r) => {
                const isEditing = editingId === r.id;
                return (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle)", opacity: r.isActive || isEditing ? 1 : 0.65 }}>
                    <td style={{ ...tdCell, fontFamily: "monospace" }}>{r.code}</td>
                    <td style={tdCell}>
                      {isEditing ? (
                        <input aria-label="Label" style={{ ...inputStyle, width: 200 }} value={editForm.label} onChange={(e) => setEditForm({ ...editForm, label: e.target.value })} />
                      ) : r.label}
                    </td>
                    <td style={tdCell}>
                      {isEditing ? (
                        <input style={{ ...inputStyle, width: 70 }} type="number" value={editForm.sortOrder} onChange={(e) => setEditForm({ ...editForm, sortOrder: Number(e.target.value) })} />
                      ) : r.sortOrder}
                    </td>
                    <td data-testid={`in-use-${r.code}`} style={{ ...tdCell, fontFamily: "monospace" }}>{r._count?.serviceAgreements ?? 0}</td>
                    <td style={tdCell}>
                      {isEditing ? (
                        <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                          <input type="checkbox" checked={editForm.isActive} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })} /> Active
                        </label>
                      ) : r.isActive ? (
                        <span style={{ fontSize: 10, fontWeight: 500, color: "var(--success)", background: "var(--success-subtle)", padding: "2px 8px", borderRadius: 10 }}>Active</span>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Retired</span>
                      )}
                    </td>
                    <td style={{ ...tdCell, textAlign: "right" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          <button onClick={() => handleUpdate(r)} disabled={busy} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 12px" }}>{busy ? "Saving..." : "Save"}</button>
                          <button onClick={() => setEditingId(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)", padding: "4px 12px", border: "1px solid var(--border)" }}>Cancel</button>
                        </div>
                      ) : canEdit ? (
                        <button
                          onClick={() => { setEditingId(r.id); setEditForm({ code: r.code, label: r.label, sortOrder: r.sortOrder, isActive: r.isActive }); }}
                          style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", padding: "4px 12px", border: "1px solid var(--border)" }}
                        >
                          Edit
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {confirmRetire && (
        <ConfirmDialog
          title={`Retire "${confirmRetire.label}"?`}
          message={(() => {
            const n = confirmRetire._count?.serviceAgreements ?? 0;
            return `${n} agreement${n === 1 ? " is" : "s are"} in this class and will stay in it. It will no longer be offered for new agreements or changes.`;
          })()}
          confirmLabel="Retire"
          cancelLabel="Keep active"
          onConfirm={() => void saveUpdate(confirmRetire)}
          onCancel={() => setConfirmRetire(null)}
        />
      )}
    </div>
  );
}

const inputStyle = { padding: "6px 10px", fontSize: "13px", background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-primary)", fontFamily: "inherit", outline: "none" };
const btnStyle = { padding: "6px 14px", fontSize: "12px", fontWeight: 500 as const, border: "none", borderRadius: "var(--radius)", cursor: "pointer", fontFamily: "inherit" };
const lblStyle = { fontSize: 11, color: "var(--text-muted)", marginBottom: 4 };
const thCell = { padding: "10px 14px", textAlign: "left" as const, fontSize: 10, fontWeight: 600 as const, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "var(--text-muted)" };
const tdCell = { padding: "8px 14px", color: "var(--text-primary)", verticalAlign: "middle" as const };
