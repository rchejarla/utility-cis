"use client";

import { useMemo } from "react";
import type { NotificationSettings } from "@utility-cis/shared";
import {
  SettingsSection,
  SettingsCard,
  SettingRow,
  SettingsSaveBar,
  SettingPlaceholder,
  settingInputStyle,
  settingMutedBtnStyle,
} from "@/components/settings/settings-shell";
import { useTenantSettingsNamespace } from "@/lib/use-tenant-settings-namespace";
import { usePermission } from "@/lib/use-permission";

type Shape = Required<Pick<NotificationSettings, "senderEmail" | "dailyDigestEnabled">>;

const DEFAULTS: Shape = { senderEmail: "", dailyDigestEnabled: false };

export default function NotificationsSettingsPage() {
  const { canEdit } = usePermission("tenant_profile");
  const defaults = useMemo(() => DEFAULTS, []);
  const { loading, saving, draft, setDraft, isDirty, save, reset } =
    useTenantSettingsNamespace<"notifications", Shape>("notifications", defaults);

  if (loading) {
    return (
      <SettingsSection
        title="Notifications"
        description="Email and SMS communications, provider credentials, and daily operations digest."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Notifications"
      description="Email and SMS templates, from-addresses, and provider credentials used for customer-facing communications and internal alerts."
    >
      <SettingsCard>
        <SettingRow
          label="Sender email address"
          description="From-address on outgoing customer email (invoices ready, payment reminders, shut-off notices). Must be verified in DNS before production use."
          control={
            <input
              type="email"
              placeholder="billing@example-utility.gov"
              style={settingInputStyle}
              value={draft.senderEmail}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, senderEmail: e.target.value })}
            />
          }
        />
        <SettingRow
          label="Daily operations digest"
          description="A 7am summary email to ops staff listing overdue accounts, failed meter reads, and exception queue counts."
          control={
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: canEdit ? "pointer" : "not-allowed" }}>
              <input
                type="checkbox"
                checked={draft.dailyDigestEnabled}
                disabled={!canEdit}
                onChange={(e) =>
                  setDraft({ ...draft, dailyDigestEnabled: e.target.checked })
                }
                style={{ width: 18, height: 18, accentColor: "var(--accent-primary)" }}
              />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {draft.dailyDigestEnabled ? "Enabled" : "Disabled"}
              </span>
            </label>
          }
        />
        <SettingRow
          label="SMS provider"
          description="Twilio, Telnyx, or a generic HTTP webhook. Credentials stored encrypted at rest."
          control={<button style={settingMutedBtnStyle} disabled>Configure</button>}
        />
        <SettingRow
          label="Notification templates"
          description="Per-event templates: shut-off notice, payment reminder, meter event alert, bill ready, and others."
          control={<button style={settingMutedBtnStyle} disabled>Edit templates</button>}
        />
      </SettingsCard>

      <SettingsSaveBar
        saving={saving}
        isDirty={isDirty}
        canEdit={canEdit}
        onSave={save}
        onReset={reset}
      />

      <div style={{ marginTop: 20 }}>
        <SettingPlaceholder>
          The sender address and digest toggle are persisted now. SMS provider setup and per-event templates are part of the Phase 3 notification engine and are not yet implemented.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
