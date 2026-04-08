"use client";

export interface ThemePreset {
  name: string;
  mode: "dark" | "light";
  bgDeep: string;
  bgCard: string;
  accentPrimary: string;
  textPrimary: string;
  border: string;
}

export const PRESETS: ThemePreset[] = [
  {
    name: "Midnight",
    mode: "dark",
    bgDeep: "#06080d",
    bgCard: "#111722",
    accentPrimary: "#3b82f6",
    textPrimary: "#e8edf5",
    border: "#1e293b",
  },
  {
    name: "Daybreak",
    mode: "light",
    bgDeep: "#ffffff",
    bgCard: "#ffffff",
    accentPrimary: "#0f766e",
    textPrimary: "#0f172a",
    border: "#e2e8f0",
  },
  {
    name: "Dusk",
    mode: "dark",
    bgDeep: "#0c0a1a",
    bgCard: "#13102a",
    accentPrimary: "#8b5cf6",
    textPrimary: "#e8edf5",
    border: "#2d2050",
  },
  {
    name: "Forest",
    mode: "dark",
    bgDeep: "#0a0f0d",
    bgCard: "#101a14",
    accentPrimary: "#22c55e",
    textPrimary: "#e8edf5",
    border: "#1a3024",
  },
];

interface PresetGridProps {
  onSelect: (preset: ThemePreset) => void;
  selectedName?: string;
}

export function PresetGrid({ onSelect, selectedName }: PresetGridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "8px",
      }}
    >
      {PRESETS.map((preset) => {
        const isSelected = preset.name === selectedName;
        return (
          <button
            key={preset.name}
            onClick={() => onSelect(preset)}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "10px",
              borderRadius: "8px",
              border: isSelected
                ? `2px solid ${preset.accentPrimary}`
                : "2px solid var(--border)",
              background: preset.bgDeep,
              cursor: "pointer",
              transition: "border-color 0.15s ease, box-shadow 0.15s ease",
              boxShadow: isSelected
                ? `0 0 0 1px ${preset.accentPrimary}40`
                : "none",
              textAlign: "left",
            }}
          >
            {/* Color dots row */}
            <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
              {/* BG dot */}
              <span
                style={{
                  width: "14px",
                  height: "14px",
                  borderRadius: "50%",
                  background: preset.bgCard,
                  border: `1px solid ${preset.border}`,
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
              {/* Accent dot */}
              <span
                style={{
                  width: "14px",
                  height: "14px",
                  borderRadius: "50%",
                  background: preset.accentPrimary,
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
              {/* Text dot */}
              <span
                style={{
                  width: "14px",
                  height: "14px",
                  borderRadius: "50%",
                  background: preset.textPrimary,
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
            </div>
            {/* Preset name */}
            <div
              style={{
                fontSize: "12px",
                fontWeight: "500",
                color: preset.textPrimary,
                letterSpacing: "0.01em",
              }}
            >
              {preset.name}
            </div>
            {/* Mode label */}
            <div
              style={{
                fontSize: "10px",
                color: preset.accentPrimary,
                fontWeight: "500",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              {preset.mode}
            </div>
          </button>
        );
      })}
    </div>
  );
}
