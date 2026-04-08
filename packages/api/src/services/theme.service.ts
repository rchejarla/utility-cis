import { prisma } from "../lib/prisma.js";
import type { UpdateThemeInput } from "@utility-cis/shared";

const DEFAULT_THEME = {
  preset: "midnight",
  colors: {
    dark: { "bg-deep": "#06080d", "bg-surface": "#0c1018", "bg-card": "#111722", "accent-primary": "#3b82f6", "text-primary": "#e8edf5" },
    light: { "bg-deep": "#ffffff", "bg-surface": "#f8fafc", "bg-card": "#ffffff", "accent-primary": "#0f766e", "text-primary": "#0f172a" },
  },
  typography: { body: "DM Sans", display: "Fraunces" },
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
