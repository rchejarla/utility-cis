"use client";

interface StatusBadgeProps {
  status: string;
}

type StatusStyle = {
  dot: string;
  bg: string;
  text: string;
  label: string;
};

function getStatusStyle(status: string): StatusStyle {
  const s = status?.toLowerCase() ?? "";

  if (s === "active") {
    return { dot: "#22c55e", bg: "rgba(34,197,94,0.12)", text: "#4ade80", label: "Active" };
  }
  if (s === "inactive" || s === "pending") {
    return { dot: "#f59e0b", bg: "rgba(245,158,11,0.12)", text: "#fbbf24", label: status };
  }
  if (s === "closed" || s === "final") {
    return { dot: "#64748b", bg: "rgba(100,116,139,0.12)", text: "#94a3b8", label: status };
  }
  if (s === "condemned" || s === "suspended") {
    return { dot: "#ef4444", bg: "rgba(239,68,68,0.12)", text: "#f87171", label: status };
  }
  // Default / unknown
  return { dot: "#64748b", bg: "rgba(100,116,139,0.12)", text: "#94a3b8", label: status };
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const style = getStatusStyle(status);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "5px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: style.bg,
        fontSize: "11px",
        fontWeight: "500",
        color: style.text,
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: "5px",
          height: "5px",
          borderRadius: "50%",
          background: style.dot,
          flexShrink: 0,
        }}
      />
      {style.label}
    </span>
  );
}
