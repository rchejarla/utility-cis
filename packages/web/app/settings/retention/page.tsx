"use client";

import { useMemo } from "react";
import { DEFAULT_RETENTION, type RetentionSettings } from "@utility-cis/shared";
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
  Pick<
    RetentionSettings,
    "auditRetentionDays" | "softDeletePurgeDays" | "intervalReadRetentionDays" | "attachmentRetentionYears"
  >
>;

const numberInputStyle = { ...settingInputStyle, width: "160px", textAlign: "right" as const };

function daysToYears(days: number): string {
  const years = days / 365.25;
  if (years >= 1) return `≈ ${years.toFixed(1)} yr`;
  return `${days} d`;
}

export default function RetentionSettingsPage() {
  const { canEdit } = usePermission("settings");
  const defaults = useMemo<Shape>(() => ({ ...DEFAULT_RETENTION }), []);
  const { loading, saving, draft, setDraft, isDirty, save, reset } =
    useTenantSettingsNamespace<"retention", Shape>("retention", defaults);

  if (loading) {
    return (
      <SettingsSection
        title="Retention & Audit"
        description="How long CIS keeps historical data and audit events."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  const handleNumber =
    (key: keyof Shape) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      setDraft({ ...draft, [key]: Math.round(n) });
    };

  return (
    <SettingsSection
      title="Retention & Audit"
      description="How long CIS keeps historical data and audit events. Applies to audit logs, soft-deleted rows, meter interval reads, and attachment blob storage. All retention jobs run nightly."
    >
      <SettingsCard>
        <SettingRow
          label="Audit log retention"
          description="Minimum 365 days, maximum 10 years. Some compliance regimes (HIPAA, PCI) require longer retention."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={365}
                max={3650}
                step={1}
                value={draft.auditRetentionDays}
                disabled={!canEdit}
                onChange={handleNumber("auditRetentionDays")}
                style={numberInputStyle}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                days ({daysToYears(draft.auditRetentionDays)})
              </span>
            </div>
          }
        />
        <SettingRow
          label="Soft-delete purge window"
          description="After this many days, soft-deleted rows are hard-deleted by the nightly purge job. Shorter values free storage faster; longer values give more time to recover accidental deletes."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={7}
                max={3650}
                step={1}
                value={draft.softDeletePurgeDays}
                disabled={!canEdit}
                onChange={handleNumber("softDeletePurgeDays")}
                style={numberInputStyle}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>days</span>
            </div>
          }
        />
        <SettingRow
          label="Meter interval read retention"
          description="TimescaleDB hypertable retention. Older chunks are dropped automatically once Phase 3 interval reads are live."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={30}
                max={3650}
                step={1}
                value={draft.intervalReadRetentionDays}
                disabled={!canEdit}
                onChange={handleNumber("intervalReadRetentionDays")}
                style={numberInputStyle}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                days ({daysToYears(draft.intervalReadRetentionDays)})
              </span>
            </div>
          }
        />
        <SettingRow
          label="Attachment storage retention"
          description="How long uploaded files (PDFs, photos, imports) are kept after their owning entity is closed. Expressed in years because that is how operators think about it."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="number"
                min={1}
                max={30}
                step={1}
                value={draft.attachmentRetentionYears}
                disabled={!canEdit}
                onChange={handleNumber("attachmentRetentionYears")}
                style={numberInputStyle}
              />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>years</span>
            </div>
          }
        />
        <SettingRow
          label="Export audit log archive"
          description="Download a signed ND-JSON archive of every audit event (user, module, action, payload diff). The export job is not yet wired."
          control={<button style={settingMutedBtnStyle} disabled>Export archive</button>}
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
          Retention values are persisted now. The nightly purge jobs that read these values are not yet implemented, so changes do not immediately affect stored data — they will take effect once the jobs ship.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
