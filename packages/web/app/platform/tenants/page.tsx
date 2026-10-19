"use client";

import { useState, useEffect, useCallback } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * The platform operator's console: tenant lifecycle.
 *
 * This lived at `/dev/tenants` behind a non-production fence, because
 * the authority it needed did not exist — before a platform actor, a
 * provisioning page had nowhere to live but a tenant's own
 * Administration section, gated on a tenant permission, which is one
 * tenant's admin acting above tenants (§1.6). `{ platform: true }` is
 * that authority now, so the fence is gone.
 *
 * It sits outside the admin shell deliberately. This is not a tenant's
 * screen, so the tenant sidebar and the tenant's own theme would be
 * actively misleading on it.
 *
 * What this is not: a claim that the deployment is safe. Nothing in this
 * app authenticates anyone yet, so what un-fencing buys is the right
 * authority model rather than a secure console. Real identity is Q2's
 * destination.
 */

interface UtilitySummary {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  moduleCount: number;
  roleCount: number;
  userCount: number;
}

interface ProvisionResult {
  utilityId: string;
  created: boolean;
  modulesEnabled: number;
  rolesCreated: number;
  adminCreated: boolean;
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "20px",
};

const input: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 12px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: "13px",
  fontFamily: "inherit",
};

const label: React.CSSProperties = {
  display: "block",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-secondary)",
  marginBottom: "6px",
};

const cell: React.CSSProperties = {
  padding: "10px",
  fontSize: "13px",
  borderBottom: "1px solid var(--border-subtle)",
  whiteSpace: "nowrap",
};

