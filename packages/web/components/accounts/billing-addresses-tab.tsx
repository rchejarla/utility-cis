"use client";

import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

interface BillingAddress {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  isPrimary: boolean;
}

interface BillingAddressesTabProps {
  accountId: string;
  billingAddresses: BillingAddress[];
  onAddressesChanged: () => void;
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
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
  isPrimary: false,
};

export function BillingAddressesTab({
  accountId,
  billingAddresses,
  onAddressesChanged,
  showForm: showFormProp,
  onShowFormChange,
}: BillingAddressesTabProps) {
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

  const handleAdd = async () => {
    if (!form.addressLine1.trim() || !form.city.trim() || !form.state.trim() || !form.zip.trim()) {
      toast("Address Line 1, City, State, and Zip are required", "error");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post("/api/v1/billing-addresses", {
        accountId,
        addressLine1: form.addressLine1.trim(),
        addressLine2: form.addressLine2.trim() || undefined,
        city: form.city.trim(),
        state: form.state.trim(),
        zip: form.zip.trim(),
        country: form.country.trim() || "US",
        isPrimary: form.isPrimary,
      });
      toast("Billing address added successfully", "success");
      setShowForm(false);
      setForm({ ...emptyForm });
      onAddressesChanged();
    } catch (err: any) {
      toast(err.message || "Failed to add billing address", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (addr: BillingAddress) => {
    setEditingId(addr.id);
    setEditForm({
      addressLine1: addr.addressLine1,
      addressLine2: addr.addressLine2 ?? "",
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      country: addr.country,
      isPrimary: addr.isPrimary,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ ...emptyForm });
  };

  const handleSaveEdit = async () => {
    if (!editForm.addressLine1.trim() || !editForm.city.trim() || !editForm.state.trim() || !editForm.zip.trim()) {
      toast("Address Line 1, City, State, and Zip are required", "error");
      return;
    }
    setEditSaving(true);
    try {
      await apiClient.patch(`/api/v1/billing-addresses/${editingId}`, {
        addressLine1: editForm.addressLine1.trim(),
        addressLine2: editForm.addressLine2.trim() || null,
        city: editForm.city.trim(),
        state: editForm.state.trim(),
        zip: editForm.zip.trim(),
        country: editForm.country.trim() || "US",
        isPrimary: editForm.isPrimary,
      });
      toast("Billing address updated", "success");
      setEditingId(null);
      onAddressesChanged();
    } catch (err: any) {
      toast(err.message || "Failed to update billing address", "error");
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <div>
      {/* Add Billing Address Form */}
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
            Add Billing Address
          </div>

          {/* Row 1: Address Line 1, Address Line 2 */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={fieldLabelStyle}>Address Line 1 *</div>
              <input
                style={inputStyle}
                value={form.addressLine1}
                onChange={(e) => setForm((f) => ({ ...f, addressLine1: e.target.value }))}
                placeholder="Street address"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Address Line 2</div>
              <input
                style={inputStyle}
                value={form.addressLine2}
                onChange={(e) => setForm((f) => ({ ...f, addressLine2: e.target.value }))}
                placeholder="Apt, Suite, etc. (optional)"
              />
            </div>
          </div>

          {/* Row 2: City, State, Zip, Country */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "12px", marginBottom: "12px" }}>
            <div>
              <div style={fieldLabelStyle}>City *</div>
              <input
                style={inputStyle}
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="City"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>State *</div>
              <input
                style={inputStyle}
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                placeholder="e.g. TX"
                maxLength={2}
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Zip *</div>
              <input
                style={inputStyle}
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
                placeholder="e.g. 78701"
              />
            </div>
            <div>
              <div style={fieldLabelStyle}>Country</div>
              <input
                style={inputStyle}
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
                placeholder="US"
                maxLength={2}
              />
            </div>
          </div>

          {/* Primary checkbox */}
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "var(--text-primary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.isPrimary}
                onChange={(e) => setForm((f) => ({ ...f, isPrimary: e.target.checked }))}
                style={{ accentColor: "var(--accent-primary)" }}
              />
              Primary Billing Address
            </label>
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
              {submitting ? "Adding..." : "Add Address"}
            </button>
          </div>
        </div>
      )}

      {/* Billing Addresses Table */}
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
              {["Address", "City", "State", "Zip", "Country", "Primary", "Actions"].map((h) => (
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
            {billingAddresses.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: "48px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "14px" }}>
                  No billing addresses found
                </td>
              </tr>
            ) : (
              billingAddresses.map((addr) => {
                const isEditing = editingId === addr.id;
                const cellStyle: React.CSSProperties = {
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: "13px",
                  color: "var(--text-primary)",
                };
                return (
                  <tr
                    key={addr.id}
                    style={{ background: isEditing ? "var(--bg-elevated)" : "transparent" }}
                  >
                    <td style={cellStyle}>
                      {isEditing ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <input
                            style={{ ...inputStyle, minWidth: "200px" }}
                            value={editForm.addressLine1}
                            onChange={(e) => setEditForm((f) => ({ ...f, addressLine1: e.target.value }))}
                            placeholder="Address Line 1"
                          />
                          <input
                            style={{ ...inputStyle, minWidth: "200px" }}
                            value={editForm.addressLine2}
                            onChange={(e) => setEditForm((f) => ({ ...f, addressLine2: e.target.value }))}
                            placeholder="Line 2 (optional)"
                          />
                        </div>
                      ) : (
                        <div>
                          <div>{addr.addressLine1}</div>
                          {addr.addressLine2 && (
                            <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>{addr.addressLine2}</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "100px" }}
                          value={editForm.city}
                          onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                          placeholder="City"
                        />
                      ) : (
                        addr.city
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "60px" }}
                          value={editForm.state}
                          onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))}
                          placeholder="State"
                          maxLength={2}
                        />
                      ) : (
                        addr.state
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "80px" }}
                          value={editForm.zip}
                          onChange={(e) => setEditForm((f) => ({ ...f, zip: e.target.value }))}
                          placeholder="Zip"
                        />
                      ) : (
                        addr.zip
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <input
                          style={{ ...inputStyle, width: "60px" }}
                          value={editForm.country}
                          onChange={(e) => setEditForm((f) => ({ ...f, country: e.target.value }))}
                          placeholder="US"
                          maxLength={2}
                        />
                      ) : (
                        addr.country
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={editForm.isPrimary}
                          onChange={(e) => setEditForm((f) => ({ ...f, isPrimary: e.target.checked }))}
                          style={{ accentColor: "var(--accent-primary)" }}
                        />
                      ) : (
                        addr.isPrimary ? (
                          <span style={{ color: "#4ade80", fontWeight: 600 }}>✓</span>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>—</span>
                        )
                      )}
                    </td>
                    <td style={cellStyle}>
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
                        <button
                          onClick={() => startEdit(addr)}
                          style={{ ...btnStyle, background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border)", padding: "4px 10px" }}
                        >
                          Edit
                        </button>
                      )}
                    </td>
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
