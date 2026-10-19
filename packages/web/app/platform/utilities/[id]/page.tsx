"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PermissionMatrix } from "@/components/settings/permission-matrix";
import { presetDrift } from "@utility-cis/shared";
import { FormField } from "@/components/ui/form-field";

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

interface HistoryEntry {
  id: string;
  createdAt: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  entityType: string;
  actorName: string | null;
  source: string | null;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: { eventType?: string } | null;
}

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
  roles: {
    id: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    moduleCount: number;
    permissions: Record<string, string[]>;
    assignmentCount: number;
  }[];
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

/**
 * One line describing what an entry changed.
 *
 * The raw before/after states are small here — utility status, a module
 * key, a role's permission map — but printing them as JSON makes a
 * history nobody reads. This names the fields that differ, and falls
 * back to a dash when there is nothing to compare.
 */
function summariseChange(h: HistoryEntry): string {
  const before = h.beforeState ?? {};
  const after = h.afterState ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length === 0) return "—";

  const show = (v: unknown) =>
    v === undefined || v === null
      ? "—"
      : typeof v === "object"
        ? `${Object.keys(v as object).length} modules`
        : String(v);

  return changed
    .slice(0, 3)
    .map((k) =>
      h.action === "CREATE"
        ? `${k} ${show(after[k])}`
        : h.action === "DELETE"
          ? `${k} ${show(before[k])}`
          : `${k} ${show(before[k])} → ${show(after[k])}`,
    )
    .join(", ");
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
  // null = closed; { id: null } = adding; { id } = editing that role.
  const [roleDraft, setRoleDraft] = useState<
    | { id: string | null; name: string; description: string; permissions: Record<string, string[]> }
    | null
  >(null);
  const [roleBusy, setRoleBusy] = useState(false);
  const [pendingRoleDelete, setPendingRoleDelete] = useState<{ id: string; name: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
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

  useEffect(() => {
    if (activeTab !== "history" || history !== null) return;
    apiClient
      .get<{ data: HistoryEntry[] }>(`/api/v1/platform/utilities/${params.id}/history`)
      .then((res) => setHistory(res.data ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [activeTab, history, params.id]);

  async function saveRole() {
    if (!roleDraft) return;
    setRoleBusy(true);
    setError(null);
    try {
      const body = {
        name: roleDraft.name.trim(),
        description: roleDraft.description.trim() || undefined,
        permissions: roleDraft.permissions,
      };
      if (roleDraft.id) {
        await apiClient.patch(`/api/v1/platform/utilities/${params.id}/roles/${roleDraft.id}`, body);
      } else {
        await apiClient.post(`/api/v1/platform/utilities/${params.id}/roles`, body);
      }
      setRoleDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRoleBusy(false);
    }
  }

  async function deleteRole(roleId: string) {
    setRoleBusy(true);
    setError(null);
    try {
      await apiClient.delete(`/api/v1/platform/utilities/${params.id}/roles/${roleId}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRoleBusy(false);
      setPendingRoleDelete(null);
    }
  }

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
          { key: "history", label: "History" },
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
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border-subtle)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span style={{ fontSize: 12, color: "var(--text-muted)", flex: 1 }}>
                  A utility normally manages its own roles; editing from here is for one with no
                  working admin, and a change applies to its users immediately. Each utility owns
                  its own copies — a preset is a starting point, so an edit here changes this
                  utility only and re-provisioning will not revert it. A role can be deleted once
                  nobody holds it.
                </span>
                <button
                  onClick={() =>
                    setRoleDraft({ id: null, name: "", description: "", permissions: {} })
                  }
                  style={{ ...btnStyle, padding: "5px 12px", fontSize: 12 }}
                >
                  Add role
                </button>
              </div>

              {roleDraft && (
                <div style={{ padding: 14, borderBottom: "1px solid var(--border-subtle)" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                    <FormField label="Name" required>
                      <input
                        style={inputStyle}
                        value={roleDraft.name}
                        onChange={(e) => setRoleDraft({ ...roleDraft, name: e.target.value })}
                        placeholder="Auditor"
                      />
                    </FormField>
                    <FormField label="Description">
                      <input
                        style={inputStyle}
                        value={roleDraft.description}
                        onChange={(e) => setRoleDraft({ ...roleDraft, description: e.target.value })}
                        placeholder="What this role is for"
                      />
                    </FormField>
                  </div>

                  {/* The same matrix the tenant's own Users & Roles screen
                      uses, so the two cannot disagree about what a verb
                      means — including its rule that CREATE, EDIT or
                      DELETE implies VIEW. */}
                  <PermissionMatrix
                    permissions={roleDraft.permissions}
                    onChange={(permissions) => setRoleDraft({ ...roleDraft, permissions })}
                  />

                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <button
                      onClick={saveRole}
                      disabled={roleBusy || !roleDraft.name.trim()}
                      style={{
                        ...btnStyle,
                        background: "var(--accent-primary)",
                        color: "#fff",
                        border: "none",
                        cursor: roleBusy || !roleDraft.name.trim() ? "not-allowed" : "pointer",
                        opacity: roleBusy || !roleDraft.name.trim() ? 0.55 : 1,
                      }}
                    >
                      {roleBusy ? "Saving..." : roleDraft.id ? "Save role" : "Create role"}
                    </button>
                    <button
                      onClick={() => setRoleDraft(null)}
                      style={{ ...btnStyle, color: "var(--text-muted)" }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={thCell}>Name</th>
                    <th style={thCell}>Description</th>
                    <th style={thCell}>Modules granted</th>
                    <th style={thCell}>Origin</th>
                    <th style={{ ...thCell, textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.roles.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                      <td style={tdCell}>{r.name}</td>
                      <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                        {r.description ?? "—"}
                      </td>
                      <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{r.moduleCount}</td>
                      <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                        {/* Derived from the permissions stored, not from
                            `isSystem` — that is set once at provisioning
                            and never changes, so it would call an edited
                            role "the standard CSR". */}
                        {(() => {
                          const drift = presetDrift(r.name, r.permissions);
                          if (drift === "custom") return "Custom";
                          if (drift === "preset") return "Preset";
                          return (
                            <span style={{ color: "var(--warning)" }} title="Edited away from the shipped preset">
                              Preset (modified)
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ ...tdCell, textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          onClick={() =>
                            setRoleDraft({
                              id: r.id,
                              name: r.name,
                              description: r.description ?? "",
                              permissions: r.permissions,
                            })
                          }
                          style={{ ...btnStyle, padding: "4px 10px", fontSize: 12, marginRight: 6 }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => setPendingRoleDelete({ id: r.id, name: r.name })}
                          // A preset cannot be deleted (BR-RB-002) and the
                          // server refuses it; saying so here beats a 400
                          // after the click.
                          disabled={r.assignmentCount > 0 || roleBusy}
                          title={
                            r.assignmentCount > 0
                              ? `${r.assignmentCount} user(s) hold this role — remove it from them first`
                              : undefined
                          }
                          aria-label="Delete"
                          style={{
                            ...btnStyle,
                            padding: "4px 10px",
                            fontSize: 12,
                            color: r.assignmentCount > 0 ? "var(--text-muted)" : "var(--danger)",
                            cursor: r.assignmentCount > 0 || roleBusy ? "not-allowed" : "pointer",
                            opacity: r.assignmentCount > 0 || roleBusy ? 0.45 : 1,
                          }}
                        >
                          Delete
                        </button>
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
          {activeTab === "history" && (
            <>
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border-subtle)",
                  fontSize: 12,
                  color: "var(--text-muted)",
                }}
              >
                What was done to this utility from outside it — by an operator here, or by a
                command-line run. Its own staff&apos;s changes are not shown: those are the
                utility&apos;s records, and they are readable in its own audit log.
              </div>
              {history === null ? (
                <div style={{ padding: "20px 14px", fontSize: 13, color: "var(--text-muted)" }}>
                  Loading…
                </div>
              ) : history.length === 0 ? (
                <div style={{ padding: "20px 14px", fontSize: 13, color: "var(--text-muted)" }}>
                  Nothing has been done to this utility from outside it.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={thCell}>When</th>
                      <th style={thCell}>Who</th>
                      <th style={thCell}>What</th>
                      <th style={thCell}>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                        <td style={{ ...tdCell, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                          {h.createdAt.slice(0, 16).replace("T", " ")}
                        </td>
                        <td style={tdCell}>
                          {h.actorName ?? "—"}
                          {/* A CLI run has no signed-in actor; saying so
                              beats an empty cell or a false name. */}
                          {h.source?.startsWith("script:") && (
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}> (script)</span>
                          )}
                        </td>
                        <td style={{ ...tdCell, color: "var(--text-secondary)" }}>
                          {h.metadata?.eventType ?? `${h.entityType} ${h.action}`}
                        </td>
                        <td style={{ ...tdCell, color: "var(--text-secondary)", fontSize: 12 }}>
                          {summariseChange(h)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </Tabs>

      <div style={{ marginTop: 20 }}>
        <button onClick={() => router.push("/platform/utilities")} style={{ ...btnStyle, color: "var(--text-muted)" }}>
          Back to utilities
        </button>
      </div>

      {pendingRoleDelete && (
        <ConfirmDialog
          title={`Delete ${pendingRoleDelete.name}?`}
          message="Anyone holding it loses what it granted. A role still assigned to a user cannot be deleted at all — the server refuses that."
          confirmLabel="Delete"
          destructive
          onConfirm={() => deleteRole(pendingRoleDelete.id)}
          onCancel={() => setPendingRoleDelete(null)}
        />
      )}

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
