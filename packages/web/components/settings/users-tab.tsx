"use client";

import React, { useEffect, useState, useCallback } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

interface Role {
  id: string;
  name: string;
  isSystem: boolean;
}

interface User {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: string | null;
  roleId: string;
  role?: { id: string; name: string };
}

interface UsersTabProps {
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

const emptyForm = { email: "", name: "", roleId: "", isActive: true };

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

export function UsersTab({ showAddForm, onAddFormClose }: UsersTabProps) {
  const { toast } = useToast();
  const { canCreate, canEdit } = usePermission("settings");

  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [showFormLocal, setShowFormLocal] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ roleId: string; isActive: boolean }>({
    roleId: "",
    isActive: true,
  });

  const isFormOpen = showAddForm ?? showFormLocal;

  const fetchData = useCallback(async () => {
    try {
      const [usersRes, rolesRes] = await Promise.all([
        apiClient.get<{ data: User[] }>("/api/v1/users"),
        apiClient.get<{ data: Role[] }>("/api/v1/roles"),
      ]);
      setUsers(usersRes.data ?? []);
      setRoles(rolesRes.data ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load data";
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCloseForm = () => {
    setShowFormLocal(false);
    setForm({ ...emptyForm });
    onAddFormClose?.();
  };

  const handleAddUser = async () => {
    if (!form.email.trim()) {
      toast("Email is required", "error");
      return;
    }
    if (!form.name.trim()) {
      toast("Name is required", "error");
      return;
    }
    if (!form.roleId) {
      toast("Role is required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/users", {
        email: form.email.trim(),
        name: form.name.trim(),
        roleId: form.roleId,
        isActive: form.isActive,
      });
      toast("User created successfully", "success");
      handleCloseForm();
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create user";
      toast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartEdit = (user: User) => {
    setEditingId(user.id);
    setEditForm({ roleId: user.roleId, isActive: user.isActive });
  };

  const handleSaveEdit = async (userId: string) => {
    setSubmitting(true);
    try {
      await apiClient.patch(`/api/v1/users/${userId}`, {
        roleId: editForm.roleId,
        isActive: editForm.isActive,
      });
      toast("User updated successfully", "success");
      setEditingId(null);
      fetchData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update user";
      toast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = users.filter(
    (u) =>
      search === "" ||
      u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  const getRoleName = (user: User) =>
    user.role?.name ?? roles.find((r) => r.id === user.roleId)?.name ?? "—";

  return (
    <div>
      {/* Search */}
      <div style={{ marginBottom: "16px" }}>
        <input
          style={{ ...inputStyle, maxWidth: "320px" }}
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Add User Form */}
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
            Add User
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr auto",
              gap: "12px",
              alignItems: "end",
              marginBottom: "16px",
            }}
          >
            <div>
              <div style={fieldLabel}>Email *</div>
              <input
                style={inputStyle}
                type="email"
                placeholder="user@example.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div>
              <div style={fieldLabel}>Name *</div>
              <input
                style={inputStyle}
                placeholder="Full name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <div style={fieldLabel}>Role *</div>
              <select
                style={inputStyle}
                value={form.roleId}
                onChange={(e) => setForm((f) => ({ ...f, roleId: e.target.value }))}
              >
                <option value="">Select role...</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div style={fieldLabel}>Active</div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  cursor: "pointer",
                  height: "32px",
                }}
              >
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                  style={{ width: "14px", height: "14px", accentColor: "var(--accent-primary)" }}
                />
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {form.isActive ? "Active" : "Inactive"}
                </span>
              </label>
            </div>
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
              onClick={handleAddUser}
              disabled={submitting}
              style={{
                ...btnStyle,
                background: "var(--accent-primary)",
                color: "#fff",
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? "Adding..." : "Add User"}
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
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
            <col style={{ width: "20%" }} />
            <col style={{ width: "25%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "15%" }} />
            {canEdit && <col style={{ width: "10%" }} />}
          </colgroup>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              {["Name", "Email", "Role", "Status", "Last Login", ...(canEdit ? [""] : [])].map(
                (h) => (
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
                )
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: canEdit ? 6 : 5 }).map((_, j) => (
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
            ) : filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={canEdit ? 6 : 5}
                  style={{
                    padding: "48px 16px",
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: "14px",
                  }}
                >
                  {search ? "No users match your search" : "No users found"}
                </td>
              </tr>
            ) : (
              filtered.map((user) => {
                const isEditing = editingId === user.id;
                const cellStyle: React.CSSProperties = {
                  padding: "12px 16px",
                  fontSize: "13px",
                  color: "var(--text-primary)",
                  borderBottom: "1px solid var(--border-subtle)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                };
                return (
                  <tr
                    key={user.id}
                    style={{ background: isEditing ? "rgba(var(--accent-rgb),0.04)" : "transparent" }}
                  >
                    <td style={cellStyle}>{user.name}</td>
                    <td
                      style={{
                        ...cellStyle,
                        fontSize: "12px",
                        color: "var(--text-secondary)",
                        fontFamily: "monospace",
                      }}
                    >
                      {user.email}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <select
                          style={{ ...inputStyle, width: "100%" }}
                          value={editForm.roleId}
                          onChange={(e) =>
                            setEditForm((f) => ({ ...f, roleId: e.target.value }))
                          }
                        >
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <RoleBadge name={getRoleName(user)} isSystem={roles.find(r => r.id === user.roleId)?.isSystem} />
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={editForm.isActive}
                            onChange={(e) =>
                              setEditForm((f) => ({ ...f, isActive: e.target.checked }))
                            }
                            style={{ accentColor: "var(--accent-primary)" }}
                          />
                          <span style={{ fontSize: "12px" }}>
                            {editForm.isActive ? "Active" : "Inactive"}
                          </span>
                        </label>
                      ) : (
                        <StatusBadge status={user.isActive ? "active" : "inactive"} />
                      )}
                    </td>
                    <td style={{ ...cellStyle, fontSize: "12px", color: "var(--text-secondary)" }}>
                      {formatDate(user.lastLoginAt)}
                    </td>
                    {canEdit && (
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {isEditing ? (
                          <div style={{ display: "flex", gap: "4px", justifyContent: "flex-end" }}>
                            <button
                              onClick={() => handleSaveEdit(user.id)}
                              disabled={submitting}
                              style={{
                                ...btnStyle,
                                padding: "4px 10px",
                                background: "var(--accent-primary)",
                                color: "#fff",
                                opacity: submitting ? 0.7 : 1,
                              }}
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
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
                          </div>
                        ) : (
                          <button
                            onClick={() => handleStartEdit(user)}
                            style={{
                              ...btnStyle,
                              padding: "4px 10px",
                              background: "transparent",
                              color: "var(--text-secondary)",
                              border: "1px solid var(--border)",
                            }}
                            onMouseEnter={(e) => {
                              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-primary)";
                              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent-primary)";
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
                              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                            }}
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleBadge({ name, isSystem }: { name: string; isSystem?: boolean }) {
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
        background: isSystem
          ? "rgba(245,158,11,0.12)"
          : "rgba(59,130,246,0.12)",
        color: isSystem ? "#fbbf24" : "#60a5fa",
      }}
    >
      {name}
    </span>
  );
}
