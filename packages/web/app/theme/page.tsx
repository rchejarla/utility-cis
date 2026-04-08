"use client";

import { useState, useEffect, useCallback } from "react";
import { ColorPickerField } from "@/components/theme/color-picker-field";
import { PresetGrid, ThemePreset } from "@/components/theme/preset-grid";
import { LivePreview, PreviewTheme } from "@/components/theme/live-preview";
import { apiClient, API_URL } from "@/lib/api-client";

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface WorkingTheme {
  // Brand / accent colors
  accentPrimary: string;
  accentSecondary: string;
  success: string;
  danger: string;
  warning: string;
  // Surface colors
  bgDeep: string;
  bgCard: string;
  border: string;
  // Typography
  bodyFont: string;
  displayFont: string;
  // Border radius
  borderRadius: number;
}

const DEFAULT_THEME: WorkingTheme = {
  accentPrimary: "#3b82f6",
  accentSecondary: "#22d3ee",
  success: "#22c55e",
  danger: "#ef4444",
  warning: "#f59e0b",
  bgDeep: "#06080d",
  bgCard: "#111722",
  border: "#1e293b",
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

function deriveElevated(hex: string): string {
  // Lighten the bgCard a bit for elevated surfaces
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const factor = 1.4;
    const toHex = (n: number) =>
      Math.min(255, Math.round(n * factor))
        .toString(16)
        .padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return hex;
  }
}

function workingToPreview(t: WorkingTheme): PreviewTheme {
  return {
    bgDeep: t.bgDeep,
    bgCard: t.bgCard,
    bgElevated: deriveElevated(t.bgCard),
    border: t.border,
    textPrimary: "#e8edf5",
    textSecondary: "#8494ad",
    textMuted: "#4a5a73",
    accentPrimary: t.accentPrimary,
    accentSecondary: t.accentSecondary,
    success: t.success,
    danger: t.danger,
    warning: t.warning,
    borderRadius: t.borderRadius,
    bodyFont: t.bodyFont,
    displayFont: t.displayFont,
  };
}

// ──────────────────────────────────────────────────────────────
// Section heading
// ──────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
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
// Page
// ──────────────────────────────────────────────────────────────

