"use client";

// A named theme is a pair of fully-specified color palettes — one for
// dark mode and one for light mode. Users pick a theme as a coherent
// starting point, then tweak individual colors on top via the color
// pickers. All 14 tokens are defined in each palette so applying a
// theme completely replaces the current mode's palette without leaving
// orphaned tokens from a previous theme.

export type PaletteKey =
  | "--accent-primary"
  | "--accent-secondary"
  | "--success"
  | "--danger"
  | "--warning"
  | "--bg-deep"
  | "--bg-surface"
  | "--sidebar-bg"
  | "--header-bg"
  | "--bg-card"
  | "--bg-elevated"
  | "--bg-hover"
  | "--border"
  | "--border-subtle";

export type Palette = Record<PaletteKey, string>;

export interface NamedTheme {
  name: string;
  description: string;
  dark: Palette;
  light: Palette;
}

export const THEMES: NamedTheme[] = [
  {
    name: "Midnight",
    description: "Classic — deep indigo dark, near-white light",
    dark: {
      "--accent-primary": "#6366f1",
      "--accent-secondary": "#22d3ee",
      "--success": "#4ade80",
      "--danger": "#f87171",
      "--warning": "#fbbf24",
      "--bg-deep": "#06080d",
      "--bg-surface": "#0c1018",
      "--sidebar-bg": "#0c1018",
      "--header-bg": "#0c1018",
      "--bg-card": "#111722",
      "--bg-elevated": "#171f2e",
      "--bg-hover": "#1c2640",
      "--border": "#1e293b",
      "--border-subtle": "#162033",
    },
    light: {
      "--accent-primary": "#4f46e5",
      "--accent-secondary": "#0891b2",
      "--success": "#15803d",
      "--danger": "#b91c1c",
      "--warning": "#b45309",
      "--bg-deep": "#fbfcfe",
      "--bg-surface": "#f4f6fb",
      "--sidebar-bg": "#f4f6fb",
      "--header-bg": "#f4f6fb",
      "--bg-card": "#ffffff",
      "--bg-elevated": "#eef1f8",
      "--bg-hover": "#e2e8f4",
      "--border": "#dbe1ec",
      "--border-subtle": "#edf0f7",
    },
  },
  {
    name: "Indigo Wash",
    description: "Indigo-50 light surfaces, indigo sidebar and header",
    dark: {
      "--accent-primary": "#6366f1",
      "--accent-secondary": "#22d3ee",
      "--success": "#4ade80",
      "--danger": "#f87171",
      "--warning": "#fbbf24",
      "--bg-deep": "#06080d",
      "--bg-surface": "#0c1018",
      "--sidebar-bg": "#0c1018",
      "--header-bg": "#0c1018",
      "--bg-card": "#111722",
      "--bg-elevated": "#171f2e",
      "--bg-hover": "#1c2640",
      "--border": "#1e293b",
      "--border-subtle": "#162033",
    },
    light: {
      "--accent-primary": "#4f46e5",
      "--accent-secondary": "#0891b2",
      "--success": "#15803d",
      "--danger": "#b91c1c",
      "--warning": "#b45309",
      "--bg-deep": "#eef2ff",
      "--bg-surface": "#e0e7ff",
      "--sidebar-bg": "#e0e7ff",
      "--header-bg": "#e0e7ff",
      "--bg-card": "#ffffff",
      "--bg-elevated": "#dbe4ff",
      "--bg-hover": "#d2dcff",
      "--border": "#c7d2fe",
      "--border-subtle": "#dbe4ff",
    },
  },
  {
    name: "Paper",
    description: "Minimal — pure whites in light, near-black in dark",
    dark: {
      "--accent-primary": "#60a5fa",
      "--accent-secondary": "#22d3ee",
      "--success": "#4ade80",
      "--danger": "#f87171",
      "--warning": "#fbbf24",
      "--bg-deep": "#050505",
      "--bg-surface": "#0a0a0a",
      "--sidebar-bg": "#0a0a0a",
      "--header-bg": "#0a0a0a",
      "--bg-card": "#111111",
      "--bg-elevated": "#1a1a1a",
      "--bg-hover": "#1f1f1f",
      "--border": "#262626",
      "--border-subtle": "#1a1a1a",
    },
    light: {
      "--accent-primary": "#2563eb",
      "--accent-secondary": "#0891b2",
      "--success": "#15803d",
      "--danger": "#b91c1c",
      "--warning": "#b45309",
      "--bg-deep": "#ffffff",
      "--bg-surface": "#f9fafb",
      "--sidebar-bg": "#f9fafb",
      "--header-bg": "#ffffff",
      "--bg-card": "#ffffff",
      "--bg-elevated": "#f3f4f6",
      "--bg-hover": "#e5e7eb",
      "--border": "#e5e7eb",
      "--border-subtle": "#f3f4f6",
    },
  },
  {
    name: "Forest",
    description: "Emerald accents on deep-green and warm-cream surfaces",
    dark: {
      "--accent-primary": "#10b981",
      "--accent-secondary": "#22d3ee",
      "--success": "#4ade80",
      "--danger": "#f87171",
      "--warning": "#fbbf24",
      "--bg-deep": "#05110c",
      "--bg-surface": "#0a1a12",
      "--sidebar-bg": "#0a1a12",
      "--header-bg": "#0a1a12",
      "--bg-card": "#0f2018",
      "--bg-elevated": "#152c20",
      "--bg-hover": "#1a3a2a",
      "--border": "#1f3d2c",
      "--border-subtle": "#152c20",
    },
    light: {
      "--accent-primary": "#047857",
      "--accent-secondary": "#0891b2",
      "--success": "#15803d",
      "--danger": "#b91c1c",
      "--warning": "#b45309",
      "--bg-deep": "#f7faf8",
      "--bg-surface": "#ecf3ee",
      "--sidebar-bg": "#ecf3ee",
      "--header-bg": "#ecf3ee",
      "--bg-card": "#ffffff",
      "--bg-elevated": "#dfe9e2",
      "--bg-hover": "#cfdcd3",
      "--border": "#c6d5ca",
      "--border-subtle": "#dfe9e2",
    },
  },
];

