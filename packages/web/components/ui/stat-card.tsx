"use client";

type StatAccent = "primary" | "secondary" | "tertiary" | "success" | "warning" | "danger" | "info";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: string;
  // Colored 3px left rail. Defaults to the brand primary so existing
  // call sites get a subtle accent without changes. Dashboards with
  // multiple tiles can vary accent for at-a-glance category cues.
  accent?: StatAccent;
}

const ACCENT_VAR: Record<StatAccent, string> = {
  primary: "var(--accent-primary)",
  secondary: "var(--accent-secondary)",
  tertiary: "var(--accent-tertiary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
};

export function StatCard({ label, value, icon, accent = "primary" }: StatCardProps) {
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${ACCENT_VAR[accent]}`,
        borderRadius: "var(--radius)",
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        gap: "14px",
        flex: "1 1 160px",
        minWidth: 0,
      }}
    >
      {icon && (
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "8px",
            background: "var(--bg-elevated)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: "22px",
            fontWeight: "700",
            color: "var(--text-primary)",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineHeight: "1.2",
            letterSpacing: "-0.02em",
          }}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-muted)",
            marginTop: "2px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}
