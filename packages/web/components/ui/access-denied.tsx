"use client";

export function AccessDenied() {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "400px",
      color: "var(--text-muted)",
      gap: "12px",
    }}>
      <div style={{ fontSize: "48px" }}>🔒</div>
      <div style={{ fontSize: "18px", fontWeight: 600, color: "var(--text-primary)" }}>Access Denied</div>
      <div style={{ fontSize: "14px" }}>You don't have permission to view this page.</div>
    </div>
  );
}
