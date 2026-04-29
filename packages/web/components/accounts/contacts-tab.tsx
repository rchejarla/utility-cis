"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Unified Contacts tab on an account-detail page. The list is a
 * UNION of:
 *
 *   - Record-only Contact rows (no portal access).
 *   - CisUser + UserRole rows for this account (anyone with portal
 *     permissions on this specific account).
 *
 * Inline role assignment drives state transitions between the two:
 *   - Promote a contact → pick a role → POST /contacts/:id/promote
 *     creates a CisUser + UserRole and deletes the source Contact.
 *   - Change a portal user's role → PATCH /user-roles/:id.
 *   - Revoke → DELETE /user-roles/:id (CisUser stays; only the
 *     per-account assignment is removed).
 *
 * Slice 2 implements promote-as-immediate (the user can dev-log-in
 * by email right after). Slice 3 will gate this behind a real
 * email-invite + password-setup flow.
 */

interface UnifiedRow {
  rowId: string;
  type: "contact" | "user";
  contactId: string | null;
  userRoleId: string | null;
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  roleId: string | null;
  roleName: string | null;
  inviteStatus: "pending" | "active" | null;
  createdAt: string;
}

interface RoleSummary {
  id: string;
  name: string;
}

interface ContactsTabProps {
  accountId: string;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
  onContactsChanged?: () => void;
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

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--text-muted)",
  marginBottom: "4px",
  fontWeight: 500,
};

const emptyForm = { firstName: "", lastName: "", email: "", phone: "", notes: "" };

