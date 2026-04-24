"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { Accordion, type AccordionItem } from "@/components/ui/accordion";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

interface Commodity {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
  defaultUom?: { id: string; code: string; name: string } | null;
}

interface Uom {
  id: string;
  code: string;
  name: string;
  commodityId: string;
  conversionFactor: string;
  isBaseUnit: boolean;
  isActive: boolean;
  measureTypeId: string;
  measureType?: { id: string; code: string; label: string };
}

interface MeasureTypeDef {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

export default function CommoditiesPage() {
  const { toast } = useToast();
  const { canView, canCreate, canEdit, canDelete } = usePermission("commodities");
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [measureTypes, setMeasureTypes] = useState<MeasureTypeDef[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit commodity state
  const [editingCommodity, setEditingCommodity] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ code: "", name: "", displayOrder: 0 });

  // New commodity form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({ code: "", name: "", displayOrder: 0 });

  // New UOM form — now scoped per (commodity, measureType)
  const [showNewUom, setShowNewUom] = useState<string | null>(null); // commodityId
  const [newUomForm, setNewUomForm] = useState({
    code: "",
    name: "",
    conversionFactor: "1",
    isBaseUnit: false,
    measureTypeId: "",
  });

  // Edit UOM state
  const [editingUom, setEditingUom] = useState<string | null>(null);
  const [editUomForm, setEditUomForm] = useState({ name: "", conversionFactor: "1", isBaseUnit: false });

