"use client";

import { useMemo } from "react";
import {
  DEFAULT_BILLING_INTEGRATION,
  type BillingIntegrationSettings,
} from "@utility-cis/shared";
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

type Shape = Required<
  Pick<BillingIntegrationSettings, "saaslogicBaseUrl" | "sandbox" | "pollMinutes">
>;

export default function BillingSettingsPage() {
  const { canEdit } = usePermission("settings");
  const defaults = useMemo<Shape>(
    () => ({ ...DEFAULT_BILLING_INTEGRATION }),
    [],
  );
  const { loading, saving, draft, setDraft, isDirty, save, reset } =
    useTenantSettingsNamespace<"billing", Shape>("billing", defaults);

  if (loading) {
    return (
      <SettingsSection
        title="Billing Integration"
        description="SaaSLogic connection for external billing."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Billing Integration"
      description="Connect the CIS to SaaSLogic, the external billing platform that prices usage, generates invoices, and collects payments. CIS pushes line items; SaaSLogic owns rating and delivery."
    >
      <SettingsCard>
        <SettingRow
          label="SaaSLogic base URL"
          description="Production or sandbox API endpoint. Sandbox: https://api-sandbox.saaslogic.io/v1 — Production: https://api.saaslogic.io/v1"
          control={
            <input
              type="url"
              style={{ ...settingInputStyle, width: "340px" }}
              value={draft.saaslogicBaseUrl}
              disabled={!canEdit}
              onChange={(e) =>
                setDraft({ ...draft, saaslogicBaseUrl: e.target.value })
              }
            />
          }
        />
        <SettingRow
          label="Sandbox mode"
          description="When enabled, CIS treats the target environment as a test instance. Cycle close jobs run in dry-run mode and no real invoices are finalized."
          control={
            <label style={{ display: "inline-flex", alignItems: "center", gap: 10, cursor: canEdit ? "pointer" : "not-allowed" }}>
              <input
                type="checkbox"
                checked={draft.sandbox}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, sandbox: e.target.checked })}
                style={{ width: 18, height: 18, accentColor: "var(--accent-primary)" }}
              />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {draft.sandbox ? "Sandbox" : "Production"}
              </span>
            </label>
          }
        />
        <SettingRow
          label="Invoice polling interval"
          description="How often the reconciler job pulls updated invoices from SaaSLogic into the local mirror. Minimum 1 minute, maximum 24 hours."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={1}
                max={1440}
                step={1}
                value={draft.pollMinutes}
                disabled={!canEdit}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) setDraft({ ...draft, pollMinutes: Math.round(n) });
                }}
                style={{ ...settingInputStyle, width: "120px", textAlign: "right" as const }}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>minutes</span>
            </div>
          }
        />
        <SettingRow
          label="API key"
          description="Bearer token used for outbound calls. Stored encrypted at rest and rotated via the key-management UI — which is not yet implemented."
          control={<button style={settingMutedBtnStyle} disabled>Rotate key</button>}
        />
        <SettingRow
          label="Default resource map"
          description="Maps CIS commodities to reusable SaaSLogic resources (one row per commodity). Defined per the Phase 3 spec in docs/specs/21-saaslogic-billing.md."
          control={<button style={settingMutedBtnStyle} disabled>Manage map</button>}
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
          The SaaSLogic client package, line item push, and invoice polling are Phase 3 work and are not running yet. Values saved here will be read by those services once they ship.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