export function ContactsTab({
  accountId,
  showForm: showFormProp,
  onShowFormChange,
  onContactsChanged,
}: ContactsTabProps) {
  const { toast } = useToast();
  const [rows, setRows] = useState<UnifiedRow[]>([]);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [showFormLocal, setShowFormLocal] = useState(false);
  const showForm = showFormProp ?? showFormLocal;
  const setShowForm = (v: boolean) => {
    setShowFormLocal(v);
    onShowFormChange?.(v);
  };

  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);

  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ ...emptyForm });
  const [editSaving, setEditSaving] = useState(false);

  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [pickedRoleId, setPickedRoleId] = useState<string>("");

  const [deleteId, setDeleteId] = useState<{ kind: "contact" | "userRole"; id: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchRows = useCallback(async () => {
    try {
      const res = await apiClient.get<{ data: UnifiedRow[] }>(
        `/api/v1/accounts/${accountId}/contacts-unified`,
      );
      setRows(res.data ?? []);
    } catch (err) {
      console.error("Failed to load contacts", err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await apiClient.get<RoleSummary[]>("/api/v1/auth/roles");
      setRoles(Array.isArray(res) ? res : []);
    } catch (err) {
      console.error("Failed to load roles", err);
    }
  }, []);

  useEffect(() => {
    fetchRows();
    fetchRoles();
  }, [fetchRows, fetchRoles]);

  const refreshAll = async () => {
    await fetchRows();
    onContactsChanged?.();
  };

  const handleAdd = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast("First name and last name are required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/contacts", {
        accountId,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast("Contact added", "success");
      setShowForm(false);
      setForm({ ...emptyForm });
      await refreshAll();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to add contact", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const startEditContact = (row: UnifiedRow) => {
    if (row.type !== "contact" || !row.contactId) return;
    setEditingContactId(row.contactId);
    setEditForm({
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email ?? "",
      phone: row.phone ?? "",
      notes: row.notes ?? "",
    });
  };

  const cancelEdit = () => {
    setEditingContactId(null);
    setEditForm({ ...emptyForm });
  };

  const saveContactEdit = async () => {
    if (!editingContactId) return;
    if (!editForm.firstName.trim() || !editForm.lastName.trim()) {
      toast("First name and last name are required", "error");
      return;
    }
    setEditSaving(true);
    try {
      await apiClient.patch(`/api/v1/contacts/${editingContactId}`, {
        firstName: editForm.firstName.trim(),
        lastName: editForm.lastName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        notes: editForm.notes.trim() || null,
      });
      toast("Contact updated", "success");
      setEditingContactId(null);
      await refreshAll();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to update contact", "error");
    } finally {
      setEditSaving(false);
    }
  };

  const handlePromote = async (row: UnifiedRow) => {
    if (!row.contactId || !pickedRoleId) return;
    if (!row.email) {
      toast("Add an email to this contact before granting a role", "error");
      return;
    }
    try {
      await apiClient.post(`/api/v1/contacts/${row.contactId}/promote`, {
        roleId: pickedRoleId,
      });
      toast("Role granted — contact is now a portal user", "success");
      setPromotingId(null);
      setPickedRoleId("");
      await refreshAll();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Promotion failed", "error");
    }
  };

  const changeUserRole = async (row: UnifiedRow, newRoleId: string) => {
    if (!row.userRoleId || newRoleId === row.roleId) return;
    try {
      await apiClient.patch(`/api/v1/user-roles/${row.userRoleId}`, { roleId: newRoleId });
      toast("Role updated", "success");
      await refreshAll();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Role change failed", "error");
    }
  };

  const handleRevoke = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      if (deleteId.kind === "contact") {
        await apiClient.delete(`/api/v1/contacts/${deleteId.id}`);
        toast("Contact deleted", "success");
      } else {
        await apiClient.delete(`/api/v1/user-roles/${deleteId.id}`);
        toast("Access revoked", "success");
      }
      setDeleteId(null);
      await refreshAll();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed", "error");
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div style={{ color: "var(--text-muted)", padding: "20px 0" }}>Loading…</div>;

  return (
    <div>
      {showForm && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--accent-primary)",
            borderRadius: "var(--radius, 10px)",
            padding: "20px",
            marginBottom: "16px",
          }}
        >
          <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "16px" }}>
            Add Contact
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div><div style={fieldLabelStyle}>First Name *</div><input style={inputStyle} value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} /></div>
            <div><div style={fieldLabelStyle}>Last Name *</div><input style={inputStyle} value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} /></div>
            <div><div style={fieldLabelStyle}>Email</div><input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Required if you'll grant portal access" /></div>
            <div><div style={fieldLabelStyle}>Phone</div><input style={inputStyle} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></div>
            <div style={{ gridColumn: "1 / -1" }}><div style={fieldLabelStyle}>Notes</div><input style={inputStyle} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder='e.g. "Spare key with neighbor"' /></div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button onClick={() => { setShowForm(false); setForm({ ...emptyForm }); }} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>Cancel</button>
            <button onClick={handleAdd} disabled={submitting} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", opacity: submitting ? 0.7 : 1 }}>{submitting ? "Adding..." : "Add Contact"}</button>
          </div>
        </div>
      )}

      <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              {["Name", "Email", "Phone / Notes", "Access", "Actions"].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: "48px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>No one is on file for this account yet.</td></tr>
            ) : (
              rows.map((row) => {
                const isEditingContact = editingContactId === row.contactId;
                const isPromoting = promotingId === row.contactId;
                return (
                  <tr key={row.rowId} style={{ background: isEditingContact ? "var(--bg-elevated)" : "transparent" }}>
                    <td style={tdStyle}>
                      {isEditingContact ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <input style={{ ...inputStyle, width: 110 }} value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} />
                          <input style={{ ...inputStyle, width: 110 }} value={editForm.lastName} onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} />
                        </div>
                      ) : (
                        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{row.firstName} {row.lastName}</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {isEditingContact ? (
                        <input style={{ ...inputStyle, width: 200 }} type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
                      ) : (
                        row.email ?? <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>
                      {isEditingContact ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <input style={{ ...inputStyle, width: 140 }} value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Phone" />
                          <input style={{ ...inputStyle, width: "100%" }} value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Notes" />
                        </div>
                      ) : (
                        <>
                          {row.phone && <div>{row.phone}</div>}
                          {row.notes && <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>{row.notes}</div>}
                          {!row.phone && !row.notes && <span style={{ color: "var(--text-muted)" }}>—</span>}
                        </>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {row.type === "user" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <select
                            style={{ ...inputStyle, width: 180 }}
                            value={row.roleId ?? ""}
                            onChange={(e) => changeUserRole(row, e.target.value)}
                          >
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                          {row.inviteStatus === "pending" && (
                            <span style={{ fontSize: 10, fontWeight: 600, color: "var(--warning)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                              Invited — has not logged in
                            </span>
                          )}
                        </div>
                      ) : isPromoting ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <select
                            style={{ ...inputStyle, width: 160 }}
                            value={pickedRoleId}
                            onChange={(e) => setPickedRoleId(e.target.value)}
                          >
                            <option value="">Select role…</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                          </select>
                          <button onClick={() => handlePromote(row)} disabled={!pickedRoleId} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 10px", opacity: pickedRoleId ? 1 : 0.5 }}>Grant</button>
                          <button onClick={() => { setPromotingId(null); setPickedRoleId(""); }} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}>×</button>
                        </div>
                      ) : (
                        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Record only</span>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {isEditingContact ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={cancelEdit} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}>Cancel</button>
                          <button onClick={saveContactEdit} disabled={editSaving} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 10px", opacity: editSaving ? 0.7 : 1 }}>{editSaving ? "Saving..." : "Save"}</button>
                        </div>
                      ) : row.type === "contact" ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => startEditContact(row)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}>Edit</button>
                          {!isPromoting && row.email && (
                            <button onClick={() => { setPromotingId(row.contactId!); setPickedRoleId(""); }} style={{ ...btnStyle, background: "transparent", color: "var(--accent-primary)", border: "1px solid var(--accent-primary)", padding: "4px 10px" }}>+ Grant access</button>
                          )}
                          <button onClick={() => setDeleteId({ kind: "contact", id: row.contactId! })} style={{ ...btnStyle, background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", padding: "4px 10px" }}>Delete</button>
                        </div>
                      ) : (
                        <button onClick={() => setDeleteId({ kind: "userRole", id: row.userRoleId! })} style={{ ...btnStyle, background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", padding: "4px 10px" }}>Revoke</button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {deleteId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "400px", width: "100%" }}>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>
              {deleteId.kind === "contact" ? "Delete contact?" : "Revoke access?"}
            </div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              {deleteId.kind === "contact"
                ? "This contact will be removed from the account. This cannot be undone."
                : "The user will lose their portal access on this account. They keep access to other accounts and the operator can re-grant access later."}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button onClick={() => setDeleteId(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>Cancel</button>
              <button onClick={handleRevoke} disabled={deleting} style={{ ...btnStyle, background: "var(--danger)", color: "#fff", opacity: deleting ? 0.7 : 1 }}>
                {deleting ? "Working..." : deleteId.kind === "contact" ? "Delete" : "Revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "10px 16px",
  textAlign: "left",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: "13px",
  verticalAlign: "top",
};
