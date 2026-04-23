import { NamedTheme, PaletteKey, Palette, THEMES } from "@/components/theme/preset-grid";
import type { PreviewTheme } from "@/components/theme/live-preview";

export type ColorKey = PaletteKey;
export type ColorSet = Palette;
export type Mode = "dark" | "light";

export const DEFAULT_THEME_NAME = "Indigo Wash";

/**
 * Look up a theme by name and return a shallow copy of its two palettes.
 * Falls back to the first theme in the list if the name is unknown —
 * keeps the editor functional even if the saved preset is an old or
 * renamed theme that's no longer in THEMES.
 */
export function defaultsFor(
  themeName: string,
): { dark: ColorSet; light: ColorSet } {
  const theme = THEMES.find((t) => t.name === themeName) ?? THEMES[0];
  return {
    dark: { ...theme.dark },
    light: { ...theme.light },
  };
}

/**
 * Merge a saved theme payload from the API with the default palette
 * for its named theme, and report whether the saved row contains any
 * user overrides on top of the theme defaults. Written as a pure
 * function so the loadTheme effect stays simple and the merge rules
 * are testable in isolation.
 */
export function mergeSavedWithDefaults(
  savedName: string | undefined,
  saved: { dark?: Partial<ColorSet>; light?: Partial<ColorSet> } | undefined,
): {
  themeName: string;
  dark: ColorSet;
  light: ColorSet;
  isEdited: boolean;
} {
  const themeName = savedName ?? DEFAULT_THEME_NAME;
  const base = defaultsFor(themeName);
  const dark = { ...base.dark, ...(saved?.dark ?? {}) } as ColorSet;
  const light = { ...base.light, ...(saved?.light ?? {}) } as ColorSet;
  const isEdited =
    JSON.stringify(base.dark) !== JSON.stringify(dark) ||
    JSON.stringify(base.light) !== JSON.stringify(light);
  return { themeName, dark, light, isEdited };
}

/**
 * Pick one of the edited-theme's two palettes and project it onto the
 * PreviewTheme shape LivePreview wants. Kept pure and in one place so
 * the editor and any future non-editor preview share the same rules.
 */
interface WorkingThemeForPreview {
  dark: ColorSet;
  light: ColorSet;
  bodyFont: string;
  displayFont: string;
  borderRadius: number;
}

export function workingToPreview(
  t: WorkingThemeForPreview,
  mode: Mode,
): PreviewTheme {
  const c = t[mode];
  return {
    bgDeep: c["--bg-deep"],
    bgCard: c["--bg-card"],
    bgElevated: c["--bg-elevated"],
    border: c["--border"],
    sidebarBg: c["--sidebar-bg"],
    headerBg: c["--header-bg"],
    textPrimary: c["--text-primary"],
    textSecondary: c["--text-secondary"],
    textMuted: c["--text-muted"],
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

export type { NamedTheme, Palette };
export { THEMES };
