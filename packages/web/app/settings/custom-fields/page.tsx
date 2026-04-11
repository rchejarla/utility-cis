"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { CustomFieldsTab } from "@/components/settings/custom-fields-tab";

export default function CustomFieldsSettingsPage() {
  return (
    <SettingsSection
      title="Custom Fields"
      description="Tenant-configurable fields stored on customers, accounts, premises, service agreements, and meters. Values are validated at write time against the schema you configure here."
    >
      <CustomFieldsTab />
    </SettingsSection>
  );
}
