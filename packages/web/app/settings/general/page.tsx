"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { GeneralTab } from "@/components/settings/general-tab";

export default function GeneralSettingsPage() {
  return (
    <SettingsSection
      title="General"
      description="Basic information about your utility — visible to staff and referenced on outgoing correspondence, bills, and the customer portal."
    >
      <GeneralTab />
    </SettingsSection>
  );
}
