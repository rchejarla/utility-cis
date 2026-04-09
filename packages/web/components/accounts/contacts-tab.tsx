"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface Contact {
  id: string;
  role: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  isPrimary: boolean;
}

interface ContactsTabProps {
  accountId: string;
  contacts: Contact[];
  onContactsChanged: () => void;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
}

const CONTACT_ROLES = ["PRIMARY", "BILLING", "AUTHORIZED", "EMERGENCY"] as const;

const roleBadgeStyle = (role: string): React.CSSProperties => {
  const colors: Record<string, { bg: string; color: string }> = {
    PRIMARY: { bg: "rgba(59,130,246,0.15)", color: "#60a5fa" },
    BILLING: { bg: "rgba(245,158,11,0.15)", color: "#fbbf24" },
    AUTHORIZED: { bg: "rgba(139,92,246,0.15)", color: "#a78bfa" },
    EMERGENCY: { bg: "rgba(239,68,68,0.15)", color: "#f87171" },
  };
  const c = colors[role] ?? { bg: "rgba(100,100,100,0.15)", color: "var(--text-muted)" };
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontWeight: 600,
    background: c.bg,
    color: c.color,
    letterSpacing: "0.04em",
  };
};

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

const emptyForm = {
  role: "PRIMARY" as string,
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  isPrimary: false,
};

export function ContactsTab({
  accountId,
  contacts,
  onContactsChanged,
  showForm: showFormProp,
  onShowFormChange,
}: ContactsTabProps) {
  const { toast } = useToast();
  const [showFormLocal, setShowFormLocal] = useState(false);
  const showForm = showFormProp ?? showFormLocal;
  const setShowForm = (v: boolean) => {
    setShowFormLocal(v);
    onShowFormChange?.(v);
  };

  const [form, setForm] = useState({ ...emptyForm });
  const [submitting, setSubmitting] = useState(false);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ ...emptyForm });
  const [editSaving, setEditSaving] = useState(false);

  // Delete confirm state
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleAdd = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast("First name and last name are required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/contacts", {
        accountId,
        role: form.role,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        isPrimary: form.isPrimary,
      });
      toast("Contact added successfully", "success");
      setShowForm(false);
      setForm({ ...emptyForm });
      onContactsChanged();
    } catch (err: any) {
      toast(err.message || "Failed to add contact", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (contact: Contact) => {
    setEditingId(contact.id);
    setEditForm({
      role: contact.role,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      isPrimary: contact.isPrimary,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ ...emptyForm });
  };

  const handleSaveEdit = async () => {
    if (!editForm.firstName.trim() || !editForm.lastName.trim()) {
      toast("First name and last name are required", "error");
      return;
    }
    setEditSaving(true);
    try {
      await apiClient.patch(`/api/v1/contacts/${editingId}`, {
        role: editForm.role,
        firstName: editForm.firstName.trim(),
        lastName: editForm.lastName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        isPrimary: editForm.isPrimary,
      });
      toast("Contact updated", "success");
      setEditingId(null);
      onContactsChanged();
    } catch (err: any) {
      toast(err.message || "Failed to update contact", "error");
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/v1/contacts/${deleteId}`);
      toast("Contact deleted", "success");
      setDeleteId(null);
      onContactsChanged();
    } catch (err: any) {
      toast(err.message || "Failed to delete contact", "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* Add Contact Form */}
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

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={fieldLabelStyle}>Role *</div>
              <select
                style={inputStyle}
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              >
                {CONTACT_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div>
              <div style={fieldLabelStyle}>First Name *</div>
              <input
                style={inputStyle}
                value={form.firstName}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                placeholder="First name"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Last Name *</div>
              <input
                style={inputStyle}
                value={form.lastName}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                placeholder="Last name"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Email</div>
              <input
                style={inputStyle}
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Phone</div>
              <input
                style={inputStyle}
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="Optional"
              />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: "2px" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))}
                  style={{ accentColor: "var(--accent-primary)" }}
                />
                Primary Contact
              </label>
            </div>
          </div>

          <div style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
            BR-CT-003: Contacts can be deleted (unlike other entities)
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
            <button
              onClick={() => { setShowForm(false); setForm({ ...emptyForm }); }}
              style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={submitting}
              style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", opacity: submitting ? 0.7 : 1 }}
            >
              {submitting ? "Adding..." : "Add Contact"}
            </button>
          </div>
        </div>
      )}

      {/* Contacts Table */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "var(--bg-elevated)" }}>
              {["Role", "Name", "Email", "Phone", "Primary", "Actions"].map((h) => (
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
            {contacts.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "48px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>
                  No contacts found
                </td>
              </tr>
            ) : (
              contacts.map((contact) => {
                const isEditing = editingId === contact.id;
                return (
                  <tr
                    key={contact.id}
                    style={{ background: isEditing ? "var(--bg-elevated)" : "transparent" }}
                  >
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                      {isEditing ? (
                        <select
                          style={{ ...inputStyle, width: "140px" }}
                          value={editForm.role}
                          onChange={(e) => setEditForm((f) => ({ ...f, role: e.target.value }))}
                        >
                          {CONTACT_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      ) : (
                        <span style={roleBadgeStyle(contact.role)}>{contact.role}</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-primary)" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <input
                            style={{ ...inputStyle, width: "120px" }}
                            value={editForm.firstName}
                            onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                            placeholder="First"
                          />
                          <input
                            style={{ ...inputStyle, width: "120px" }}
                            value={editForm.lastName}
                            onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                            placeholder="Last"
                          />
                        </div>
                      ) : (
                        `${contact.firstName} ${contact.lastName}`
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-secondary)" }}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "180px" }}
                          type="email"
                          value={editForm.email}
                          onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                          placeholder="Email"
                        />
                      ) : (
                        contact.email ?? "—"
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-secondary)" }}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "140px" }}
                          value={editForm.phone}
                          onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                          placeholder="Phone"
                        />
                      ) : (
                        contact.phone ?? "—"
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={editForm.isPrimary}
                          onChange={(e) => setEditForm((f) => ({ ...f, isPrimary: e.target.checked }))}
                          style={{ accentColor: "var(--accent-primary)" }}
                        />
                      ) : (
                        contact.isPrimary ? (
                          <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>—</span>
                        )
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            onClick={cancelEdit}
                            style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={handleSaveEdit}
                            disabled={editSaving}
                            style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 10px", opacity: editSaving ? 0.7 : 1 }}
                          >
                            {editSaving ? "Saving..." : "Save"}
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            onClick={() => startEdit(contact)}
                            style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeleteId(contact.id)}
                            style={{ ...btnStyle, background: "transparent", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", padding: "4px 10px" }}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "380px", width: "100%" }}>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Delete Contact?</div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              Delete this contact? This cannot be undone.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                onClick={() => setDeleteId(null)}
                style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={{ ...btnStyle, background: "#ef4444", color: "#fff", opacity: deleting ? 0.7 : 1 }}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
