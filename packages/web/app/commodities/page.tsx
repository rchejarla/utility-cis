"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

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
}

export default function CommoditiesPage() {
  const { toast } = useToast();
  const [commodities, setCommodities] = useState<Commodity[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [loading, setLoading] = useState(true);

  // Edit state
  const [editingCommodity, setEditingCommodity] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ code: "", name: "", displayOrder: 0 });

  // New commodity form
  const [showNewForm, setShowNewForm] = useState(false);
  const [newForm, setNewForm] = useState({ code: "", name: "", displayOrder: 0 });

  // New UOM form
  const [showNewUom, setShowNewUom] = useState<string | null>(null);
  const [newUomForm, setNewUomForm] = useState({ code: "", name: "", conversionFactor: "1", isBaseUnit: false });

  // Edit UOM state
  const [editingUom, setEditingUom] = useState<string | null>(null);
  const [editUomForm, setEditUomForm] = useState({ name: "", conversionFactor: "1", isBaseUnit: false });

  // Delete UOM state
  const [deleteUomId, setDeleteUomId] = useState<string | null>(null);
  const [deletingUom, setDeletingUom] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([
        apiClient.get<Commodity[]>("/api/v1/commodities"),
        apiClient.get<Uom[]>("/api/v1/uom"),
      ]);
      setCommodities(c);
      setUoms(u);
    } catch (err) {
      console.error("Failed to fetch", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

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
    try {
      await apiClient.post("/api/v1/uom", {
        code: newUomForm.code,
        name: newUomForm.name,
        commodityId,
        conversionFactor: Number(newUomForm.conversionFactor) || 1,
        isBaseUnit: newUomForm.isBaseUnit,
        isActive: true,
      });
      setShowNewUom(null);
      setNewUomForm({ code: "", name: "", conversionFactor: "1", isBaseUnit: false });
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

  return (
    <div>
      <PageHeader
        title="Commodities & Units of Measure"
        subtitle={`${commodities.length} commodities · ${uoms.length} units`}
        action={{ label: "+ Add Commodity", href: "#", onClick: () => setShowNewForm(true) }}
      />

      {/* New Commodity Form */}
      {showNewForm && (
        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 16, marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Code</div>
            <input style={{ ...inputStyle, width: 120 }} value={newForm.code} onChange={(e) => setNewForm({ ...newForm, code: e.target.value.toUpperCase() })} placeholder="WATER" />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Name</div>
            <input style={{ ...inputStyle, width: 200 }} value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} placeholder="Potable Water" />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Order</div>
            <input style={{ ...inputStyle, width: 60 }} type="number" value={newForm.displayOrder} onChange={(e) => setNewForm({ ...newForm, displayOrder: Number(e.target.value) })} />
          </div>
          <button onClick={handleCreateCommodity} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>Create</button>
          <button onClick={() => setShowNewForm(false)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>Cancel</button>
        </div>
      )}

      {/* Commodity Cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {commodities.map((c) => {
          const cUoms = uoms.filter((u) => u.commodityId === c.id);
          const baseUnit = cUoms.find((u) => u.isBaseUnit);
          const isEditing = editingCommodity === c.id;

          return (
            <div key={c.id} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              {/* Commodity Header */}
              <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle)" }}>
                {isEditing ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
                    <input style={{ ...inputStyle, width: 100, fontFamily: "monospace" }} value={editForm.code} onChange={(e) => setEditForm({ ...editForm, code: e.target.value.toUpperCase() })} />
                    <input style={{ ...inputStyle, width: 200 }} value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                    <input style={{ ...inputStyle, width: 50 }} type="number" value={editForm.displayOrder} onChange={(e) => setEditForm({ ...editForm, displayOrder: Number(e.target.value) })} />
                    <button onClick={() => handleUpdateCommodity(c.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>Save</button>
                    <button onClick={() => setEditingCommodity(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)" }}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontFamily: "monospace", fontSize: 13, fontWeight: 600, color: "var(--text-primary)", background: "var(--bg-elevated)", padding: "3px 10px", borderRadius: 4 }}>{c.code}</span>
                      <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>{c.name}</span>
                      <StatusBadge status={c.isActive ? "ACTIVE" : "INACTIVE"} />
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Order: {c.displayOrder}</span>
                    </div>
                    <button
                      onClick={() => { setEditingCommodity(c.id); setEditForm({ code: c.code, name: c.name, displayOrder: c.displayOrder }); }}
                      style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
                    >
                      Edit
                    </button>
                  </>
                )}
              </div>

              {/* UOMs Table */}
              <div style={{ padding: "0" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-elevated)" }}>
                      <th style={{ padding: "8px 18px", textAlign: "left", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Code</th>
                      <th style={{ padding: "8px 18px", textAlign: "left", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Name</th>
                      <th style={{ padding: "8px 18px", textAlign: "left", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Conversion Factor</th>
                      <th style={{ padding: "8px 18px", textAlign: "left", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Base Unit</th>
                      <th style={{ padding: "8px 18px", textAlign: "right", fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cUoms.map((u) => (
                      <tr key={u.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                        <td style={{ padding: "8px 18px", fontFamily: "monospace", color: "var(--text-primary)" }}>{u.code}</td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <input style={{ ...inputStyle, width: 140, padding: "4px 8px", fontSize: 12 }} value={editUomForm.name} onChange={(e) => setEditUomForm({ ...editUomForm, name: e.target.value })} />
                          ) : (
                            <span style={{ color: "var(--text-secondary)" }}>{u.name}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <input style={{ ...inputStyle, width: 80, padding: "4px 8px", fontSize: 12 }} type="number" step="any" value={editUomForm.conversionFactor} onChange={(e) => setEditUomForm({ ...editUomForm, conversionFactor: e.target.value })} />
                          ) : (
                            <span style={{ fontFamily: "monospace", color: "var(--text-secondary)" }}>{u.conversionFactor}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px" }}>
                          {editingUom === u.id ? (
                            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                              <input type="checkbox" checked={editUomForm.isBaseUnit} onChange={(e) => setEditUomForm({ ...editUomForm, isBaseUnit: e.target.checked })} />
                              Base
                            </label>
                          ) : u.isBaseUnit ? (
                            <span style={{ fontSize: 10, fontWeight: 500, color: "#4ade80", background: "rgba(74,222,128,0.1)", padding: "2px 8px", borderRadius: 10 }}>Base</span>
                          ) : (
                            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 18px", textAlign: "right" }}>
                          {editingUom === u.id ? (
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                              <button onClick={() => handleUpdateUom(u.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "3px 10px" }}>Save</button>
                              <button onClick={() => setEditingUom(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)", padding: "3px 10px", border: "1px solid var(--border)" }}>Cancel</button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                              <button onClick={() => { setEditingUom(u.id); setEditUomForm({ name: u.name, conversionFactor: String(u.conversionFactor), isBaseUnit: u.isBaseUnit }); }} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", padding: "3px 10px", border: "1px solid var(--border)" }}>Edit</button>
                              <button onClick={() => setDeleteUomId(u.id)} style={{ ...btnStyle, background: "transparent", color: "#f87171", padding: "3px 10px", border: "1px solid rgba(239,68,68,0.3)" }}>Delete</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {cUoms.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: "16px 18px", color: "var(--text-muted)", textAlign: "center" }}>No units of measure defined</td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {/* Add UOM */}
                {showNewUom === c.id ? (
                  <div style={{ padding: "12px 18px", borderTop: "1px solid var(--border-subtle)", display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>Code</div>
                      <input style={{ ...inputStyle, width: 80 }} value={newUomForm.code} onChange={(e) => setNewUomForm({ ...newUomForm, code: e.target.value.toUpperCase() })} placeholder="CCF" />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>Name</div>
                      <input style={{ ...inputStyle, width: 160 }} value={newUomForm.name} onChange={(e) => setNewUomForm({ ...newUomForm, name: e.target.value })} placeholder="Hundred Cubic Feet" />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 3 }}>
                        {baseUnit ? `1 unit = ? ${baseUnit.code}` : "Conversion Factor"}
                      </div>
                      <input style={{ ...inputStyle, width: 100 }} type="number" step="any" min="0" value={newUomForm.conversionFactor} onChange={(e) => setNewUomForm({ ...newUomForm, conversionFactor: e.target.value })} placeholder={baseUnit ? `e.g. 748 ${baseUnit.code}` : "1"} />
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-secondary)", cursor: "pointer" }}>
                      <input type="checkbox" checked={newUomForm.isBaseUnit} onChange={(e) => setNewUomForm({ ...newUomForm, isBaseUnit: e.target.checked })} />
                      Base unit
                    </label>
                    <button onClick={() => handleCreateUom(c.id)} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff" }}>Add</button>
                    <button onClick={() => setShowNewUom(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-muted)" }}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ padding: "8px 18px", borderTop: "1px solid var(--border-subtle)" }}>
                    <button
                      onClick={() => { setShowNewUom(c.id); setNewUomForm({ code: "", name: "", conversionFactor: "1", isBaseUnit: false }); }}
                      style={{ ...btnStyle, background: "transparent", color: "var(--accent-primary)", padding: "4px 0", fontSize: 12 }}
                    >
                      + Add Unit of Measure
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Delete UOM confirmation */}
      {deleteUomId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "420px", width: "100%" }}>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Delete Unit of Measure</div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              Are you sure? This will permanently delete this unit of measure. If any meters are using it, the delete will be blocked (BR-UO-005).
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button onClick={() => setDeleteUomId(null)} style={{ padding: "6px 14px", fontSize: "12px", background: "transparent", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit" }}>Cancel</button>
              <button onClick={handleDeleteUom} disabled={deletingUom} style={{ padding: "6px 14px", fontSize: "12px", background: "#ef4444", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: deletingUom ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: deletingUom ? 0.7 : 1 }}>
                {deletingUom ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
