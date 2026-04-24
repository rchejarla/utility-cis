"use client";

import { SettingsSection } from "@/components/settings/settings-shell";
import { CustomFieldsTab } from "@/components/settings/custom-fields-tab";
import { PageDescription } from "@/components/ui/page-description";

export default function CustomFieldsSettingsPage() {
  return (
    <SettingsSection
      title="Custom Fields"
      description="Tenant-configurable fields stored on customers, accounts, premises, service agreements, and meters. Values are validated at write time against the schema you configure here."
    >
      <PageDescription storageKey="settings-custom-fields">
        <b>Custom fields</b> are per-entity schema extensions — extra inputs
        that appear on the detail form for customers, accounts, premises, and
        similar records. Scope is <b>per tenant</b>, so each utility picks the
        fields that match its operation. Once a field has saved data, its
        <b> type</b> is locked; rename or deactivate it rather than changing
        the type to avoid corrupting stored values.
      </PageDescription>
      <CustomFieldsTab />
    </SettingsSection>
  );
}
