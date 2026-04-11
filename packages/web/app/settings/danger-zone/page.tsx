"use client";

import {
  SettingsSection,
  SettingsCard,
  SettingRow,
  SettingPlaceholder,
} from "@/components/settings/settings-shell";

const dangerBtn = {
  padding: "6px 14px",
  fontSize: "12px",
  fontWeight: 600,
  background: "transparent",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius)",
  color: "var(--danger)",
  cursor: "not-allowed",
  opacity: 0.7,
};

export default function DangerZoneSettingsPage() {
  return (
    <SettingsSection
      title="Danger Zone"
      description="Irreversible actions that affect the entire tenant. Read twice, click once. Gated on super-admin permissions."
      danger
    >
      <SettingsCard danger>
        <SettingRow
          label="Purge deactivated users"
          description="Permanently delete user accounts that have been inactive for more than 2 years. Their audit log entries are preserved and re-attributed to SYSTEM."
          control={<button style={dangerBtn} disabled>Purge…</button>}
        />
        <SettingRow
          label="Wipe test data"
          description="Delete every seed-generated customer, premise, meter, and related row. Only available in non-production tenants."
          control={<button style={dangerBtn} disabled>Wipe test data…</button>}
        />
        <SettingRow
          label="Transfer tenant ownership"
          description="Hand ownership of this utility tenant to another super-admin. You will be demoted to Read-Only."
          control={<button style={dangerBtn} disabled>Transfer…</button>}
        />
        <SettingRow
          label="Delete tenant"
          description="Permanently erase this utility and every row inside it — customers, meters, reads, invoices, attachments. Cannot be undone. Blocked if any audit records are under legal hold."
          control={<button style={dangerBtn} disabled>Delete tenant…</button>}
        />
      </SettingsCard>

      <div style={{ marginTop: 20 }}>
        <SettingPlaceholder>
          None of these actions are wired. Each requires super-admin permission gating, a two-step confirmation flow, and an audit entry under the SYSTEM actor. Deliberately deferred — an unfinished danger zone is more dangerous than a missing one.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
