"use client";

const PREMISE_TYPES = [
  { value: "RESIDENTIAL", label: "Residential", color: "#3b82f6" },
  { value: "COMMERCIAL", label: "Commercial", color: "#f59e0b" },
  { value: "INDUSTRIAL", label: "Industrial", color: "#a78bfa" },
  { value: "CONDEMNED", label: "Condemned", color: "#fb7185" },
];

interface MapFiltersProps {
  activeTypes: string[];
  onToggle: (type: string) => void;
}

export function MapFilters({ activeTypes, onToggle }: MapFiltersProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: "12px",
        left: "12px",
        display: "flex",
        gap: "6px",
        flexWrap: "wrap",
        zIndex: 10,
      }}
    >
      {PREMISE_TYPES.map((type) => {
        const isActive = activeTypes.includes(type.value);
        return (
          <button
            key={type.value}
            onClick={() => onToggle(type.value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "5px 12px",
              fontSize: "12px",
              fontWeight: "500",
              borderRadius: "999px",
              border: `1px solid ${isActive ? type.color : "var(--border)"}`,
              background: isActive
                ? `${type.color}22`
                : "var(--bg-card)",
              color: isActive ? type.color : "var(--text-secondary)",
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "all 0.15s ease",
              boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: isActive ? type.color : "var(--text-muted)",
                flexShrink: 0,
              }}
            />
            {type.label}
          </button>
        );
      })}
    </div>
  );
}
