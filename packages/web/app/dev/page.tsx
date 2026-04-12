"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

interface TestUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  customerId?: string | null;
  role?: { id: string; name: string };
}

const roleColors: Record<string, string> = {
  "System Admin": "#ef4444",
  "Utility Admin": "#f59e0b",
  "CSR": "#3b82f6",
  "Field Technician": "#22c55e",
  "Read-Only": "#8b5cf6",
  "Portal Customer": "#f59e0b",
};

export default function DevLaunchPage() {
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<TestUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiClient
      .get<TestUser[] | { data: TestUser[] }>("/api/v1/auth/dev-users")
      .then((res) => setUsers(Array.isArray(res) ? res : res.data ?? []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const staffUsers = users.filter((u) => !u.customerId);
  const portalUsers = users.filter((u) => u.customerId);

  const loginAs = (email: string) => {
    router.push(`/login?email=${encodeURIComponent(email)}`);
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
          Click a card to log in as that user. Staff go to the admin app, customers go to the portal.
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
        <>
          <SectionLabel>Staff users</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px", marginBottom: 32 }}>
            {staffUsers.map((u) => (
              <UserCard key={u.id} user={u} currentUserId={currentUser?.id} onClick={() => loginAs(u.email)} />
            ))}
          </div>

          {portalUsers.length > 0 && (
            <>
              <SectionLabel>Portal customers</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "16px" }}>
                {portalUsers.map((u) => (
                  <UserCard key={u.id} user={u} currentUserId={currentUser?.id} onClick={() => loginAs(u.email)} />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div style={{ textAlign: "center", marginTop: "40px", fontSize: "12px", color: "var(--text-muted)" }}>
        This page is for development testing only. Each card opens the login page with the user's email pre-filled.
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        color: "var(--text-muted)",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

function UserCard({
  user,
  currentUserId,
  onClick,
}: {
  user: TestUser;
  currentUserId?: string;
  onClick: () => void;
}) {
  const roleName = user.role?.name ?? "Unknown";
  const color = roleColors[roleName] ?? "var(--accent-primary)";
  const isCurrent = currentUserId === user.id;
  const isPortal = !!user.customerId;

  return (
    <button
      onClick={onClick}
      style={{
        background: isCurrent ? "var(--bg-elevated)" : "var(--bg-card)",
        border: isCurrent ? `2px solid ${color}` : "1px solid var(--border)",
        borderRadius: "12px",
        padding: "24px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
        transition: "all 0.2s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
        <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: `${color}22`, border: `2px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", fontWeight: 700, color, flexShrink: 0 }}>
          {user.name.charAt(0)}
        </div>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 600, color: "var(--text-primary)" }}>{user.name}</div>
          <div style={{ fontSize: "11px", color: "var(--text-muted)", fontFamily: "monospace" }}>{user.email}</div>
        </div>
      </div>

      <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 10px", borderRadius: "999px", fontSize: "11px", fontWeight: 600, background: `${color}18`, color }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
          {roleName}
        </span>
        {isPortal && (
          <span style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: "4px", background: "rgba(96,165,250,0.12)", color: "#60a5fa" }}>
            Portal
          </span>
        )}
        {isCurrent && (
          <span style={{ fontSize: "9px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", padding: "2px 6px", borderRadius: "4px", background: "rgba(52,211,153,0.12)", color: "#34d399" }}>
            Active
          </span>
        )}
      </div>

      <div style={{ marginTop: "16px", padding: "8px 0", textAlign: "center", fontSize: "12px", fontWeight: 500, color, borderTop: "1px solid var(--border)" }}>
        {isPortal ? "Open portal →" : "Open admin →"}
      </div>
    </button>
  );
}
