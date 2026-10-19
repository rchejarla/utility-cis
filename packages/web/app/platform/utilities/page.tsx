"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api-client";
import { PageHeader } from "@/components/ui/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
 * It wears the house furniture — `PageHeader`, the card-and-table
 * treatment every list screen uses, `ConfirmDialog` — rather than the
 * hand-rolled styling it inherited from the dev page. A screen that
 * looks foreign reads as a prototype, and this one is not.
 *
 * What it is not: a claim that the deployment is safe. Nothing in this
 * app authenticates anyone yet, so what un-fencing buys is the right
 * authority model rather than a secure console.
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
  whiteSpace: "nowrap",
};

const btnStyle: React.CSSProperties = {
  padding: "7px 14px",
  borderRadius: "var(--radius)",
  fontSize: 13,
  fontWeight: 500,
  fontFamily: "inherit",
  cursor: "pointer",
  border: "1px solid var(--border)",
};

export default function PlatformTenantsPage() {
  const [utilities, setUtilities] = useState<UtilitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSuspend, setPendingSuspend] = useState<UtilitySummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<{ data: UtilitySummary[] }>("/api/v1/platform/utilities");
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

  async function setStatus(u: UtilitySummary, next: "ACTIVE" | "SUSPENDED") {
    setRowBusy(u.id);
    setError(null);
    try {
      await apiClient.post(
        `/api/v1/platform/utilities/${u.id}/${next === "SUSPENDED" ? "suspend" : "reactivate"}`,
        {},
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRowBusy(null);
      setPendingSuspend(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Utilities"
        subtitle="Every utility on this deployment. These operations sit above any one tenant, so no tenant role can reach them — not even System Admin."
        action={{ label: "Add utility", href: "/platform/utilities/new" }}
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

      {loading ? (
        <div style={{ color: "var(--text-muted)", padding: "40px 0", fontSize: 13 }}>Loading...</div>
      ) : utilities.length === 0 ? (
        <div style={{ ...card, padding: "32px 18px", textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
          {/* Only claimed when the list actually came back empty — saying
              "none at all" under an error box would contradict it. */}
          {error ? "Could not load the utility list." : "No utilities. This database has none at all."}
        </div>
      ) : (
        <div style={card}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "var(--bg-elevated)" }}>
                <th style={thCell}>Name</th>
                <th style={thCell}>Status</th>
                <th style={thCell}>Created</th>
                <th style={thCell}>Modules</th>
                <th style={thCell}>Roles</th>
                <th style={thCell}>Users</th>
                <th style={{ ...thCell, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {utilities.map((u) => (
                <tr key={u.id} style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  <td style={{ ...tdCell, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={u.id}>
                    {/* The counts in this row are summaries; the name is
                        how you get to what they summarise. */}
                    <Link
                      href={`/platform/utilities/${u.id}`}
                      style={{ color: "var(--accent-primary)", textDecoration: "none" }}
                    >
                      {u.name}
                    </Link>
                  </td>
                  <td style={tdCell}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 999,
                        color: u.status === "ACTIVE" ? "var(--success)" : "var(--warning)",
                        border: `1px solid ${u.status === "ACTIVE" ? "var(--success)" : "var(--warning)"}40`,
                      }}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{u.createdAt.slice(0, 10)}</td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{u.moduleCount}</td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{u.roleCount}</td>
                  <td style={{ ...tdCell, color: "var(--text-secondary)" }}>{u.userCount}</td>
                  <td style={{ ...tdCell, textAlign: "right" }}>
                    <button
                      onClick={() =>
                        u.status === "ACTIVE" ? setPendingSuspend(u) : setStatus(u, "ACTIVE")
                      }
                      disabled={rowBusy === u.id}
                      style={{
                        ...btnStyle,
                        padding: "4px 12px",
                        fontSize: 12,
                        background: "transparent",
                        color: u.status === "ACTIVE" ? "var(--danger)" : "var(--success)",
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
        </div>
      )}

      {/*
        Suspending stops every one of that tenant's staff working, so it
        is confirmed by name. The app's own dialog rather than
        window.confirm, which blocks the page and cannot be styled.
      */}
      {pendingSuspend && (
        <ConfirmDialog
          title={`Suspend ${pendingSuspend.name}?`}
          message="Its users will be refused on every screen until it is reactivated. Nothing is deleted, and reactivating restores access immediately."
          confirmLabel="Suspend"
          destructive
          onConfirm={() => setStatus(pendingSuspend, "SUSPENDED")}
          onCancel={() => setPendingSuspend(null)}
        />
      )}
    </div>
  );
}
