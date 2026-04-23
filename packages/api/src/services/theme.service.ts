import { prisma } from "../lib/prisma.js";
import type { UpdateThemeInput } from "@utility-cis/shared";

// Default tenant theme, served when no tenantTheme row exists yet and
// seeded on `POST /api/v1/theme/reset`. The color keys are CSS custom
// properties (leading `--`) matching globals.css so the frontend's
// applyCSSVariables actually sets anything. Previously keys lived here
// without the prefix (e.g. "bg-deep"), which made applyCSSVariables a
// no-op — the reset endpoint appeared to work but wrote dead data and
// the app kept showing whatever was in globals.css. The full 17-token
// palette per mode keeps the shape the editor expects.
//
// Values mirror the "Indigo Wash" theme defined in
// packages/web/components/theme/preset-grid.tsx. Keep the two in sync
// when changing the shipping default.
const DEFAULT_THEME = {
  preset: "Indigo Wash",
  colors: {
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
      "--text-primary": "#e8edf5",
      "--text-secondary": "#8494ad",
      "--text-muted": "#4a5a73",
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
      "--text-primary": "#0f172a",
      "--text-secondary": "#3730a3",
      "--text-muted": "#6366f1",
    },
  },
  typography: { body: "DM Sans", display: "DM Sans" },
  borderRadius: 10,
};

export async function getTheme(utilityId: string) {
  const theme = await prisma.tenantTheme.findUnique({ where: { utilityId } });
  return theme ?? DEFAULT_THEME;
}

export async function updateTheme(utilityId: string, data: UpdateThemeInput) {
  return prisma.tenantTheme.upsert({
    where: { utilityId },
    create: {
      utilityId,
      preset: data.preset ?? DEFAULT_THEME.preset,
      colors: (data.colors ?? DEFAULT_THEME.colors) as object,
      typography: (data.typography ?? DEFAULT_THEME.typography) as object,
      borderRadius: data.borderRadius ?? DEFAULT_THEME.borderRadius,
      logoUrl: data.logoUrl,
    },
    update: {
      ...(data.preset !== undefined && { preset: data.preset }),
      ...(data.colors !== undefined && { colors: data.colors as object }),
      ...(data.typography !== undefined && { typography: data.typography as object }),
      ...(data.borderRadius !== undefined && { borderRadius: data.borderRadius }),
      ...(data.logoUrl !== undefined && { logoUrl: data.logoUrl }),
    },
  });
}

export async function resetTheme(utilityId: string) {
  return prisma.tenantTheme.upsert({
    where: { utilityId },
    create: {
      utilityId,
      preset: DEFAULT_THEME.preset,
      colors: DEFAULT_THEME.colors as object,
      typography: DEFAULT_THEME.typography as object,
      borderRadius: DEFAULT_THEME.borderRadius,
    },
    update: {
      preset: DEFAULT_THEME.preset,
      colors: DEFAULT_THEME.colors as object,
      typography: DEFAULT_THEME.typography as object,
      borderRadius: DEFAULT_THEME.borderRadius,
      logoUrl: null,
    },
  });
}
