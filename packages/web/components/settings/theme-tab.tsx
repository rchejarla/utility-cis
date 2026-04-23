"use client";

import { useState, useEffect, useCallback } from "react";
import { ColorPickerField } from "@/components/theme/color-picker-field";
import { PresetGrid, NamedTheme, THEMES } from "@/components/theme/preset-grid";
import { LivePreview, PreviewTheme } from "@/components/theme/live-preview";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { useTheme } from "@/lib/theme-provider";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

type ColorKey =
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

type ColorSet = Record<ColorKey, string>;
type Mode = "dark" | "light";

interface WorkingTheme {
  themeName: string;
  dark: ColorSet;
  light: ColorSet;
  bodyFont: string;
  displayFont: string;
  borderRadius: number;
}

// "Indigo Wash" is the current shipping default — matches globals.css.
const DEFAULT_THEME_NAME = "Indigo Wash";

function defaultsFor(themeName: string): { dark: ColorSet; light: ColorSet } {
  const theme = THEMES.find((t) => t.name === themeName) ?? THEMES[0];
  return { dark: { ...theme.dark } as ColorSet, light: { ...theme.light } as ColorSet };
}

const DEFAULT_THEME: WorkingTheme = {
  themeName: DEFAULT_THEME_NAME,
  ...defaultsFor(DEFAULT_THEME_NAME),
  bodyFont: "default",
  displayFont: "default",
  borderRadius: 10,
};

const FONT_OPTIONS = [
  { value: "default", label: "Default (DM Sans)" },
  { value: "Inter", label: "Inter" },
  { value: "Geist", label: "Geist" },
  { value: "Roboto", label: "Roboto" },
  { value: "Poppins", label: "Poppins" },
  { value: "Space Grotesk", label: "Space Grotesk" },
];

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function workingToPreview(t: WorkingTheme, mode: Mode): PreviewTheme {
  const c = t[mode];
  const isDark = mode === "dark";
  return {
    bgDeep: c["--bg-deep"],
    bgCard: c["--bg-card"],
    bgElevated: c["--bg-elevated"],
    border: c["--border"],
    textPrimary: isDark ? "#e8edf5" : "#0f172a",
    textSecondary: isDark ? "#8494ad" : "#475569",
    textMuted: isDark ? "#4a5a73" : "#64748b",
    accentPrimary: c["--accent-primary"],
    accentSecondary: c["--accent-secondary"],
    success: c["--success"],
    danger: c["--danger"],
    warning: c["--warning"],
    borderRadius: t.borderRadius,
    bodyFont: t.bodyFont,
    displayFont: t.displayFont,
  };
}

function SubSection({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "10px",
        fontWeight: "700",
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.1em",
        paddingBottom: "8px",
        borderBottom: "1px solid var(--border)",
        marginBottom: "12px",
      }}
    >
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// ThemeTab — embedded inside /settings/theme
// ──────────────────────────────────────────────────────────────

