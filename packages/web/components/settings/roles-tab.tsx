"use client";

import React, { useEffect, useState, useCallback } from "react";
import { PermissionMatrix } from "./permission-matrix";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

interface Role {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: Record<string, string[]>;
  _count?: { users: number };
}

interface RolesTabProps {
  showAddForm?: boolean;
  onAddFormClose?: () => void;
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: "13px",
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius, 10px)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
};

const btnStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 500,
  border: "none",
  borderRadius: "var(--radius, 10px)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const fieldLabel: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--text-muted)",
  marginBottom: "4px",
  fontWeight: 500,
};

const emptyForm = { name: "", description: "", permissions: {} as Record<string, string[]> };

export function RolesTab({ showAddForm, onAddFormClose }: RolesTabProps) {
  const { toast } = useToast();
  const { canCreate, canEdit, canDelete } = usePermission("settings");

  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<Record<string, string[]> | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [showFormLocal, setShowFormLocal] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);

  const isFormOpen = showAddForm ?? showFormLocal;

  const fetchRoles = useCallback(async () => {
    try {
      const res = await apiClient.get<Role[] | { data: Role[] }>("/api/v1/roles");
      setRoles(Array.isArray(res) ? res : res.data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load roles";
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  const handleCloseForm = () => {
    setShowFormLocal(false);
    setForm({ ...emptyForm });
    onAddFormClose?.();
  };

  const handleAddRole = async () => {
    if (!form.name.trim()) {
      toast("Role name is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/roles", {
        name: form.name.trim(),
        description: form.description.trim() || null,
        permissions: form.permissions,
      });
      toast("Role created successfully", "success");
      handleCloseForm();
      fetchRoles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create role";
      toast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleExpand = (role: Role) => {
    if (expandedId === role.id) {
      setExpandedId(null);
      setEditingPermissions(null);
    } else {
      setExpandedId(role.id);
      setEditingPermissions(!role.isSystem ? { ...role.permissions } : null);
    }
  };

  const handleSavePermissions = async (roleId: string) => {
    if (!editingPermissions) return;
    setSavingId(roleId);
    try {
      await apiClient.patch(`/api/v1/roles/${roleId}`, { permissions: editingPermissions });
      toast("Permissions updated", "success");
      fetchRoles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update permissions";
      toast(msg, "error");
    } finally {
      setSavingId(null);
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    setDeletingId(roleId);
    try {
      await apiClient.delete(`/api/v1/roles/${roleId}`);
      toast("Role deleted", "success");
      setConfirmDeleteId(null);
      if (expandedId === roleId) setExpandedId(null);
      fetchRoles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete role";
      toast(msg, "error");
    } finally {
      setDeletingId(null);
    }
  };

  const getUserCount = (role: Role) => role._count?.users ?? 0;

  return (
    <div>
      {/* Add Role Form */}
      {isFormOpen && canCreate && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius, 10px)",
            padding: "20px",
            marginBottom: "16px",
          }}
        >
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "16px",
            }}
          >
            Add Role
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px", marginBottom: "16px" }}>
            <div>
              <div style={fieldLabel}>Name *</div>
              <input
                style={inputStyle}
                placeholder="e.g. Billing Manager"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <div style={fieldLabel}>Description</div>
              <input
                style={inputStyle}
                placeholder="Brief description of this role..."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>

          <div style={{ marginBottom: "16px" }}>
            <div style={{ ...fieldLabel, marginBottom: "10px" }}>Permissions</div>
            <PermissionMatrix
              permissions={form.permissions}
              onChange={(perms) => setForm((f) => ({ ...f, permissions: perms }))}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              onClick={handleCloseForm}
              style={{
                ...btnStyle,
                background: "transparent",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleAddRole}
              disabled={submitting}
              style={{
                ...btnStyle,
                background: "var(--accent-primary)",
                color: "#fff",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Creating..." : "Create Role"}
            </button>
          </div>
        </div>
      )}

      {/* Roles Table */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: "22%" }} />
            <col style={{ width: "35%" }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "10%" }} />
            {(canEdit || canDelete) && <col style={{ width: "19%" }} />}
          </colgroup>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              {["Name", "Description", "Type", "Users", ...((canEdit || canDelete) ? [""] : [])].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 16px",
                    textAlign: "left",
                    fontSize: "11px",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-muted)",
                    borderBottom: "1px solid var(--border)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: (canEdit || canDelete) ? 5 : 4 }).map((_, j) => (
                    <td key={j} style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
                      <div
                        style={{
                          height: "14px",
                          borderRadius: "4px",
                          background: "var(--bg-elevated)",
                          width: "70%",
                          animation: "pulse 1.5s ease-in-out infinite",
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))
            ) : roles.length === 0 ? (
              <tr>
                <td
                  colSpan={(canEdit || canDelete) ? 5 : 4}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: "14px",
                  }}
                >
                  No roles found
                </td>
              </tr>
            ) : (
              roles.map((role) => {
                const isExpanded = expandedId === role.id;
                const userCount = getUserCount(role);
                const cellStyle: React.CSSProperties = {
                  padding: "12px 16px",
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  borderBottom: isExpanded ? "none" : "1px solid var(--border-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  verticalAlign: "middle",
                };

                return (
                  <React.Fragment key={role.id}>
                    <tr
                      style={{
                        cursor: "pointer",
                        background: isExpanded ? "var(--bg-elevated)" : "transparent",
                        transition: "background 0.1s ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!isExpanded)
                          (e.currentTarget as HTMLTableRowElement).style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isExpanded)
                          (e.currentTarget as HTMLTableRowElement).style.background = "transparent";
                      }}
                      onClick={() => handleToggleExpand(role)}
                    >
                      <td style={cellStyle}>
                        <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span
                            style={{
                              fontSize: "10px",
                              color: "var(--text-muted)",
                              transition: "transform 0.15s",
                              display: "inline-block",
                              transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                            }}
                          >
                            ▶
                          </span>
                          {role.name}
                        </span>
                      </td>
                      <td style={{ ...cellStyle, color: "var(--text-secondary)", fontSize: "12px" }}>
                        {role.description || "—"}
                      </td>
                      <td style={cellStyle}>
                        <SystemBadge isSystem={role.isSystem} />
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          fontSize: "12px",
                          fontFamily: "monospace",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {userCount}
                      </td>
                      {(canEdit || canDelete) && (
                        <td
                          style={{ ...cellStyle, textAlign: "right" }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}>
                            {canDelete && !role.isSystem && (
                              <>
                                {confirmDeleteId === role.id ? (
                                  <>
                                    <button
                                      onClick={() => handleDeleteRole(role.id)}
                                      disabled={deletingId === role.id}
                                      style={{
                                        ...btnStyle,
                                        padding: "4px 10px",
                                        background: "var(--danger-subtle)",
                                        color: "var(--danger)",
                                        border: "1px solid var(--danger)",
                                        opacity: deletingId === role.id ? 0.7 : 1,
                                      }}
                                    >
                                      {deletingId === role.id ? "Deleting..." : "Confirm"}
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(null)}
                                      style={{
                                        ...btnStyle,
                                        padding: "4px 10px",
                                        background: "transparent",
                                        color: "var(--text-secondary)",
                                        border: "1px solid var(--border)",
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => setConfirmDeleteId(role.id)}
                                    disabled={userCount > 0}
                                    title={userCount > 0 ? "Cannot delete: users are assigned to this role" : "Delete role"}
                                    style={{
                                      ...btnStyle,
                                      padding: "4px 10px",
                                      background: "transparent",
                                      color: "var(--text-muted)",
                                      border: "1px solid var(--border)",
                                      opacity: userCount > 0 ? 0.4 : 1,
                                      cursor: userCount > 0 ? "not-allowed" : "pointer",
                                    }}
                                    onMouseEnter={(e) => {
                                      if (userCount === 0) {
                                        (e.currentTarget as HTMLButtonElement).style.color = "var(--danger)";
                                        (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--danger)";
                                      }
                                    }}
                                    onMouseLeave={(e) => {
                                      (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                                      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                                    }}
                                  >
                                    Delete
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>

                    {/* Expanded row: Permission Matrix */}
                    {isExpanded && (
                      <tr>
                        <td
                          colSpan={(canEdit || canDelete) ? 5 : 4}
                          style={{ padding: "0", borderBottom: "1px solid var(--border-subtle)" }}
                        >
                          <div
                            style={{
                              padding: "16px 20px 20px",
                              background: "var(--bg-deep)",
                              borderTop: "1px solid var(--border)",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                marginBottom: "12px",
                              }}
                            >
                              <span
                                style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}
                              >
                                Permissions — {role.name}
                              </span>
                              {role.isSystem ? (
                                <span
                                  style={{
                                    fontSize: "11px",
                                    color: "var(--text-muted)",
                                    fontStyle: "italic",
                                  }}
                                >
                                  System role — read-only
                                </span>
                              ) : canEdit ? (
                                <div style={{ display: "flex", gap: "8px" }}>
                                  <button
                                    onClick={() => {
                                      setEditingPermissions({ ...role.permissions });
                                    }}
                                    style={{
                                      ...btnStyle,
                                      padding: "4px 12px",
                                      background: "transparent",
                                      color: "var(--text-secondary)",
                                      border: "1px solid var(--border)",
                                    }}
                                  >
                                    Reset
                                  </button>
                                  <button
                                    onClick={() => handleSavePermissions(role.id)}
                                    disabled={savingId === role.id}
                                    style={{
                                      ...btnStyle,
                                      padding: "4px 12px",
                                      background: "var(--accent-primary)",
                                      color: "#fff",
                                      opacity: savingId === role.id ? 0.7 : 1,
                                    }}
                                  >
                                    {savingId === role.id ? "Saving..." : "Save Changes"}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                            <PermissionMatrix
                              permissions={role.isSystem ? role.permissions : (editingPermissions ?? role.permissions)}
                              onChange={(perms) => setEditingPermissions(perms)}
                              readOnly={role.isSystem || !canEdit}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SystemBadge({ isSystem }: { isSystem: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "999px",
        fontSize: "11px",
        fontWeight: 500,
        whiteSpace: "nowrap",
        background: isSystem ? "rgba(245,158,11,0.12)" : "rgba(59,130,246,0.12)",
        color: isSystem ? "#fbbf24" : "#60a5fa",
      }}
    >
      {isSystem ? "System" : "Custom"}
    </span>
  );
}
