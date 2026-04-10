"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiClient, setDevUser } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

interface TestUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  role?: { id: string; name: string };
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
  const { user: currentUser, refresh } = useAuth();
  const [users, setUsers] = useState<TestUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<TestUser[] | { data: TestUser[] }>("/api/v1/auth/dev-users")
      .then((res) => setUsers(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const switchUser = async (testUser: TestUser) => {
    setSwitching(testUser.id);
    try {
      setDevUser(testUser.id, testUser.email, testUser.name);
      await refresh();
      router.push("/premises");
    } catch (err: any) {
      alert(err.message || "Failed to switch user");
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ textAlign: "center", marginBottom: "48px" }}>
        <div style={{ fontSize: "11px", fontFamily: "monospace", letterSpacing: "2px", textTransform: "uppercase", color: "var(--accent-primary)", marginBottom: "12px" }}>
          Dev Testing
        </div>
        <h1 style={{ fontSize: "32px", fontWeight: 700, color: "var(--text-primary)", margin: "0 0 8px" }}>
          Select a User
        </h1>
        <p style={{ fontSize: "15px", color: "var(--text-secondary)", margin: 0 }}>
          Impersonate any user to test the permission system.
          {currentUser && (
            <span style={{ display: "block", marginTop: "8px", fontSize: "13px", color: "var(--text-muted)" }}>
              Current: <strong style={{ color: "var(--text-primary)" }}>{currentUser.name}</strong> — {currentUser.roleName} ({currentUser.email})
            </span>
          )}
        </p>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", color: "var(--text-muted)" }}>Loading users...</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px" }}>
          {users.map((testUser) => {
            const roleName = testUser.role?.name ?? "Unknown";
            const color = roleColors[roleName] ?? "var(--accent-primary)";
            const isCurrent = currentUser?.id === testUser.id;
            const isSwitching = switching === testUser.id;

            return (
              <button
                key={testUser.id}
                onClick={() => !isCurrent && switchUser(testUser)}
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
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                  <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: `${color}22`, border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color, flexShrink: 0 }}>
                    {testUser.name.charAt(0)}
                  </div>
                  <div>
                    <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>{testUser.name}</div>
                    <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "monospace" }}>{testUser.email}</div>
                  </div>
                </div>

                <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 10px", borderRadius: "999px", fontSize: "11px", fontWeight: 600, background: `${color}18`, color }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
                    {roleName}
                  </span>
                  {isCurrent && (
                    <span style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: "4px", background: "rgba(52,211,153,0.12)", color: "#34d399" }}>
                      Active
                    </span>
                  )}
                </div>

                {!isCurrent && (
                  <div style={{ marginTop: "16px", padding: "8px 0", textAlign: "center", fontSize: "12px", fontWeight: 500, color, borderTop: "1px solid var(--border)" }}>
                    {isSwitching ? "Switching..." : "Impersonate →"}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ textAlign: "center", marginTop: "40px", fontSize: "12px", color: "var(--text-muted)" }}>
        This page is for development testing only.
      </div>
    </div>
  );
}
