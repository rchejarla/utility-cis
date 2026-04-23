import { describe, it, expect } from "vitest";
import {
  defaultsFor,
  mergeSavedWithDefaults,
  workingToPreview,
  DEFAULT_THEME_NAME,
  THEMES,
  ColorSet,
} from "../theme-tab-helpers";

/**
 * Pure-helper tests for the theme editor. The stateful parts of the
 * editor (state transitions on preset click, color change, mode
 * toggle) would need @testing-library/react — here we cover the merge
 * + projection rules that were the source of earlier bugs
 * (silent-strip save, stale overlay on reload).
 */

const INDIGO_WASH = THEMES.find((t) => t.name === "Indigo Wash")!;
const MIDNIGHT = THEMES.find((t) => t.name === "Midnight")!;

describe("defaultsFor", () => {
  it("returns deep-copied palettes for a known theme", () => {
    const { dark, light } = defaultsFor("Midnight");
    expect(dark).toEqual(MIDNIGHT.dark);
    expect(light).toEqual(MIDNIGHT.light);
    // Mutating the returned palette must not affect the source.
    dark["--bg-deep"] = "#000000";
    expect(MIDNIGHT.dark["--bg-deep"]).not.toBe("#000000");
  });

  it("falls back to the first theme when the name is unknown", () => {
    const unknown = defaultsFor("Not A Real Theme");
    const first = defaultsFor(THEMES[0].name);
    expect(unknown).toEqual(first);
  });
});

describe("mergeSavedWithDefaults", () => {
  it("uses DEFAULT_THEME_NAME when the saved preset is missing", () => {
    const merged = mergeSavedWithDefaults(undefined, undefined);
    expect(merged.themeName).toBe(DEFAULT_THEME_NAME);
    expect(merged.dark).toEqual(INDIGO_WASH.dark);
    expect(merged.light).toEqual(INDIGO_WASH.light);
    expect(merged.isEdited).toBe(false);
  });

  it("returns the theme's defaults with isEdited=false when no overrides are stored", () => {
    const merged = mergeSavedWithDefaults("Midnight", { dark: {}, light: {} });
    expect(merged.themeName).toBe("Midnight");
    expect(merged.dark).toEqual(MIDNIGHT.dark);
    expect(merged.light).toEqual(MIDNIGHT.light);
    expect(merged.isEdited).toBe(false);
  });

  it("flags isEdited=true when any saved value differs from the theme default", () => {
    const merged = mergeSavedWithDefaults("Midnight", {
      dark: {},
      light: { "--accent-primary": "#ff00aa" },
    });
    expect(merged.isEdited).toBe(true);
    expect(merged.light["--accent-primary"]).toBe("#ff00aa");
    // Non-overridden keys keep the theme default.
    expect(merged.light["--bg-deep"]).toBe(MIDNIGHT.light["--bg-deep"]);
  });

  it("treats partial overrides as edited even if only one mode changes", () => {
    const merged = mergeSavedWithDefaults("Midnight", {
      dark: { "--text-primary": "#ffffff" },
    });
    expect(merged.isEdited).toBe(true);
    expect(merged.dark["--text-primary"]).toBe("#ffffff");
    // Light palette stays pristine.
    expect(merged.light).toEqual(MIDNIGHT.light);
  });

  it("applies the named theme's defaults even when the name came from a stale DB row", () => {
    // Simulates a tenant row saved against an old preset name that
    // doesn't exist in THEMES anymore. We still want a coherent
    // palette rather than an empty editor.
    const merged = mergeSavedWithDefaults("Retired Theme X", undefined);
    // Falls back to the first theme — same as defaultsFor does.
    const fallback = defaultsFor("Retired Theme X");
    expect(merged.dark).toEqual(fallback.dark);
    expect(merged.light).toEqual(fallback.light);
    expect(merged.themeName).toBe("Retired Theme X");
  });
});

describe("workingToPreview", () => {
  const base = {
    dark: INDIGO_WASH.dark as ColorSet,
    light: INDIGO_WASH.light as ColorSet,
    bodyFont: "default",
    displayFont: "default",
    borderRadius: 10,
  };

  it("projects the light palette when mode is 'light'", () => {
    const p = workingToPreview(base, "light");
    expect(p.bgDeep).toBe(INDIGO_WASH.light["--bg-deep"]);
    expect(p.textSecondary).toBe(INDIGO_WASH.light["--text-secondary"]);
    expect(p.sidebarBg).toBe(INDIGO_WASH.light["--sidebar-bg"]);
    expect(p.headerBg).toBe(INDIGO_WASH.light["--header-bg"]);
    expect(p.accentPrimary).toBe(INDIGO_WASH.light["--accent-primary"]);
  });

  it("projects the dark palette when mode is 'dark'", () => {
    const p = workingToPreview(base, "dark");
    expect(p.bgDeep).toBe(INDIGO_WASH.dark["--bg-deep"]);
    expect(p.textSecondary).toBe(INDIGO_WASH.dark["--text-secondary"]);
    expect(p.sidebarBg).toBe(INDIGO_WASH.dark["--sidebar-bg"]);
    expect(p.headerBg).toBe(INDIGO_WASH.dark["--header-bg"]);
  });

  it("passes through non-color meta (borderRadius + fonts)", () => {
    const p = workingToPreview({ ...base, borderRadius: 4, bodyFont: "Inter", displayFont: "Geist" }, "light");
    expect(p.borderRadius).toBe(4);
    expect(p.bodyFont).toBe("Inter");
    expect(p.displayFont).toBe("Geist");
  });

  it("reads text tokens from the palette, not a mode-fixed default", () => {
    // Custom palette where text colours don't match either real theme —
    // confirms the projection copies values straight from the edited
    // palette instead of hardcoding per-mode values.
    const custom: ColorSet = { ...INDIGO_WASH.light, "--text-secondary": "#123456", "--text-muted": "#abcdef" };
    const p = workingToPreview({ ...base, light: custom }, "light");
    expect(p.textSecondary).toBe("#123456");
    expect(p.textMuted).toBe("#abcdef");
  });
});
