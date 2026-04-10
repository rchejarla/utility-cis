"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

interface Role {
  id: string;
  name: string;
  description?: string;
  isSystem: boolean;
  permissions: Record<string, string[]>;
  _count?: { users: number };
}

const roleColors: Record<string, string> = {
  "System Admin": "#ef4444",
  "Utility Admin": "#f59e0b",
  "CSR": "#3b82f6",
  "Field Technician": "#22c55e",
  "Read-Only": "#8b5cf6",
};

export default function DevLaunchPage() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<Role[] | { data: Role[] }>("/api/v1/auth/roles")
      .then((res) => setRoles(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const switchRole = async (roleId: string) => {
    setSwitching(roleId);
    try {
      // Dev-only endpoint — bypasses permission checks
      await apiClient.post("/api/v1/auth/switch-role", { roleId });
      // Refresh auth context to pick up new permissions
      await refresh();
      router.push("/premises");
    } catch (err: any) {
      console.error("Failed to switch role:", err);
      alert(err.message || "Failed to switch role");
    } finally {
      setSwitching(null);
    }
  };

  const countPermissions = (perms: Record<string, string[]>) => {
    return Object.values(perms).reduce((sum, p) => sum + p.length, 0);
  };

  const countModules = (perms: Record<string, string[]>) => {
    return Object.keys(perms).filter((k) => perms[k].length > 0).length;
  };

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: "48px" }}>
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
          Select a Role
        </h1>
        <p style={{ fontSize: "15px", color: "var(--text-secondary)", margin: 0 }}>
          Switch your user to any role to test the permission system.
          {user && (
            <span style={{ display: "block", marginTop: "8px", fontSize: "13px", color: "var(--text-muted)" }}>
              Current: <strong style={{ color: "var(--text-primary)" }}>{user.roleName ?? "Unknown"}</strong> ({user.email})
            </span>
          )}
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading roles...</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px" }}>
          {roles.map((role) => {
            const color = roleColors[role.name] ?? "var(--accent-primary)";
            const modules = countModules(role.permissions);
            const perms = countPermissions(role.permissions);
            const isCurrent = user?.roleId === role.id;
            const isSwitching = switching === role.id;

            return (
              <button
                key={role.id}
                onClick={() => !isCurrent && switchRole(role.id)}
                disabled={isCurrent || !!switching}
                style={{
                  background: isCurrent ? "var(--bg-elevated)" : "var(--bg-card)",
                  border: isCurrent ? `2px solid ${color}` : "1px solid var(--border)",
                  borderRadius: "12px",
                  padding: "24px",
                  cursor: isCurrent ? "default" : switching ? "not-allowed" : "pointer",
                  textAlign: "left",
                  fontFamily: "inherit",
                  transition: "all 0.2s ease",
                  opacity: switching && !isSwitching ? 0.5 : 1,
                }}
              >
                {/* Role name + badge */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                  <div
                    style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: color,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--text-primary)" }}>
                    {role.name}
                  </div>
                  {role.isSystem && (
                    <span
                      style={{
                        fontSize: "9px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: "rgba(245,158,11,0.12)",
                        color: "#fbbf24",
                      }}
                    >
                      System
                    </span>
                  )}
                  {isCurrent && (
                    <span
                      style={{
                        fontSize: "9px",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: "rgba(52,211,153,0.12)",
                        color: "#34d399",
                      }}
                    >
                      Active
                    </span>
                  )}
                </div>

                {/* Description */}
                <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginBottom: "16px", lineHeight: 1.4 }}>
                  {role.description || "No description"}
                </div>

                {/* Stats */}
                <div style={{ display: "flex", gap: "16px" }}>
                  <div>
                    <div style={{ fontSize: "18px", fontWeight: 700, color, fontFamily: "monospace" }}>
                      {modules}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Modules
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "18px", fontWeight: 700, color, fontFamily: "monospace" }}>
                      {perms}
                    </div>
                    <div style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Permissions
                    </div>
                  </div>
                </div>

                {/* Switch button */}
                {!isCurrent && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "8px 0",
                      textAlign: "center",
                      fontSize: "12px",
                      fontWeight: 500,
                      color,
                      borderTop: "1px solid var(--border)",
                    }}
                  >
                    {isSwitching ? "Switching..." : "Switch to this role →"}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: "40px", fontSize: "12px", color: "var(--text-muted)" }}>
        This page is for development testing only. Not visible in production.
      </div>
    </div>
  );
}
