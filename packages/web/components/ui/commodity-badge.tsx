"use client";

interface CommodityBadgeProps {
  commodity: string;
}

// Normalize name → code for display
function toCode(commodity: string): string {
  const c = commodity?.toUpperCase().trim() ?? "";
  if (c === "ELECTRICITY" || c === "ELECTRIC") return "ELECTRIC";
  if (c === "POTABLE WATER" || c === "WATER") return "WATER";
  if (c === "NATURAL GAS" || c === "GAS") return "GAS";
  if (c === "SEWER") return "SEWER";
  return c;
}

type Accent = "info" | "warning" | "tertiary" | "success" | "neutral";

function getAccent(commodity: string): Accent {
  const c = toCode(commodity);
  if (c === "WATER") return "info";
  if (c === "ELECTRIC") return "warning";
  if (c === "GAS") return "tertiary";
  if (c === "SEWER") return "success";
  return "neutral";
}

const ACCENT_VARS: Record<Accent, { bg: string; fg: string; border: string }> = {
  info: { bg: "var(--info-subtle)", fg: "var(--info)", border: "var(--info)" },
  warning: { bg: "var(--warning-subtle)", fg: "var(--warning)", border: "var(--warning)" },
  tertiary: {
    bg: "var(--accent-tertiary-subtle)",
    fg: "var(--accent-tertiary)",
    border: "var(--accent-tertiary)",
  },
  success: { bg: "var(--success-subtle)", fg: "var(--success)", border: "var(--success)" },
  neutral: { bg: "var(--bg-elevated)", fg: "var(--text-secondary)", border: "var(--border)" },
};

export function CommodityBadge({ commodity }: CommodityBadgeProps) {
  const vars = ACCENT_VARS[getAccent(commodity)];

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "6px",
        background: vars.bg,
        border: `1px solid ${vars.border}`,
        fontSize: "11px",
        fontWeight: 600,
        color: vars.fg,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        width: "fit-content",
        justifySelf: "start",
      }}
    >
      {toCode(commodity) || "—"}
    </span>
  );
}