export function ThemeTab() {
  const { canEdit } = usePermission("theme");
  const { mode: appMode } = useTheme();
  const initialMode: Mode = appMode === "light" ? "light" : "dark";

  const [theme, setTheme] = useState<WorkingTheme>(DEFAULT_THEME);
  const [editMode, setEditMode] = useState<Mode>(initialMode);
  const [isEdited, setIsEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    async function loadTheme() {
      try {
        const data = await apiClient.get<{
          preset?: string;
          colors?: { dark?: Partial<ColorSet>; light?: Partial<ColorSet> };
        }>("/api/v1/theme");
        if (!data) return;
        const savedName = typeof data.preset === "string" ? data.preset : DEFAULT_THEME_NAME;
        const base = defaultsFor(savedName);
        const darkPalette = { ...base.dark, ...(data.colors?.dark ?? {}) } as ColorSet;
        const lightPalette = { ...base.light, ...(data.colors?.light ?? {}) } as ColorSet;
        setTheme((prev) => ({
          ...prev,
          themeName: savedName,
          dark: darkPalette,
          light: lightPalette,
        }));
        const baseDark = JSON.stringify(base.dark);
        const baseLight = JSON.stringify(base.light);
        const currentDark = JSON.stringify(darkPalette);
        const currentLight = JSON.stringify(lightPalette);
        setIsEdited(baseDark !== currentDark || baseLight !== currentLight);
      } catch {
        // defaults apply
      }
    }
    loadTheme();
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);

  const handleThemeSelect = useCallback((t: NamedTheme) => {
    setTheme((prev) => ({
      ...prev,
      themeName: t.name,
      dark: { ...t.dark } as ColorSet,
      light: { ...t.light } as ColorSet,
    }));
    setIsEdited(false);
  }, []);

  const setColor = (key: ColorKey, value: string) => {
    setIsEdited(true);
    setTheme((prev) => ({
      ...prev,
      [editMode]: { ...prev[editMode], [key]: value },
    }));
  };

  const setMeta = <K extends "bodyFont" | "displayFont" | "borderRadius">(
    key: K,
    value: WorkingTheme[K],
  ) => {
    setTheme((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        preset: theme.themeName,
        colors: { dark: theme.dark, light: theme.light },
      };
      await apiClient.put("/api/v1/theme", payload);
      setMessage({ type: "success", text: "Theme saved — applied across the app." });
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save theme.";
      setMessage({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await apiClient.post("/api/v1/theme/reset", {});
      setTheme(DEFAULT_THEME);
      setIsEdited(false);
      setMessage({ type: "success", text: "Theme reset to defaults." });
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to reset theme.";
      setMessage({ type: "error", text: msg });
    } finally {
      setResetting(false);
    }
  };

  const previewTheme = workingToPreview(theme, editMode);
  const current = theme[editMode];

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "7px 10px",
    borderRadius: "6px",
    border: "1px solid var(--border)",
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    fontSize: "13px",
    fontFamily: "inherit",
    outline: "none",
    appearance: "none",
    WebkitAppearance: "none",
    cursor: "pointer",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* ── Toolbar: actions + message ───────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "8px",
        }}
      >
        {message && (
          <span
            style={{
              fontSize: "12px",
              color: message.type === "success" ? "var(--accent-primary)" : "var(--danger)",
              padding: "6px 12px",
              borderRadius: "6px",
              background:
                message.type === "success"
                  ? "var(--accent-primary-subtle)"
                  : "var(--danger-subtle)",
              border: `1px solid ${
                message.type === "success" ? "var(--accent-primary)" : "var(--danger)"
              }40`,
            }}
          >
            {message.text}
          </span>
        )}
        {canEdit && (
          <button
            onClick={handleReset}
            disabled={resetting}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-secondary)",
              fontSize: "13px",
              fontWeight: "500",
              cursor: resetting ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: resetting ? 0.6 : 1,
              transition: "opacity 0.15s ease",
            }}
          >
            {resetting ? "Resetting…" : "Reset to Default"}
          </button>
        )}
        {canEdit && (
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "8px 20px",
              borderRadius: "var(--radius)",
              background: "var(--accent-primary)",
              border: "none",
              color: "#fff",
              fontSize: "13px",
              fontWeight: "600",
              cursor: saving ? "not-allowed" : "pointer",
              fontFamily: "inherit",
              opacity: saving ? 0.7 : 1,
              transition: "opacity 0.15s ease",
            }}
          >
            {saving ? "Saving…" : "Save & Apply"}
          </button>
        )}
      </div>

      {/* ── Body: left panel + right preview ─────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "320px 1fr",
          gap: "20px",
          alignItems: "start",
          minHeight: "600px",
        }}
      >
        {/* ── Left panel ─────────────────────────────────────── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div>
            <SubSection>Preview Mode</SubSection>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "6px",
                padding: "4px",
                background: "var(--bg-elevated)",
                borderRadius: "8px",
              }}
            >
              {(["dark", "light"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setEditMode(m)}
                  style={{
                    padding: "7px 12px",
                    borderRadius: "6px",
                    border: "none",
                    background: editMode === m ? "var(--accent-primary)" : "transparent",
                    color: editMode === m ? "#fff" : "var(--text-secondary)",
                    fontSize: "12px",
                    fontWeight: editMode === m ? "600" : "500",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textTransform: "capitalize",
                    transition: "all 0.15s ease",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            <p style={{ fontSize: "11px", color: "var(--text-muted)", margin: "6px 0 0" }}>
              Editing the {editMode} palette of <strong>{theme.themeName}</strong>. Save writes both.
            </p>
          </div>

          <div>
            <SubSection>Theme</SubSection>
            <PresetGrid
              onSelect={handleThemeSelect}
              selectedName={theme.themeName}
              isEdited={isEdited}
              previewMode={editMode}
            />
          </div>

          <div>
            <SubSection>Brand Colors</SubSection>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <ColorPickerField label="Primary Accent" value={current["--accent-primary"]} onChange={(v) => setColor("--accent-primary", v)} />
              <ColorPickerField label="Secondary Accent" value={current["--accent-secondary"]} onChange={(v) => setColor("--accent-secondary", v)} />
              <ColorPickerField label="Success" value={current["--success"]} onChange={(v) => setColor("--success", v)} />
              <ColorPickerField label="Danger" value={current["--danger"]} onChange={(v) => setColor("--danger", v)} />
              <ColorPickerField label="Warning" value={current["--warning"]} onChange={(v) => setColor("--warning", v)} />
            </div>
          </div>

          <div>
            <SubSection>Surface Colors</SubSection>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <ColorPickerField label="Page Background" value={current["--bg-deep"]} onChange={(v) => setColor("--bg-deep", v)} />
              <ColorPickerField label="Sidebar Background" value={current["--sidebar-bg"]} onChange={(v) => setColor("--sidebar-bg", v)} />
              <ColorPickerField label="Header Background" value={current["--header-bg"]} onChange={(v) => setColor("--header-bg", v)} />
              <ColorPickerField label="Card / Panel" value={current["--bg-card"]} onChange={(v) => setColor("--bg-card", v)} />
              <ColorPickerField label="Elevated Surface" value={current["--bg-elevated"]} onChange={(v) => setColor("--bg-elevated", v)} />
              <ColorPickerField label="Hover Surface" value={current["--bg-hover"]} onChange={(v) => setColor("--bg-hover", v)} />
              <ColorPickerField label="Border" value={current["--border"]} onChange={(v) => setColor("--border", v)} />
            </div>
          </div>

          <div>
            <SubSection>Typography</SubSection>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: "500", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Body Font
                </label>
                <select value={theme.bodyFont} onChange={(e) => setMeta("bodyFont", e.target.value)} style={selectStyle}>
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label style={{ fontSize: "11px", fontWeight: "500", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  Display Font
                </label>
                <select value={theme.displayFont} onChange={(e) => setMeta("displayFont", e.target.value)} style={selectStyle}>
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div>
            <SubSection>Border Radius</SubSection>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>Roundness</span>
                <span style={{ fontSize: "12px", fontFamily: "monospace", color: "var(--accent-primary)", fontWeight: "600" }}>
                  {theme.borderRadius}px
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={theme.borderRadius}
                onChange={(e) => setMeta("borderRadius", Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--accent-primary)", cursor: "pointer" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: "var(--text-muted)" }}>
                <span>Sharp</span>
                <span>Rounded</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Right preview panel ─────────────────────────────── */}
        <div
          style={{
            background: "var(--bg-elevated)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            position: "sticky",
            top: "24px",
            maxHeight: "calc(100vh - 120px)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              fontSize: "11px",
              fontWeight: "600",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              marginBottom: "12px",
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            Live Preview
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "999px",
                background: "var(--accent-primary-subtle)",
                color: "var(--accent-primary)",
                fontSize: "10px",
                textTransform: "capitalize",
                letterSpacing: "0",
                fontWeight: "600",
              }}
            >
              {editMode} palette
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            <LivePreview theme={previewTheme} />
          </div>
        </div>
      </div>
    </div>
  );
}
