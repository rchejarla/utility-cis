"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";

/**
 * Provision and list tenants.
 *
 * Lives under /dev, which `app-shell.tsx` excludes from admin chrome, and
 * appears in no sidebar. The design note puts provisioning behind a
 * platform actor (build-order step 5) and a console at step 6; this
 * exists before both, so its API is fenced to non-production builds. The
 * reason is authority rather than caution: inside a tenant's own
 * Administration section this page would be gated on a tenant
 * permission, which is one tenant's admin acting above tenants — the
 * borrowing §1.6 flags with Bull Board.
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

export default function DevTenantsPage() {
  const [utilities, setUtilities] = useState<UtilitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminName, setAdminName] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: UtilitySummary[] }>("/api/v1/dev/tenants");
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
  }, [load]);

  async function submit(dryRun: boolean) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), dryRun };
      // Both or neither. Sending one of them produced `email: ""`, which
      // the route's schema rejects as a 400 the client renders as
      // "Validation failed" with the field list dropped — a dead end
      // where the script says "--admin-email and --admin-name go
      // together". The buttons are disabled in that state anyway; this
      // is the guard that makes the half-filled body unconstructible.
      if (adminEmail.trim() && adminName.trim()) {
        body.firstAdmin = { email: adminEmail.trim(), name: adminName.trim() };
      }
      const result = await apiClient.post<ProvisionResult>("/api/v1/dev/tenants", body);
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

  // The admin is optional, but it is one thing made of two fields: the
  // route requires both or neither, so a half-filled pair is a state the
  // form should name rather than submit.
  const adminHalfFilled = Boolean(adminEmail.trim()) !== Boolean(adminName.trim());
  const blocked = busy || !name.trim() || adminHalfFilled;

  return (
    <div style={{ maxWidth: "860px", margin: "0 auto", padding: "40px 24px" }}>
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
          Dev Testing
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
          This screen exists only in development. Provisioning moves behind the platform actor at
          build-order step 5, and this page with it.{" "}
          <Link href="/dev" style={{ color: "var(--accent-primary)" }}>
            Back to dev tools
          </Link>
        </p>
        {/*
          Stated up front because the 403 is otherwise a dead end: both
          routes require settings:EDIT, and the Utility Admin preset holds
          settings:["VIEW"] — the one permission separating it from System
          Admin. A tenant's own admin enumerating every other tenant is
          the borrowing this page is fenced against, so the lockout is the
          design; being unable to tell why is not.
        */}
        <p style={{ fontSize: "13px", color: "var(--text-muted)", margin: 0 }}>
          Requires <strong>System Admin</strong> — both routes are gated on{" "}
          <code>settings:EDIT</code>, and Utility Admin holds <code>settings:VIEW</code> only.
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
          <p style={{ fontSize: "13px", color: "var(--text-muted)" }}>
            No tenants. This database has none at all.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                {["Name", "Status", "Created", "Modules", "Roles", "Users"].map((h) => (
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
                      overflow: "hidden",
                      textOverflow: "ellipsis",
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
                      padding: "10px",
                      fontSize: "13px",
                      color: "var(--text-primary)",
                      borderBottom: "1px solid var(--border-subtle)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={u.id}
                  >
                    {u.name}
                  </td>
                  <td
                    style={{
                      padding: "10px",
                      fontSize: "12px",
                      color: u.status === "ACTIVE" ? "var(--success)" : "var(--warning)",
                      borderBottom: "1px solid var(--border-subtle)",
                    }}
                  >
                    {u.status}
                  </td>
                  {[u.createdAt.slice(0, 10), u.moduleCount, u.roleCount, u.userCount].map((v, i) => (
                    <td
                      key={i}
                      style={{
                        padding: "10px",
                        fontSize: "13px",
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid var(--border-subtle)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
