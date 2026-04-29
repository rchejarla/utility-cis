"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Record-only contacts on an account: people on file (next of kin,
 * site manager, neighbor with a key, etc.) who do NOT have portal
 * access. Anyone with portal permissions is represented by a
 * CisUser + UserRole row instead — Slice 2 will turn this tab into a
 * unified list that mixes both sources, plus inline role assignment
 * with an invite flow.
 *
 * For now this is straight CRUD over name/email/phone/notes.
 */

interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

interface ContactsTabProps {
  accountId: string;
  contacts: Contact[];
  onContactsChanged: () => void;
  showForm?: boolean;
  onShowFormChange?: (show: boolean) => void;
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

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  notes: "",
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ ...emptyForm });
  const [editSaving, setEditSaving] = useState(false);

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
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast("Contact added", "success");
      setShowForm(false);
      setForm({ ...emptyForm });
      onContactsChanged();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to add contact", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (contact: Contact) => {
    setEditingId(contact.id);
    setEditForm({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      notes: contact.notes ?? "",
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
        firstName: editForm.firstName.trim(),
        lastName: editForm.lastName.trim(),
        email: editForm.email.trim() || null,
        phone: editForm.phone.trim() || null,
        notes: editForm.notes.trim() || null,
      });
      toast("Contact updated", "success");
      setEditingId(null);
      onContactsChanged();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to update contact", "error");
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
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : "Failed to delete contact", "error");
    } finally {
      setDeleting(false);
    }
  };

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
            <div>
              <div style={fieldLabelStyle}>First Name *</div>
              <input style={inputStyle} value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} placeholder="First name" />
            </div>
            <div>
              <div style={fieldLabelStyle}>Last Name *</div>
              <input style={inputStyle} value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} placeholder="Last name" />
            </div>
            <div>
              <div style={fieldLabelStyle}>Email</div>
              <input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="Optional" />
            </div>
            <div>
              <div style={fieldLabelStyle}>Phone</div>
              <input style={inputStyle} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="Optional" />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={fieldLabelStyle}>Notes</div>
              <input style={inputStyle} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder='e.g. "Spare key with neighbor at #4"' />
            </div>
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
              {["Name", "Email", "Phone", "Notes", "Actions"].map((h) => (
                <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ padding: "48px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>
                  No contacts on file.
                </td>
              </tr>
            ) : (
              contacts.map((contact) => {
                const isEditing = editingId === contact.id;
                return (
                  <tr key={contact.id} style={{ background: isEditing ? "var(--bg-elevated)" : "transparent" }}>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-primary)" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <input style={{ ...inputStyle, width: "120px" }} value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} placeholder="First" />
                          <input style={{ ...inputStyle, width: "120px" }} value={editForm.lastName} onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} placeholder="Last" />
                        </div>
                      ) : (
                        `${contact.firstName} ${contact.lastName}`
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-secondary)" }}>
                      {isEditing ? (
                        <input style={{ ...inputStyle, width: "200px" }} type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
                      ) : (
                        contact.email ?? "—"
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-secondary)" }}>
                      {isEditing ? (
                        <input style={{ ...inputStyle, width: "140px" }} value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
                      ) : (
                        contact.phone ?? "—"
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px", color: "var(--text-secondary)", maxWidth: "260px" }}>
                      {isEditing ? (
                        <input style={{ ...inputStyle, width: "100%" }} value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                      ) : (
                        contact.notes ?? "—"
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-subtle)", fontSize: "13px" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button onClick={cancelEdit} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}>Cancel</button>
                          <button onClick={handleSaveEdit} disabled={editSaving} style={{ ...btnStyle, background: "var(--accent-primary)", color: "#fff", padding: "4px 10px", opacity: editSaving ? 0.7 : 1 }}>{editSaving ? "Saving..." : "Save"}</button>
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button onClick={() => startEdit(contact)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}>Edit</button>
                          <button onClick={() => setDeleteId(contact.id)} style={{ ...btnStyle, background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)", padding: "4px 10px" }}>Delete</button>
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

      {deleteId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "24px", maxWidth: "380px", width: "100%" }}>
            <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "8px" }}>Delete Contact?</div>
            <div style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px", lineHeight: 1.5 }}>
              Delete this contact? This cannot be undone.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button onClick={() => setDeleteId(null)} style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)" }}>Cancel</button>
              <button onClick={handleDelete} disabled={deleting} style={{ ...btnStyle, background: "var(--danger)", color: "#fff", opacity: deleting ? 0.7 : 1 }}>{deleting ? "Deleting..." : "Delete"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