export default function PlatformTenantsPage() {
  const [utilities, setUtilities] = useState<UtilitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: UtilitySummary[] }>("/api/v1/platform/tenants");
      setUtilities(res.data ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Who the console is acting as. Answered from the row rather than the
    // token, so a renamed operator sees their new name.
    apiClient
      .get<{ actor: { email: string } | null }>("/api/v1/platform/me")
      .then((res) => setActor(res.actor?.email ?? null))
      .catch(() => setActor(null));
  }, [load]);

  async function submit(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), dryRun };
      // Both or neither. Sending one of them produces `email: ""`, which
      // the route rejects as an opaque 400; the buttons are disabled in
      // that state anyway, and this makes the half-filled body
      // unconstructible.
      if (adminEmail.trim() && adminName.trim()) {
        body.firstAdmin = { email: adminEmail.trim(), name: adminName.trim() };
      }
      const result = await apiClient.post<ProvisionResult>("/api/v1/platform/tenants", body);
      if (dryRun) {
        setPreview(result);
      } else {
        setName("");
        setAdminEmail("");
        setAdminName("");
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(u: UtilitySummary, next: "ACTIVE" | "SUSPENDED") {
    const verb = next === "SUSPENDED" ? "Suspend" : "Reactivate";
    // Suspending stops every one of that tenant's staff working, so it
    // is confirmed by name rather than by row position.
    if (next === "SUSPENDED" && !window.confirm(`${verb} ${u.name}? Its users will be refused on every screen until it is reactivated.`)) {
      return;
    }
    setRowBusy(u.id);
    setError(null);
    try {
      await apiClient.post(
        `/api/v1/platform/tenants/${u.id}/${next === "SUSPENDED" ? "suspend" : "reactivate"}`,
        {},
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRowBusy(null);
    }
  }

  const adminHalfFilled = Boolean(adminEmail.trim()) !== Boolean(adminName.trim());
  const blocked = busy || !name.trim() || adminHalfFilled;

  return (
    <div style={{ maxWidth: "960px", margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ marginBottom: "32px" }}>
        <div
          style={{
            fontSize: "11px",
            fontFamily: "monospace",
            letterSpacing: "2px",
            textTransform: "uppercase",
            color: "var(--accent-primary)",
            marginBottom: "12px",
          }}
        >
          Platform
        </div>
        <h1
          style={{
            fontSize: "32px",
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 8px",
          }}
        >
          Tenants
        </h1>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", margin: "0 0 8px" }}>
          Creating, listing, suspending and reactivating utilities. These operations sit above any
          one tenant, so no tenant role can reach them — not even System Admin.
        </p>
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          {actor ? `Acting as ${actor}` : "Requires the platform operator."}
        </p>
      </div>

      {error && (
        <div
          style={{
            ...card,
            borderColor: "var(--danger)",
            color: "var(--danger)",
            marginBottom: "20px",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ ...card, marginBottom: "24px" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 16px" }}>
          Provision a tenant
        </h2>

        <div style={{ display: "grid", gap: "14px", gridTemplateColumns: "1fr 1fr" }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={label}>Utility name</label>
            <input
              style={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="City of Example"
            />
          </div>
          <div>
            <label style={label}>First admin email</label>
            <input
              style={input}
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              placeholder="ops@example.gov"
            />
          </div>
          <div>
            <label style={label}>First admin name</label>
            <input
              style={input}
              value={adminName}
              onChange={(e) => setAdminName(e.target.value)}
              placeholder="Pat Admin"
            />
          </div>
          <div
            style={{
              gridColumn: "1 / -1",
              marginTop: "-6px",
              fontSize: "12px",
              color: adminHalfFilled ? "var(--danger)" : "var(--text-muted)",
            }}
          >
            {adminHalfFilled
              ? "Email and name go together — fill both, or leave both empty."
              : "Optional, and the pair is one thing: fill both, or neither. A tenant can get its first admin later."}
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginTop: "18px" }}>
          <button
            onClick={() => submit(true)}
            disabled={blocked}
            style={{
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              color: "var(--text-secondary)",
              fontSize: "13px",
              fontFamily: "inherit",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.55 : 1,
            }}
          >
            Preview
          </button>
          <button
            onClick={() => submit(false)}
            disabled={blocked}
            style={{
              padding: "7px 16px",
              borderRadius: "var(--radius)",
              border: "none",
              background: "var(--accent-primary)",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: blocked ? "not-allowed" : "pointer",
              opacity: blocked ? 0.55 : 1,
            }}
          >
            Create
          </button>
          <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            Preview reports what would change and writes nothing.
          </span>
        </div>

        {preview && (
          <div
            style={{
              marginTop: "16px",
              padding: "12px 14px",
              borderRadius: "var(--radius)",
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              fontSize: "13px",
              color: "var(--text-primary)",
            }}
          >
            <strong>Preview — nothing was written.</strong>
            <div style={{ color: "var(--text-secondary)", marginTop: "6px" }}>
              {preview.created ? "Would create the utility" : "Utility already exists"} ·{" "}
              {preview.modulesEnabled} modules · {preview.rolesCreated} roles ·{" "}
              {preview.adminCreated ? "would create the admin" : "no admin created"}
            </div>
          </div>
        )}
      </div>

      <div style={card}>
        <h2 style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Existing tenants
        </h2>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", margin: "0 0 16px" }}>
          Counts are what each tenant holds: enabled modules, roles, and users.
        </p>

        {loading ? (
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>Loading…</p>
        ) : utilities.length === 0 ? (
          // Only claimed when the list actually came back empty — saying
          // "none at all" under an error box would contradict it.
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            {error ? "Could not load the tenant list." : "No tenants. This database has none at all."}
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Name", "Status", "Created", "Modules", "Roles", "Users", ""].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "8px 10px",
                      fontSize: "11px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      color: "var(--text-secondary)",
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
              {utilities.map((u) => (
                <tr key={u.id}>
                  <td
                    style={{
                      ...cell,
                      color: "var(--text-primary)",
                      maxWidth: "260px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={u.id}
                  >
                    {u.name}
                  </td>
                  <td
                    style={{
                      ...cell,
                      fontSize: "12px",
                      fontWeight: 600,
                      color: u.status === "ACTIVE" ? "var(--success)" : "var(--warning)",
                    }}
                  >
                    {u.status}
                  </td>
                  <td style={{ ...cell, color: "var(--text-secondary)" }}>
                    {u.createdAt.slice(0, 10)}
                  </td>
                  <td style={{ ...cell, color: "var(--text-secondary)" }}>{u.moduleCount}</td>
                  <td style={{ ...cell, color: "var(--text-secondary)" }}>{u.roleCount}</td>
                  <td style={{ ...cell, color: "var(--text-secondary)" }}>{u.userCount}</td>
                  <td style={{ ...cell, textAlign: "right" }}>
                    <button
                      onClick={() => setStatus(u, u.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}
                      disabled={rowBusy === u.id}
                      style={{
                        padding: "5px 12px",
                        borderRadius: "var(--radius)",
                        border: "1px solid var(--border)",
                        background: "var(--bg-card)",
                        color:
                          u.status === "ACTIVE" ? "var(--danger)" : "var(--success)",
                        fontSize: "12px",
                        fontFamily: "inherit",
                        cursor: rowBusy === u.id ? "not-allowed" : "pointer",
                        opacity: rowBusy === u.id ? 0.55 : 1,
                      }}
                    >
                      {u.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
