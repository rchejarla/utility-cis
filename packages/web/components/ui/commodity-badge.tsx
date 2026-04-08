"use client";

interface CommodityBadgeProps {
  commodity: string;
}

type CommodityStyle = {
  bg: string;
  text: string;
  border: string;
};

// Normalize name → code for display
function toCode(commodity: string): string {
  const c = commodity?.toUpperCase().trim() ?? "";
  if (c === "ELECTRICITY" || c === "ELECTRIC") return "ELECTRIC";
  if (c === "POTABLE WATER" || c === "WATER") return "WATER";
  if (c === "NATURAL GAS" || c === "GAS") return "GAS";
  if (c === "SEWER") return "SEWER";
  return c;
}

function getCommodityStyle(commodity: string): CommodityStyle {
  const c = toCode(commodity);

  if (c === "WATER") {
    return { bg: "rgba(59,130,246,0.12)", text: "#60a5fa", border: "rgba(59,130,246,0.25)" };
  }
  if (c === "ELECTRIC") {
    return { bg: "rgba(245,158,11,0.12)", text: "#fbbf24", border: "rgba(245,158,11,0.25)" };
  }
  if (c === "GAS") {
    return { bg: "rgba(139,92,246,0.12)", text: "#a78bfa", border: "rgba(139,92,246,0.25)" };
  }
  if (c === "SEWER") {
    return { bg: "rgba(34,197,94,0.12)", text: "#4ade80", border: "rgba(34,197,94,0.25)" };
  }
  // Default
  return { bg: "rgba(100,116,139,0.12)", text: "#94a3b8", border: "rgba(100,116,139,0.25)" };
}

export function CommodityBadge({ commodity }: CommodityBadgeProps) {
  const style = getCommodityStyle(commodity);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "6px",
        background: style.bg,
        border: `1px solid ${style.border}`,
        fontSize: "11px",
        fontWeight: "600",
        color: style.text,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
      }}
    >
      {toCode(commodity) || "—"}
    </span>
  );
}
