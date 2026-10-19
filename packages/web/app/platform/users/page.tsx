"use client";

import { useState, useEffect, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { FormField } from "@/components/ui/form-field";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * The platform's own operators.
 *
 * Before this, one could only be made by SQL or the seed — the same gap
 * §1.5 described for tenants, applied to the identity that sits above
 * them.
 *
 * Appointing is a short form, so it opens in place rather than on its
 * own page: unlike a tenant, which has a name, an admin and a profile to
 * settle, an operator is an address and a name.
 */

interface PlatformUser {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

const thCell: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 14px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};

const tdCell: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 13,
  color: "var(--text-primary)",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-input, var(--bg-card))",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: "var(--radius)",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--border)",
  background: "transparent",
};

export default function PlatformUsersPage() {
  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<PlatformUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: PlatformUser[] }>("/api/v1/platform/users");
      setUsers(res.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post("/api/v1/platform/users", {
        email: email.trim(),
        name: name.trim(),
      });
      setEmail("");
      setName("");
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setActive(user: PlatformUser, isActive: boolean) {
    setRowBusy(user.id);
    setError(null);
    try {
      await apiClient.post(
        `/api/v1/platform/users/${user.id}/${isActive ? "reactivate" : "deactivate"}`,
        {},
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRowBusy(null);
      setPendingDeactivate(null);
    }
  }

  const blocked = busy || !email.trim() || !name.trim();
  const activeCount = users.filter((u) => u.isActive).length;

  return (
    <div>
      <PageHeader
        title="Operators"
        subtitle="Everyone who may create, suspend and inspect the utilities on this deployment. An operator belongs to no tenant and holds no role — being the platform operator is the whole of the authority."
        action={{ label: showForm ? "Cancel" : "Appoint operator", onClick: () => setShowForm((v) => !v) }}
      />

      {error && (
        <div
          style={{
            ...card,
            borderColor: "var(--danger)",
            color: "var(--danger)",
            padding: "12px 14px",
            marginBottom: 20,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {showForm && (
        <div style={{ ...card, padding: 18, marginBottom: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, maxWidth: 560 }}>
            <FormField label="Email" required hint="Lowercased, and refused if another operator holds it.">
              <input
                style={inputStyle}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ops@example.gov"
              />
            </FormField>
            <FormField label="Name" required>
              <input
                style={inputStyle}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pat Operator"
              />
            </FormField>
          </div>
          <div style={{ marginTop: 16 }}>
            <button
              onClick={create}
              disabled={blocked}
              style={{
                ...btnStyle,
                background: "var(--accent-primary)",
                color: "#fff",
                border: "none",
                cursor: blocked ? "not-allowed" : "pointer",
                opacity: blocked ? 0.55 : 1,
              }}
            >
              {busy ? "Appointing..." : "Appoint"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "40px 0", fontSize: 13 }}>Loading...</div>
      ) : users.length === 0 ? (
        <div style={{ ...card, padding: "32px 18px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
          {error ? "Could not load the operator list." : "No operators. Nobody can administer this deployment."}
        </div>
      ) : (
        <div style={card}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <th style={thCell}>Name</th>
                <th style={thCell}>Email</th>
                <th style={thCell}>Status</th>
                <th style={thCell}>Last signed in</th>
                <th style={{ ...thCell, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <td style={tdCell}>{u.name}</td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{u.email}</td>
                  <td style={tdCell}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 999,
                        color: u.isActive ? "var(--success)" : "var(--text-muted)",
                        border: `1px solid ${u.isActive ? "var(--success)40" : "var(--border)"}`,
                      }}
                    >
                      {u.isActive ? "ACTIVE" : "DEACTIVATED"}
                    </span>
                  </td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                    {/* Blank rather than "never": an operator appointed a
                        minute ago has not signed in yet, which is not a
                        fact worth asserting. */}
                    {u.lastLoginAt ? u.lastLoginAt.slice(0, 10) : "—"}
                  </td>
                  <td style={{ ...tdCell, textAlign: "right" }}>
                    <button
                      onClick={() =>
                        u.isActive ? setPendingDeactivate(u) : setActive(u, true)
                      }
                      // The server refuses to remove the last active
                      // operator; disabling it here says so before the
                      // click rather than after.
                      disabled={rowBusy === u.id || (u.isActive && activeCount <= 1)}
                      title={
                        u.isActive && activeCount <= 1
                          ? "The last active operator cannot be deactivated — appoint another first"
                          : undefined
                      }
                      // Same reason as the sidebar's items: the title
                      // would otherwise be read out instead of the verb.
                      aria-label={u.isActive ? "Deactivate" : "Reactivate"}
                      style={{
                        ...btnStyle,
                        padding: "4px 12px",
                        fontSize: 12,
                        color: u.isActive ? "var(--danger)" : "var(--success)",
                        cursor:
                          rowBusy === u.id || (u.isActive && activeCount <= 1)
                            ? "not-allowed"
                            : "pointer",
                        opacity:
                          rowBusy === u.id || (u.isActive && activeCount <= 1) ? 0.45 : 1,
                      }}
                    >
                      {u.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pendingDeactivate && (
        <ConfirmDialog
          title={`Deactivate ${pendingDeactivate.name}?`}
          message="They lose access to every platform screen immediately. Nothing is deleted, and reactivating restores it."
          confirmLabel="Deactivate"
          destructive
          onConfirm={() => setActive(pendingDeactivate, false)}
          onCancel={() => setPendingDeactivate(null)}
        />
      )}
    </div>
  );
}