export default function ThemeEditorPage() {
  const [theme, setTheme] = useState<WorkingTheme>(DEFAULT_THEME);
  const [selectedPreset, setSelectedPreset] = useState<string | undefined>("Midnight");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // ── Load current theme from API on mount ──────────────────
  useEffect(() => {
    async function loadTheme() {
      try {
        const data = await fetch(`${API_URL}/api/v1/theme`).then((r) =>
          r.ok ? r.json() : null
        );
        if (data?.colors?.dark) {
          const c = data.colors.dark as Record<string, string>;
          setTheme((prev) => ({
            ...prev,
            accentPrimary: c["--accent-primary"] ?? prev.accentPrimary,
            accentSecondary: c["--accent-secondary"] ?? prev.accentSecondary,
            bgDeep: c["--bg-deep"] ?? prev.bgDeep,
            bgCard: c["--bg-card"] ?? prev.bgCard,
            border: c["--border"] ?? prev.border,
          }));
          setSelectedPreset(undefined);
        }
      } catch {
        // Silently fall through — defaults apply
      }
    }
    loadTheme();
  }, []);

  // ── Dismiss message after a few seconds ──────────────────
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);

  // ── Preset click ──────────────────────────────────────────
  const handlePresetSelect = useCallback((preset: ThemePreset) => {
    setSelectedPreset(preset.name);
    setTheme((prev) => ({
      ...prev,
      bgDeep: preset.bgDeep,
      bgCard: preset.bgCard,
      accentPrimary: preset.accentPrimary,
      border: preset.border,
    }));
  }, []);

  // ── Field update helper ───────────────────────────────────
  const set = <K extends keyof WorkingTheme>(key: K, value: WorkingTheme[K]) => {
    setSelectedPreset(undefined);
    setTheme((prev) => ({ ...prev, [key]: value }));
  };

  // ── Save ─────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        colors: {
          dark: {
            "--accent-primary": theme.accentPrimary,
            "--accent-secondary": theme.accentSecondary,
            "--bg-deep": theme.bgDeep,
            "--bg-card": theme.bgCard,
            "--border": theme.border,
          },
        },
      };
      await apiClient.put("/api/v1/theme", payload);
      setMessage({ type: "success", text: "Theme saved successfully." });
      // Refresh the theme context by re-fetching
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to save theme.";
      setMessage({ type: "error", text: msg });
    } finally {
      setSaving(false);
    }
  };

  // ── Reset ────────────────────────────────────────────────
  const handleReset = async () => {
    setResetting(true);
    try {
      await apiClient.post("/api/v1/theme/reset", {});
      setTheme(DEFAULT_THEME);
      setSelectedPreset("Midnight");
      setMessage({ type: "success", text: "Theme reset to defaults." });
      window.location.reload();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to reset theme.";
      setMessage({ type: "error", text: msg });
    } finally {
      setResetting(false);
    }
  };

  const previewTheme = workingToPreview(theme);

  // ── Shared input style ────────────────────────────────────
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "0" }}>
      {/* ── Header ───────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "20px",
          flexShrink: 0,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: "700",
              color: "var(--text-primary)",
              margin: "0 0 4px",
            }}
          >
            Theme Editor
          </h1>
          <p style={{ fontSize: "13px", color: "var(--text-secondary)", margin: 0 }}>
            Customize your workspace appearance
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {message && (
            <span
              style={{
                fontSize: "12px",
                color: message.type === "success" ? "var(--accent-primary)" : "#f87171",
                padding: "6px 12px",
                borderRadius: "6px",
                background:
                  message.type === "success"
                    ? "rgba(59,130,246,0.1)"
                    : "rgba(239,68,68,0.1)",
                border: `1px solid ${
                  message.type === "success"
                    ? "rgba(59,130,246,0.25)"
                    : "rgba(239,68,68,0.25)"
                }`,
              }}
            >
              {message.text}
            </span>
          )}
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
            {saving ? "Saving…" : "Save Theme"}
          </button>
        </div>
      </div>

      {/* ── Body: left panel + right preview ─────────────────── */}
      <div
        style={{
          display: "flex",
          gap: "20px",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* ── Left panel ─────────────────────────────────────── */}
        <div
          style={{
            width: "300px",
            minWidth: "300px",
            display: "flex",
            flexDirection: "column",
            gap: "20px",
            overflowY: "auto",
            paddingRight: "4px",
          }}
        >
          {/* Presets */}
          <div>
            <SectionTitle>Presets</SectionTitle>
            <PresetGrid onSelect={handlePresetSelect} selectedName={selectedPreset} />
          </div>

          {/* Brand Colors */}
          <div>
            <SectionTitle>Brand Colors</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <ColorPickerField
                label="Primary Accent"
                value={theme.accentPrimary}
                onChange={(v) => set("accentPrimary", v)}
              />
              <ColorPickerField
                label="Secondary Accent"
                value={theme.accentSecondary}
                onChange={(v) => set("accentSecondary", v)}
              />
              <ColorPickerField
                label="Success"
                value={theme.success}
                onChange={(v) => set("success", v)}
              />
              <ColorPickerField
                label="Danger"
                value={theme.danger}
                onChange={(v) => set("danger", v)}
              />
              <ColorPickerField
                label="Warning"
                value={theme.warning}
                onChange={(v) => set("warning", v)}
              />
            </div>
          </div>

          {/* Surface Colors */}
          <div>
            <SectionTitle>Surface Colors</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <ColorPickerField
                label="Background Deep"
                value={theme.bgDeep}
                onChange={(v) => set("bgDeep", v)}
              />
              <ColorPickerField
                label="Card / Panel"
                value={theme.bgCard}
                onChange={(v) => set("bgCard", v)}
              />
              <ColorPickerField
                label="Border"
                value={theme.border}
                onChange={(v) => set("border", v)}
              />
            </div>
          </div>

          {/* Typography */}
          <div>
            <SectionTitle>Typography</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Body Font
                </label>
                <select
                  value={theme.bodyFont}
                  onChange={(e) => set("bodyFont", e.target.value)}
                  style={selectStyle}
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "500",
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Display Font
                </label>
                <select
                  value={theme.displayFont}
                  onChange={(e) => set("displayFont", e.target.value)}
                  style={selectStyle}
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Border Radius */}
          <div>
            <SectionTitle>Border Radius</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  Roundness
                </span>
                <span
                  style={{
                    fontSize: "12px",
                    fontFamily: "monospace",
                    color: "var(--accent-primary)",
                    fontWeight: "600",
                  }}
                >
                  {theme.borderRadius}px
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={20}
                step={1}
                value={theme.borderRadius}
                onChange={(e) => set("borderRadius", Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--accent-primary)", cursor: "pointer" }}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "10px",
                  color: "var(--text-muted)",
                }}
              >
                <span>Sharp</span>
                <span>Rounded</span>
              </div>
            </div>
          </div>
        </div>

        {/* ── Right preview panel ─────────────────────────────── */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg-elevated)",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            padding: "16px",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
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
            }}
          >
            Live Preview
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <LivePreview theme={previewTheme} />
          </div>
        </div>
      </div>
    </div>
  );
}