  // Delete UOM state
  const [deleteUomId, setDeleteUomId] = useState<string | null>(null);
  const [deletingUom, setDeletingUom] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [c, u, mt] = await Promise.all([
        apiClient.get<Commodity[]>("/api/v1/commodities"),
        apiClient.get<Uom[]>("/api/v1/uom"),
        apiClient.get<{ data: MeasureTypeDef[] }>("/api/v1/measure-types"),
      ]);
      setCommodities(c);
      setUoms(u);
      setMeasureTypes(mt.data ?? []);
    } catch (err) {
      console.error("Failed to fetch", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const measureTypeById = useMemo(() => {
    const map = new Map<string, MeasureTypeDef>();
    measureTypes.forEach((mt) => map.set(mt.id, mt));
    return map;
  }, [measureTypes]);

  // Active measure types only in the add dropdown, sorted the same
  // way the standalone /measure-types page sorts them (globals first,
  // then by sortOrder, then by code).
  const measureTypeOptions = useMemo(() => {
    return measureTypes
      .filter((mt) => mt.isActive)
      .sort((a, b) => {
        if (a.isGlobal !== b.isGlobal) return a.isGlobal ? -1 : 1;
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.code.localeCompare(b.code);
      });
  }, [measureTypes]);

  if (!canView) return <AccessDenied />;

  const handleCreateCommodity = async () => {
    try {
      await apiClient.post("/api/v1/commodities", newForm);
      setShowNewForm(false);
      setNewForm({ code: "", name: "", displayOrder: 0 });
      toast("Commodity created", "success");
      fetchData();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleUpdateCommodity = async (id: string) => {
    try {
      await apiClient.patch(`/api/v1/commodities/${id}`, editForm);
      setEditingCommodity(null);
      toast("Commodity updated", "success");
      fetchData();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleCreateUom = async (commodityId: string) => {
    if (!newUomForm.code || !newUomForm.name) {
      toast("Code and Name are required", "error");
      return;
    }
    if (!newUomForm.measureTypeId) {
      toast("Measure type is required", "error");
      return;
    }
    try {
      await apiClient.post("/api/v1/uom", {
        code: newUomForm.code,
        name: newUomForm.name,
        commodityId,
        measureTypeId: newUomForm.measureTypeId,
        conversionFactor: Number(newUomForm.conversionFactor) || 1,
        isBaseUnit: newUomForm.isBaseUnit,
        isActive: true,
      });
      setShowNewUom(null);
      setNewUomForm({ code: "", name: "", conversionFactor: "1", isBaseUnit: false, measureTypeId: "" });
      toast("Unit of measure created", "success");
      fetchData();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleUpdateUom = async (id: string) => {
    try {
      await apiClient.patch(`/api/v1/uom/${id}`, {
        name: editUomForm.name,
        conversionFactor: Number(editUomForm.conversionFactor) || 1,
        isBaseUnit: editUomForm.isBaseUnit,
      });
      setEditingUom(null);
      toast("Unit of measure updated", "success");
      fetchData();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleDeleteUom = async () => {
    if (!deleteUomId) return;
    setDeletingUom(true);
    try {
      await apiClient.delete(`/api/v1/uom/${deleteUomId}`);
      setDeleteUomId(null);
      toast("Unit of measure deleted", "success");
      fetchData();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setDeletingUom(false);
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

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0" }}>Loading...</div>;
  }

  // Build one accordion item per commodity. Content contains the
  // commodity edit bar + per-measure-type UOM sub-tables + the
  // per-commodity "Add UOM" flow.
  const items: AccordionItem[] = commodities.map((c) => {
    const cUoms = uoms.filter((u) => u.commodityId === c.id);
    const groupIds = Array.from(new Set(cUoms.map((u) => u.measureTypeId)));
    const groupCount = groupIds.length;
    const uomCount = cUoms.length;

    const summaryText = `${uomCount} UOM${uomCount === 1 ? "" : "s"} · ${groupCount} group${groupCount === 1 ? "" : "s"}`;
    const summary = c.isActive ? summaryText : `INACTIVE · ${summaryText}`;

    const isEditingThisCommodity = editingCommodity === c.id;
    const activeAddForm = showNewUom === c.id;

    // Base unit for the currently-selected measure type group (used
    // to label the conversion-factor field on the add form).
    const selectedGroupUoms = cUoms.filter((u) => u.measureTypeId === newUomForm.measureTypeId);
    const selectedGroupBaseUnit = selectedGroupUoms.find((u) => u.isBaseUnit);

    // Sort groups so any measure type without a definition still
    // lands deterministically (fallback: by id).
    const sortedGroupIds = [...groupIds].sort((a, b) => {
      const A = measureTypeById.get(a);
      const B = measureTypeById.get(b);
      if (A && B) {
        if (A.isGlobal !== B.isGlobal) return A.isGlobal ? -1 : 1;
        if (A.sortOrder !== B.sortOrder) return A.sortOrder - B.sortOrder;
        return A.code.localeCompare(B.code);
      }
      if (A && !B) return -1;
      if (!A && B) return 1;
      return a.localeCompare(b);
    });

    const content = (
      <div>
        {/* Commodity edit bar — same semantic as before, now just inside
            the accordion body so the overview stays compact. */}
        <div
          style={{
            padding: "12px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
          }}
        >
          {isEditingThisCommodity ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
              <input
                style={{ ...inputStyle, width: 100, fontFamily: "monospace" }}
                value={editForm.code}
                onChange={(e) => setEditForm({ ...editForm, code: e.target.value.toUpperCase() })}
              />
              <input
                style={{ ...inputStyle, width: 200 }}
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
              <input
                style={{ ...inputStyle, width: 60 }}
                type="number"
                title="Sort order"
                value={editForm.displayOrder}
                onChange={(e) => setEditForm({ ...editForm, displayOrder: Number(e.target.value) })}
              />
              <button onClick={() => handleUpdateCommodity(c.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>
                Save
              </button>
              <button onClick={() => setEditingCommodity(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)" }}>
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <StatusBadge status={c.isActive ? "ACTIVE" : "INACTIVE"} />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Sort Order: {c.displayOrder}</span>
              </div>
              {canEdit && (
                <button
                  onClick={() => {
                    setEditingCommodity(c.id);
                    setEditForm({ code: c.code, name: c.name, displayOrder: c.displayOrder });
                  }}
                  style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                >
                  Edit
                </button>
              )}
            </>
          )}
        </div>

        {/* Per-measure-type sub-tables */}
        {sortedGroupIds.length === 0 ? (
          <div style={{ padding: "16px 18px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
            No units of measure defined.
          </div>
        ) : (
          sortedGroupIds.map((mtId) => {
            const groupUoms = cUoms.filter((u) => u.measureTypeId === mtId);
            const mt = measureTypeById.get(mtId);
            const headerLabel = mt ? `${mt.code} (${mt.label})` : `UNKNOWN (${mtId.slice(0, 8)}…)`;

            return (
              <div key={mtId}>
                <div
                  style={{
                    padding: "8px 18px",
                    background: "var(--bg-deep)",
                    borderTop: "1px solid var(--border-subtle)",
                    borderBottom: "1px solid var(--border-subtle)",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-secondary)",
                  }}
                >
                  {headerLabel}
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                      <th style={uomTh}>Code</th>
                      <th style={uomTh}>Name</th>
                      <th style={uomTh}>Conversion Factor</th>
                      <th style={uomTh}>Base Unit</th>
                      <th style={{ ...uomTh, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupUoms.map((u) => (
                      <tr key={u.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                        <td style={{ padding: "8px 18px", fontFamily: "monospace", color: "var(--text-primary)" }}>{u.code}</td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <input
                              style={{ ...inputStyle, width: 140, padding: "4px 8px", fontSize: 12 }}
                              value={editUomForm.name}
                              onChange={(e) => setEditUomForm({ ...editUomForm, name: e.target.value })}
                            />
                          ) : (
                            <span style={{ color: "var(--text-secondary)" }}>{u.name}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <input
                              style={{ ...inputStyle, width: 80, padding: "4px 8px", fontSize: 12 }}
                              type="number"
                              step="any"
                              value={editUomForm.conversionFactor}
                              onChange={(e) => setEditUomForm({ ...editUomForm, conversionFactor: e.target.value })}
                            />
                          ) : (
                            <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{u.conversionFactor}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={editUomForm.isBaseUnit}
                                onChange={(e) => setEditUomForm({ ...editUomForm, isBaseUnit: e.target.checked })}
                              />
                              Base
                            </label>
                          ) : u.isBaseUnit ? (
                            <span style={{ fontSize: 10, fontWeight: 500, color: "var(--success)", background: "var(--success-subtle)", padding: "2px 8px", borderRadius: 10 }}>
                              Base
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px", textAlign: "right" }}>
                          {editingUom === u.id ? (
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                              <button onClick={() => handleUpdateUom(u.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "3px 10px" }}>
                                Save
                              </button>
                              <button onClick={() => setEditingUom(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)", padding: "3px 10px", border: "1px solid var(--border)" }}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                              {canEdit && (
                                <button
                                  onClick={() => {
                                    setEditingUom(u.id);
                                    setEditUomForm({ name: u.name, conversionFactor: String(u.conversionFactor), isBaseUnit: u.isBaseUnit });
                                  }}
                                  style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", padding: "3px 10px", border: "1px solid var(--border)" }}
                                >
                                  Edit
                                </button>
                              )}
                              {canDelete && (
                                <button
                                  onClick={() => setDeleteUomId(u.id)}
                                  style={{ ...btnStyle, background: "transparent", color: "var(--danger)", padding: "3px 10px", border: "1px solid var(--danger)" }}
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}

        {/* Add UOM */}
        {activeAddForm ? (
          <div
            style={{
              padding: "12px 18px",
              borderTop: "1px solid var(--border-subtle)",
              display: "flex",
              gap: 8,
              alignItems: "flex-end",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>Measure Type</div>
              <select
                style={{ ...inputStyle, width: 180 }}
                value={newUomForm.measureTypeId}
                onChange={(e) => setNewUomForm({ ...newUomForm, measureTypeId: e.target.value })}
              >
                <option value="">Select…</option>
                {measureTypeOptions.map((mt) => (
                  <option key={mt.id} value={mt.id}>
                    {mt.code} — {mt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>Code</div>
              <input
                style={{ ...inputStyle, width: 80 }}
                value={newUomForm.code}
                onChange={(e) => setNewUomForm({ ...newUomForm, code: e.target.value.toUpperCase() })}
                placeholder="CCF"
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>Name</div>
              <input
                style={{ ...inputStyle, width: 160 }}
                value={newUomForm.name}
                onChange={(e) => setNewUomForm({ ...newUomForm, name: e.target.value })}
                placeholder="Hundred Cubic Feet"
              />
            </div>
            <div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>
                {selectedGroupBaseUnit
                  ? `1 unit = ? ${selectedGroupBaseUnit.code}`
                  : "Base unit (will be the first in this group)"}
              </div>
              <input
                style={{ ...inputStyle, width: 120 }}
                type="number"
                step="any"
                min="0"
                value={newUomForm.conversionFactor}
                onChange={(e) => setNewUomForm({ ...newUomForm, conversionFactor: e.target.value })}
                placeholder={selectedGroupBaseUnit ? `e.g. 748 ${selectedGroupBaseUnit.code}` : "1"}
              />
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                color: "var(--text-secondary)",
                cursor: "pointer",
                paddingBottom: 7,
              }}
            >
              <input
                type="checkbox"
                checked={newUomForm.isBaseUnit}
                onChange={(e) => setNewUomForm({ ...newUomForm, isBaseUnit: e.target.checked })}
              />
              Base unit
            </label>
            <button onClick={() => handleCreateUom(c.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>
              Add
            </button>
            <button onClick={() => setShowNewUom(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)" }}>
              Cancel
            </button>
          </div>
        ) : canCreate ? (
          <div style={{ padding: "8px 18px", borderTop: "1px solid var(--border-subtle)" }}>
            <button
              onClick={() => {
                setShowNewUom(c.id);
                setNewUomForm({
                  code: "",
                  name: "",
                  conversionFactor: "1",
                  isBaseUnit: false,
                  measureTypeId: "",
                });
              }}
              style={{ ...btnStyle, background: "transparent", color: "var(--accent-primary)", padding: "4px 0", fontSize: 12 }}
            >
              + Add Unit of Measure
            </button>
          </div>
        ) : null}
      </div>
    );

    return {
      id: c.id,
      title: c.code,
      subtitle: c.name,
      summary,
      content,
    };
  });

  return (
    <div>
      <PageHeader
        title="Commodities & Units of Measure"
        subtitle={`${commodities.length} commodities · ${uoms.length} units`}
        action={canCreate ? { label: "+ Add Commodity", onClick: () => setShowNewForm(true) } : undefined}
      />

      {/* New Commodity Form — page-level so it sits above the accordion,
          mirroring the existing create flow. */}
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
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Code</div>
            <input
              style={{ ...inputStyle, width: 120 }}
              value={newForm.code}
              onChange={(e) => setNewForm({ ...newForm, code: e.target.value.toUpperCase() })}
              placeholder="WATER"
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Name</div>
            <input
              style={{ ...inputStyle, width: 200 }}
              value={newForm.name}
              onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
              placeholder="Potable Water"
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Sort Order</div>
            <input
              style={{ ...inputStyle, width: 60 }}
              type="number"
              value={newForm.displayOrder}
              onChange={(e) => setNewForm({ ...newForm, displayOrder: Number(e.target.value) })}
            />
          </div>
          <button onClick={handleCreateCommodity} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>
            Create
          </button>
          <button onClick={() => setShowNewForm(false)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>
            Cancel
          </button>
        </div>
      )}

      {commodities.length === 0 ? (
        <div
          style={{
            padding: "40px 16px",
            color: "var(--text-muted)",
            textAlign: "center",
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          No commodities defined.
        </div>
      ) : (
        <Accordion items={items} defaultOpen={[]} />
      )}

      {/* Delete UOM confirmation */}
      {deleteUomId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            style={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: "24px",
              maxWidth: "420px",
              width: "100%",
            }}
          >
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>
              Delete Unit of Measure
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              Are you sure? This will permanently delete this unit of measure. If any meters are using it, the delete will be blocked (BR-UO-005).
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setDeleteUomId(null)}
                style={{
                  padding: "6px 14px",
                  fontSize: "12px",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteUom}
                disabled={deletingUom}
                style={{
                  padding: "6px 14px",
                  fontSize: "12px",
                  background: "var(--danger)",
                  color: "#fff",
                  border: "none",
                  borderRadius: "var(--radius)",
                  cursor: deletingUom ? "not-allowed" : "pointer",
                  fontFamily: "inherit",
                  opacity: deletingUom ? 0.7 : 1,
                }}
              >
                {deletingUom ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const uomTh = {
  padding: "8px 18px",
  textAlign: "left" as const,
  fontSize: 10,
  fontWeight: 600 as const,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};
