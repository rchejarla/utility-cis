"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { NumberingTab } from "@/components/settings/numbering-tab";

export default function NumberingSettingsPage() {
  return (
    <SettingsSection
      title="Numbering"
      description="How new agreement and account numbers are generated when a CSR leaves the number blank. Templates use tokens such as {YYYY}, {MM} and {seq:6}; each preview updates as you type."
    >
      <NumberingTab />
    </SettingsSection>
  );
}
