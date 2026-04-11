"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { NumberingTab } from "@/components/settings/numbering-tab";

export default function NumberingSettingsPage() {
  return (
    <SettingsSection
      title="Numbering"
      description="Identifier templates for accounts, agreements, and other entity numbers. Supports tokens like {YYYY}, {MM}, and {seq:6}."
    >
      <NumberingTab />
    </SettingsSection>
  );
}
