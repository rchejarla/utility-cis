"use client";

const LEGEND_ITEMS = [
  { label: "Residential", color: "#3b82f6" },
  { label: "Commercial", color: "#f59e0b" },
  { label: "Industrial", color: "#a78bfa" },
  { label: "Condemned", color: "#fb7185" },
];

export function MapLegend() {
  return (
    <div
      style={{
        position: "absolute",
        bottom: "32px",
        left: "12px",
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        zIndex: 10,
        boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        minWidth: "130px",
      }}
    >
      <div
        style={{
          fontSize: "10px",
          fontWeight: "600",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: "2px",
        }}
      >
        Premise Type
      </div>
      {LEGEND_ITEMS.map((item) => (
        <div
          key={item.label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "50%",
              background: item.color,
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}