interface PresetGridProps {
  onSelect: (theme: NamedTheme) => void;
  selectedName?: string;
  isEdited?: boolean;
  previewMode: "dark" | "light";
}

export function PresetGrid({ onSelect, selectedName, isEdited, previewMode }: PresetGridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "8px",
      }}
    >
      {THEMES.map((theme) => {
        const isSelected = theme.name === selectedName;
        // Cards show both palettes side-by-side so the pair is visible
        // at a glance — the user is picking a pair, not picking a mode.
        return (
          <button
            key={theme.name}
            onClick={() => onSelect(theme)}
            title={theme.description}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              padding: "0",
              borderRadius: "8px",
              border: isSelected
                ? `2px solid var(--accent-primary)`
                : "2px solid var(--border)",
              cursor: "pointer",
              transition: "border-color 0.15s ease, box-shadow 0.15s ease",
              boxShadow: isSelected
                ? `0 0 0 1px var(--accent-primary-subtle)`
                : "none",
              textAlign: "left",
              overflow: "hidden",
              background: "var(--bg-card)",
            }}
          >
            {/* Split preview — dark half, light half */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", height: "52px" }}>
              <PaletteSwatch palette={theme.dark} label="Dark" active={previewMode === "dark"} />
              <PaletteSwatch palette={theme.light} label="Light" active={previewMode === "light"} />
            </div>
            {/* Name */}
            <div style={{ padding: "0 10px 10px", display: "flex", flexDirection: "column", gap: "2px" }}>
              <div
                style={{
                  fontSize: "12px",
                  fontWeight: "600",
                  color: "var(--text-primary)",
                  letterSpacing: "0.01em",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {theme.name}
                {isSelected && isEdited && (
                  <span
                    style={{
                      fontSize: "9px",
                      fontWeight: 500,
                      color: "var(--text-muted)",
                      fontStyle: "italic",
                    }}
                  >
                    · edited
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "10px",
                  color: "var(--text-muted)",
                  lineHeight: 1.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {theme.description}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PaletteSwatch({
  palette,
  label,
  active,
}: {
  palette: Palette;
  label: string;
  active: boolean;
}) {
  return (
    <div
      style={{
        background: palette["--bg-deep"],
        borderRight: label === "Dark" ? "1px solid var(--border)" : "none",
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        opacity: active ? 1 : 0.62,
        transition: "opacity 0.15s ease",
      }}
    >
      {/* Color dots */}
      <div style={{ display: "flex", gap: "4px" }}>
        <span
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: palette["--bg-card"],
            border: `1px solid ${palette["--border"]}`,
            display: "inline-block",
          }}
        />
        <span
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: palette["--accent-primary"],
            display: "inline-block",
          }}
        />
        <span
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: palette["--accent-secondary"],
            display: "inline-block",
          }}
        />
      </div>
      <div
        style={{
          fontSize: "9px",
          color: palette["--bg-deep"] < "#888888" ? "#cbd5e1" : "#475569",
          fontWeight: 500,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
    </div>
  );
}

// Keep the old type name exported as a backward-compat alias so any
// external caller importing `ThemePreset` won't break — but inside this
// file the canonical type is `NamedTheme`.
export type ThemePreset = NamedTheme;
