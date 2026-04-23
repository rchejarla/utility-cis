"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { ThemeTab } from "@/components/settings/theme-tab";

export default function ThemeSettingsPage() {
  return (
    <SettingsSection
      title="Theme"
      description="Pick a theme pair (dark + light palettes), customize colors for either mode, then Save & Apply to activate it across the app. Use the sun/moon toggle in the top bar to switch between dark and light mode."
    >
      <ThemeTab />
    </SettingsSection>
  );
}
