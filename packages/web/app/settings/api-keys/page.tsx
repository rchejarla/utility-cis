"use client";

import {
  SettingsSection,
  SettingsCard,
  SettingRow,
  SettingPlaceholder,
} from "@/components/settings/settings-shell";

const btn = {
  padding: "6px 12px",
  fontSize: "12px",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  color: "var(--text-secondary)",
  cursor: "not-allowed",
};

export default function ApiKeysSettingsPage() {
  return (
    <SettingsSection
      title="API Keys & Webhooks"
      description="Credentials for external integrations that push data into CIS (AMI vendors, RAMS — Route and Asset Management System, meter imports) and for pull-based consumers that read CIS data."
    >
      <SettingsCard>
        <SettingRow
          label="Outbound API keys"
          description="Long-lived bearer tokens issued to external systems that read or write via the CIS API. Scoped by permission module."
          control={<button style={btn} disabled>Manage keys</button>}
        />
        <SettingRow
          label="Inbound webhook secrets"
          description="HMAC secrets used to verify signed webhooks from SaaSLogic, RAMS, and other partners."
          control={<button style={btn} disabled>Manage secrets</button>}
        />
        <SettingRow
          label="SaaSLogic call log"
          description="Audit trail of every outbound call to SaaSLogic, with idempotency keys and response bodies. 90-day retention."
          control={<button style={btn} disabled>Open call log</button>}
        />
        <SettingRow
          label="RAMS integration (Route & Asset Management)"
          description="Event receiver for solid-waste collection trucks. Maps RAMS event IDs onto CIS service events idempotently."
          control={<button style={btn} disabled>Configure</button>}
        />
      </SettingsCard>

      <div style={{ marginTop: 24 }}>
        <SettingPlaceholder>
          Key management is not persistable in the shared settings bucket because it requires encrypted-at-rest storage, rotation audit, and per-key scope — enough surface area to warrant its own entity. Not shipping as part of this pass. The RAMS receiver is live — see <code>POST /api/v1/service-events/rams</code>.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
