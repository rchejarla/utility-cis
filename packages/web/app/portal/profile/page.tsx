"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/ui/toast";

interface CustomerProfile {
  id: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  customerType: string;
  email?: string;
  phone?: string;
  altPhone?: string;
  status: string;
}

function portalFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const token = localStorage.getItem("portal_token") ?? "";
  return fetch(`http://localhost:3001${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json() as Promise<T>;
  });
}

const fieldStyle = {
  display: "grid" as const,
  gridTemplateColumns: "160px 1fr",
  gap: 8,
  padding: "10px 0",
  borderBottom: "1px solid var(--border-subtle)",
  alignItems: "start" as const,
};
const labelStyle = { fontSize: 12, color: "var(--text-muted)", fontWeight: 500 as const };
const valueStyle = { fontSize: 13, color: "var(--text-primary)" };
const inputStyle = {
  padding: "6px 10px",
  fontSize: 13,
  background: "var(--bg-deep)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-primary)",
  fontFamily: "inherit",
  outline: "none",
  width: "100%",
} as const;

export default function PortalProfilePage() {
  const { toast } = useToast();
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editForm, setEditForm] = useState({ email: "", phone: "", altPhone: "" });

  useEffect(() => {
    portalFetch<{ data: CustomerProfile }>("/portal/api/profile")
      .then((res) => {
        setProfile(res.data);
        setEditForm({
          email: res.data.email ?? "",
          phone: res.data.phone ?? "",
          altPhone: res.data.altPhone ?? "",
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await portalFetch<{ data: CustomerProfile }>("/portal/api/profile", {
        method: "PATCH",
        body: JSON.stringify(editForm),
      });
      setProfile(res.data);
      setEditing(false);
      toast("Profile updated", "success");
    } catch (err) {
      toast("Failed to save profile", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading profile…</p>;
  }

  if (!profile) {
    return <p style={{ color: "var(--danger)", padding: 24 }}>Failed to load profile.</p>;
  }

  const displayName =
    profile.customerType === "ORGANIZATION"
      ? profile.organizationName
      : `${profile.firstName ?? ""} ${profile.lastName ?? ""}`.trim();

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          marginBottom: 24,
          gap: 16,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: "var(--text-primary)",
              margin: "0 0 4px",
            }}
          >
            Profile
          </h1>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0 }}>
            Your contact information
          </p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Edit
          </button>
        )}
      </div>

      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "20px 24px",
          maxWidth: 600,
        }}
      >
        <div style={fieldStyle}>
          <span style={labelStyle}>Name</span>
          <span style={valueStyle}>{displayName || "—"}</span>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Customer type</span>
          <span style={valueStyle}>{profile.customerType}</span>
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Email</span>
          {editing ? (
            <input
              type="email"
              style={inputStyle}
              value={editForm.email}
              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
            />
          ) : (
            <span style={valueStyle}>{profile.email || "—"}</span>
          )}
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Phone</span>
          {editing ? (
            <input
              type="tel"
              style={inputStyle}
              value={editForm.phone}
              onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
            />
          ) : (
            <span style={{ ...valueStyle, fontFamily: "monospace" }}>
              {profile.phone || "—"}
            </span>
          )}
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Alt phone</span>
          {editing ? (
            <input
              type="tel"
              style={inputStyle}
              value={editForm.altPhone}
              onChange={(e) => setEditForm({ ...editForm, altPhone: e.target.value })}
            />
          ) : (
            <span style={{ ...valueStyle, fontFamily: "monospace" }}>
              {profile.altPhone || "—"}
            </span>
          )}
        </div>
        <div style={fieldStyle}>
          <span style={labelStyle}>Status</span>
          <span style={valueStyle}>{profile.status}</span>
        </div>

        {editing && (
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "flex-end",
              marginTop: 16,
            }}
          >
            <button
              onClick={() => {
                setEditing(false);
                setEditForm({
                  email: profile.email ?? "",
                  phone: profile.phone ?? "",
                  altPhone: profile.altPhone ?? "",
                });
              }}
              style={{
                padding: "8px 16px",
                fontSize: 13,
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
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: "8px 20px",
                fontSize: 13,
                fontWeight: 600,
                background: "var(--accent-primary)",
                color: "#fff",
                border: "none",
                borderRadius: "var(--radius)",
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
                fontFamily: "inherit",
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
