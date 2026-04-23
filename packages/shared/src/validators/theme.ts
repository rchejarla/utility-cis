import { z } from "zod";

// A color set is an arbitrary map of CSS custom-property names (e.g.
// `--bg-deep`, `--accent-primary`) to CSS color values. Keys must start
// with `--` so applyCSSVariables can set them directly on the root
// element without prefixing. Values are strings because CSS accepts a
// wide range of color formats (hex, rgb(), oklch(), gradients).
//
// Previously this schema whitelisted a handful of abstract keys
// (`primary`, `surface`, etc.) that nothing in the codebase actually
// used — the theme editor sends raw CSS-var names. Zod silently stripped
// every incoming key, so "Save Theme" round-tripped to an empty object.
export const colorSetSchema = z.record(
  z.string().regex(/^--[a-z][a-z0-9-]*$/, "Color keys must be CSS custom properties, e.g. --bg-deep"),
  z.string().min(1),
);

export const colorsSchema = z.object({
  dark: colorSetSchema.optional(),
  light: colorSetSchema.optional(),
});

export const typographySchema = z.object({
  body: z.string().optional(),
  display: z.string().optional(),
});

export const updateThemeSchema = z.object({
  preset: z.string().optional(),
  colors: colorsSchema.optional(),
  typography: typographySchema.optional(),
  borderRadius: z.number().int().min(0).max(20).optional(),
  logoUrl: z.string().url().optional(),
});

export const themeModeEnum = z.enum(["DARK", "LIGHT", "SYSTEM"]);

export const updateUserPreferenceSchema = z.object({
  themeMode: themeModeEnum.optional(),
  preferences: z.record(z.unknown()).optional(),
});

export type ColorSet = z.infer<typeof colorSetSchema>;
export type Colors = z.infer<typeof colorsSchema>;
export type Typography = z.infer<typeof typographySchema>;
export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;
export type ThemeMode = z.infer<typeof themeModeEnum>;
export type UpdateUserPreferenceInput = z.infer<typeof updateUserPreferenceSchema>;
