"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";

/**
 * What one tenant holds.
 *
 * The list showed counts with nothing behind them, which is a dead end —
 * "6 roles" raises the question it cannot answer. Modules, roles and
 * staff are the three things provisioning creates, so they are the three
 * things this answers.
 *
 * Portal customers are counted rather than listed: they are `cis_user`
 * rows too, and a real utility has tens of thousands. The question this
 * screen exists to answer is whether the tenant can be administered.
 */

interface UtilityDetail {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: string;
  moduleCount: number;
  roleCount: number;
  userCount: number;
  portalUserCount: number;
  modules: { moduleKey: string; isEnabled: boolean }[];
  roles: { id: string; name: string; description: string | null; isSystem: boolean; moduleCount: number }[];
  staff: { id: string; email: string; name: string; isActive: boolean; roleName: string | null }[];
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  overflow: "hidden",
};

const thCell: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 14px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
};

const tdCell: React.CSSProperties = {
  padding: "9px 14px",
  fontSize: 13,
  color: "var(--text-primary)",
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.2 }}>
        {value}
      </div>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-muted)",
          marginTop: 2,
        }}
      >
        {label}
      </div>
    </div>
  );
}

export default function PlatformTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [detail, setDetail] = useState<UtilityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [moduleBusy, setModuleBusy] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("staff");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await apiClient.get<UtilityDetail>(`/api/v1/platform/utilities/${params.id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleModule(moduleKey: string, isEnabled: boolean) {
    setModuleBusy(moduleKey);
    setError(null);
    try {
      await apiClient.patch(
        `/api/v1/platform/utilities/${params.id}/modules/${moduleKey}`,
        { isEnabled },
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setModuleBusy(null);
    }
  }

  async function setStatus(next: "ACTIVE" | "SUSPENDED") {
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(
        `/api/v1/platform/utilities/${params.id}/${next === "SUSPENDED" ? "suspend" : "reactivate"}`,
        {},
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmSuspend(false);
    }
  }

  if (loading) {
    return <div style={{ color: "var(--text-muted)", padding: "40px 0", fontSize: 13 }}>Loading...</div>;
  }

  if (!detail) {
    return (
      <div>
        <PageHeader title="Utility" />
        <div style={{ ...card, padding: "20px", fontSize: 13, color: "var(--danger)" }}>
          {error ?? "Not found."}
        </div>
        <div style={{ marginTop: 16 }}>
          <Link href="/platform/utilities" style={{ color: "var(--accent-primary)", fontSize: 13 }}>
            Back to utilities
          </Link>
        </div>
      </div>
    );
  }

  const suspended = detail.status === "SUSPENDED";

  return (
    <div>
      <PageHeader
        title={detail.name}
        subtitle={`Created ${detail.createdAt.slice(0, 10)} · ${detail.id}`}
        actions={
          <button
            onClick={() => (suspended ? setStatus("ACTIVE") : setConfirmSuspend(true))}
            disabled={busy}
            style={{
              ...btnStyle,
              color: suspended ? "var(--success)" : "var(--danger)",
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.55 : 1,
            }}
          >
            {suspended ? "Reactivate" : "Suspend"}
          </button>
        }
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

      {suspended && (
        <div
          style={{
            ...card,
            borderColor: "var(--warning)",
            padding: "12px 14px",
            marginBottom: 20,
            fontSize: 13,
            color: "var(--text-primary)",
          }}
        >
          <strong style={{ color: "var(--warning)" }}>Suspended.</strong> Every one of this
          tenant&apos;s users is refused on every screen until it is reactivated. Nothing has been
          deleted.
        </div>
      )}

      <div
        style={{
          ...card,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          marginBottom: 20,
        }}
      >
        <Stat label="Modules" value={detail.moduleCount} />
        <Stat label="Roles" value={detail.roleCount} />
        <Stat label="Staff" value={detail.staff.length} />
        <Stat label="Portal customers" value={detail.portalUserCount} />
      </div>

      <Tabs
        tabs={[
          { key: "staff", label: `Staff (${detail.staff.length})` },
          { key: "roles", label: `Roles (${detail.roles.length})` },
          { key: "modules", label: `Modules (${detail.moduleCount})` },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      >
        <div style={card}>
          {activeTab === "staff" && (
            <>
        {detail.staff.length === 0 ? (
          <div style={{ padding: "20px 14px", fontSize: 13, color: "var(--text-muted)" }}>
            {/* A tenant with no staff cannot be administered into
                existence, which is why provisioning offers a first admin. */}
            No staff. This tenant has no one who can administer it.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thCell}>Name</th>
                <th style={thCell}>Email</th>
                <th style={thCell}>Role</th>
                <th style={thCell}>Active</th>
              </tr>
            </thead>
            <tbody>
              {detail.staff.map((s) => (
                <tr key={s.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <td style={tdCell}>{s.name}</td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{s.email}</td>
                  <td style={tdCell}>
                    {s.roleName ?? (
                      // Worth seeing: a user with no role can do nothing,
                      // which is what an operator is hunting for when a
                      // tenant reports it cannot work.
                      <span style={{ color: "var(--warning)", fontSize: 12 }}>No role</span>
                    )}
                  </td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                    {s.isActive ? "Yes" : "No"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
            </>
          )}
          {activeTab === "roles" && (
            <>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thCell}>Name</th>
              <th style={thCell}>Description</th>
              <th style={thCell}>Modules granted</th>
              <th style={thCell}>Preset</th>
            </tr>
          </thead>
          <tbody>
            {detail.roles.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                <td style={tdCell}>{r.name}</td>
                <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{r.description ?? "—"}</td>
                {/* The count, because "6 roles" says nothing about what
                    any of them can do. */}
                <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{r.moduleCount}</td>
                <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                  {r.isSystem ? "Yes" : "No"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
            </>
          )}
          {activeTab === "modules" && (
            <>
              <div
                style={{
                  padding: "12px 14px",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                Click a module to turn it off or back on. A disabled module answers
                MODULE_DISABLED on every route it owns, for every one of this utility&apos;s users,
                and takes effect immediately.
              </div>
              <div style={{ padding: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
                {detail.modules.map((m) => (
                  <button
                    key={m.moduleKey}
                    onClick={() => toggleModule(m.moduleKey, !m.isEnabled)}
                    disabled={moduleBusy === m.moduleKey}
                    title={
                      m.isEnabled
                        ? `Turn off ${m.moduleKey} for this utility`
                        : `Turn on ${m.moduleKey} for this utility`
                    }
                    // The title would otherwise become the accessible
                    // name and read out instead of the module.
                    aria-label={`${m.moduleKey} — ${m.isEnabled ? "enabled" : "disabled"}`}
                    aria-pressed={m.isEnabled}
                    style={{
                      fontSize: 12,
                      fontFamily: "monospace",
                      padding: "3px 10px",
                      borderRadius: 999,
                      cursor: moduleBusy === m.moduleKey ? "wait" : "pointer",
                      border: `1px solid ${m.isEnabled ? "var(--border)" : "var(--border-subtle)"}`,
                      color: m.isEnabled ? "var(--text-secondary)" : "var(--text-muted)",
                      background: m.isEnabled ? "transparent" : "var(--bg-elevated)",
                      textDecoration: m.isEnabled ? "none" : "line-through",
                      opacity: moduleBusy === m.moduleKey ? 0.5 : 1,
                    }}
                  >
                    {m.moduleKey}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </Tabs>

      <div style={{ marginTop: 20 }}>
        <button onClick={() => router.push("/platform/utilities")} style={{ ...btnStyle, color: "var(--text-muted)" }}>
          Back to utilities
        </button>
      </div>

      {confirmSuspend && (
        <ConfirmDialog
          title={`Suspend ${detail.name}?`}
          message="Its users will be refused on every screen until it is reactivated. Nothing is deleted, and reactivating restores access immediately."
          confirmLabel="Suspend"
          destructive
          onConfirm={() => setStatus("SUSPENDED")}
          onCancel={() => setConfirmSuspend(false)}
        />
      )}
    </div>
  );
}
