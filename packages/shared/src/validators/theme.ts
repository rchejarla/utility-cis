import { z } from "zod";

export const colorSetSchema = z.object({
  primary: z.string(),
  secondary: z.string().optional(),
  accent: z.string().optional(),
  background: z.string().optional(),
  surface: z.string().optional(),
  text: z.string().optional(),
});

export const colorsSchema = z.object({
  dark: colorSetSchema,
  light: colorSetSchema,
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
