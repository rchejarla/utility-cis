"use client";

import { useEffect, useMemo, useState } from "react";
import { getTimeZones } from "@vvo/tzdb";
import {
  type AutomationConfig,
  type AutomationConfigPatch,
  type SchedulerKey,
  type SchedulerSetting,
  SCHEDULER_DEFINITIONS,
  schedulerDefinition,
} from "@utility-cis/shared";
import {
  SettingsSection,
  SettingsCard,
  SettingRow,
  SettingsSaveBar,
  settingInputStyle,
} from "@/components/settings/settings-shell";
import { useToast } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";

/**
 * /settings/automation — controls when and whether background
 * automation runs for this utility.
 *
 * Surface:
 *   - Timezone — IANA zone, used by all tenant-local scheduling
 *   - Per-scheduler toggles (suspension, notification-send,
 *     SLA-breach sweep, delinquency)
 *   - Quiet hours (SMS only)
 *   - Daily run hour (delinquency)
 *   - Audit retention days (scheduler-emitted audits)
 *
 * Talks to /api/v1/settings/automation. Optimistic save uses the
 * shared SettingsSaveBar with reset-on-discard.
 */

const NUMBER_INPUT: React.CSSProperties = {
  ...settingInputStyle,
  width: 140,
  textAlign: "right",
};

const SELECT_INPUT: React.CSSProperties = {
  ...settingInputStyle,
  width: 320,
  paddingRight: 32,
};

const TIME_INPUT: React.CSSProperties = {
  ...settingInputStyle,
  width: 140,
};

const RETENTION_PRESETS = [90, 180, 365, 730];

export default function AutomationSettingsPage() {
  const { canView, canEdit } = usePermission("tenant_profile");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [original, setOriginal] = useState<AutomationConfig | null>(null);
  const [draft, setDraft] = useState<AutomationConfig | null>(null);

  const timezones = useMemo(() => getTimeZones().map((z) => z.name).sort(), []);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await apiClient.get<AutomationConfig>("/api/v1/settings/automation");
        if (cancelled) return;
        setOriginal(cfg);
        setDraft(cfg);
      } catch (err) {
        if (!cancelled) {
          toast(
            err instanceof Error ? err.message : "Failed to load automation config",
            "error",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canView, toast]);

  if (!canView) {
    return (
      <SettingsSection
        title="Automation"
        description="You do not have permission to view automation settings."
      >
        <p style={{ color: "var(--text-muted)" }}>Access denied.</p>
      </SettingsSection>
    );
  }

  if (loading || !draft || !original) {
    return (
      <SettingsSection
        title="Automation"
        description="Control when and whether background automation runs for your utility."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  const isDirty = JSON.stringify(draft) !== JSON.stringify(original);

  function patchOf(): AutomationConfigPatch {
    if (!original || !draft) return {};
    const out: AutomationConfigPatch = {};

    /*
     * Tenant-wide fields: anything that changed, except `schedulers`,
     * which is a list and diffs per entry below. `lastRunAt` needs no
     * exclusion any more — the patch schema has no field for it, so a
     * dispatcher's timestamp is unreachable from here by construction
     * rather than by a name this function has to remember.
     */
    (Object.keys(draft) as (keyof AutomationConfig)[]).forEach((k) => {
      if (k === "schedulers") return;
      if (draft[k] !== original[k]) {
        (out as Record<string, unknown>)[k] = draft[k];
      }
    });

    // Only the jobs whose settings moved. Sending every job would
    // materialise a row for each one on the first save of any.
    const changed = draft.schedulers.filter((next) => {
      const before = original.schedulers.find((s) => s.key === next.key);
      return (
        !before ||
        before.enabled !== next.enabled ||
        before.runHourLocal !== next.runHourLocal ||
        JSON.stringify(before.settings) !== JSON.stringify(next.settings)
      );
    });
    if (changed.length > 0) {
      out.schedulers = changed.map((c) => ({
        key: c.key,
        enabled: c.enabled,
        runHourLocal: c.runHourLocal,
        settings: c.settings,
      }));
    }
    return out;
  }

  /** One job's setting, by key, leaving the others alone. */
  function setScheduler(key: SchedulerKey, change: Partial<SchedulerSetting>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            schedulers: d.schedulers.map((s) => (s.key === key ? { ...s, ...change } : s)),
          }
        : d,
    );
  }

  /** The entry for a catalogue key, or the catalogue default. */
  function schedulerOf(key: SchedulerKey): SchedulerSetting {
    const def = schedulerDefinition(key);
    return (
      draft?.schedulers.find((s) => s.key === key) ?? {
        key,
        enabled: def.defaultEnabled,
        runHourLocal: def.hasRunHour ? 3 : null,
        lastRunAt: null,
        settings: {},
      }
    );
  }

  async function save() {
    if (!draft) return;
    const patch = patchOf();
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try {
      const next = await apiClient.patch<AutomationConfig>(
        "/api/v1/settings/automation",
        patch,
      );
      setOriginal(next);
      setDraft(next);
      toast("Automation settings saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (original) setDraft(original);
  }

  function setField<K extends keyof AutomationConfig>(key: K, value: AutomationConfig[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  return (
    <>
      <SettingsSection
        title="Automation"
        description="Control when and whether background automation runs for your utility. Disabling a scheduler stops new work; in-flight jobs continue until they finish."
      >
        <SettingsCard>
          <SettingRow
            label="Timezone"
            description="Used by every time-of-day rule on this page (quiet hours, daily run hour). DST transitions are handled automatically."
            control={
              <select
                value={draft.timezone}
                disabled={!canEdit}
                onChange={(e) => setField("timezone", e.target.value)}
                style={SELECT_INPUT}
              >
                {timezones.includes(draft.timezone) ? null : (
                  <option value={draft.timezone}>{draft.timezone}</option>
                )}
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Schedulers"
        description="Toggle individual background jobs. Cadence is fixed at the platform level — these toggles control whether the job does any work for your utility."
      >
        <SettingsCard>
          {/*
            * Rendered from the shared catalogue, not from a list in this
            * file. A scheduler added in `SCHEDULER_DEFINITIONS` gets its
            * switch — and its hour, below — without this page being
            * touched, which is the point of the change: onboarding a
            * utility is configuration, and adding a job is a catalogue
            * entry plus a handler.
            */}
          {SCHEDULER_DEFINITIONS.map((def) => {
            const row = schedulerOf(def.key);
            return (
              <SettingRow
                key={def.key}
                label={def.label}
                description={
                  // Concatenated rather than marked up: `SettingRow` takes
                  // a string, and widening a prop every settings page uses
                  // to colour one sentence is the wrong trade. The words
                  // carry it.
                  "offNote" in def && def.offNote && !row.enabled
                    ? `${def.description} ${def.offNote}`
                    : def.description
                }
                control={
                  <ToggleSwitch
                    checked={row.enabled}
                    disabled={!canEdit}
                    onChange={(v) => setScheduler(def.key, { enabled: v })}
                  />
                }
              />
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Billing"
        description="How generating a bill behaves. Unlike the schedulers above, this is not a background job — it happens inside the same transaction that creates the bill."
      >
        <SettingsCard>
          <SettingRow
            label="Post bills to the ledger automatically"
            description="On: generating a bill immediately makes it owed, and it appears on the customer's balance. Off: a bill is calculated but owes nothing until someone posts it, so staff must post it from the account's Bills tab. Individual accounts can override this."
            control={
              <ToggleSwitch
                checked={draft.autoPostBills}
                disabled={!canEdit}
                onChange={(v) => setField("autoPostBills", v)}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Quiet hours"
        description="SMS messages are held when the tenant-local time falls within this window. Email is always eligible. Set start equal to end to disable quiet hours."
      >
        <SettingsCard>
          <SettingRow
            label="Quiet hours start"
            description="Local time after which SMS dispatch pauses."
            control={
              <input
                type="time"
                value={draft.notificationQuietStart}
                disabled={!canEdit}
                onChange={(e) => setField("notificationQuietStart", e.target.value)}
                style={TIME_INPUT}
              />
            }
          />
          <SettingRow
            label="Quiet hours end"
            description="Local time at which SMS dispatch resumes."
            control={
              <input
                type="time"
                value={draft.notificationQuietEnd}
                disabled={!canEdit}
                onChange={(e) => setField("notificationQuietEnd", e.target.value)}
                style={TIME_INPUT}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Daily runs"
        description="Time-of-day for the jobs that have one, in your tenant's local time. The dispatcher wakes hourly and acts when your local hour matches, so a zone with a half-hour offset runs inside the chosen hour rather than at the top of it."
      >
        <SettingsCard>
          {/*
            * One block per job that declares `hasRunHour`, from the same
            * catalogue as the switches above. Jobs without an hour get no
            * control rather than a disabled one: suspension and the SLA
            * sweep run on a fixed cadence, and an hour box for them would
            * be a value nothing reads.
            */}
          {SCHEDULER_DEFINITIONS.filter((def) => def.hasRunHour).map((def) => {
            const row = schedulerOf(def.key);
            return (
              <SettingRow
                key={def.key}
                label={`${def.label.split(" · ")[0]} run hour`}
                description="0–23, local time. The dispatcher acts when the tenant-local hour matches or has passed, so an hour the clocks skip in spring cannot strand the job."
                control={
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      step={1}
                      aria-label={`${def.key} run hour`}
                      value={row.runHourLocal ?? 0}
                      disabled={!canEdit || !row.enabled}
                      onChange={(e) =>
                        setScheduler(def.key, {
                          runHourLocal: Math.max(0, Math.min(23, Number(e.target.value) || 0)),
                        })
                      }
                      style={NUMBER_INPUT}
                    />
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {String(row.runHourLocal ?? 0).padStart(2, "0")}:00 local
                      {!row.enabled && " · this job is off"}
                    </span>
                  </div>
                }
              />
            );
          })}
          {/*
            * The dispatcher writes these; the page shows them and never
            * patches them. The patch schema has no field for `lastRunAt`
            * at all, so that is structural rather than a rule this page
            * has to keep. It is the only way to tell a tick that was
            * missed from one not yet due.
            */}
          {SCHEDULER_DEFINITIONS.filter((def) => def.hasRunHour).map((def) => {
            const row = schedulerOf(def.key);
            return (
              <SettingRow
                key={`${def.key}-last`}
                label={`Last run — ${def.label.split(" · ")[0]}`}
                description="When the dispatcher last acted for your utility. Written by the scheduler, not editable here."
                control={
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : "never"}
                  </span>
                }
              />
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Audit retention"
        description="Scheduler-emitted audit entries (suspension transitions, SLA breaches, etc.) are deleted after this many days. User-action audits are governed by the separate audit-log retention policy and are not affected by this value."
      >
        <SettingsCard>
          <SettingRow
            label="Scheduler audit retention"
            description="Minimum 30 days, maximum 7 years."
            control={
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input
                  type="number"
                  min={30}
                  max={2555}
                  step={1}
                  value={draft.schedulerAuditRetentionDays}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setField(
                      "schedulerAuditRetentionDays",
                      Math.max(30, Math.min(2555, Number(e.target.value) || 30)),
                    )
                  }
                  style={NUMBER_INPUT}
                />
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>days</span>
              </div>
            }
          />
          <SettingRow
            label=" "
            description=" "
            control={
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {RETENTION_PRESETS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => setField("schedulerAuditRetentionDays", d)}
                    style={{
                      padding: "4px 10px",
                      fontSize: 11,
                      fontWeight: 500,
                      background:
                        draft.schedulerAuditRetentionDays === d
                          ? "var(--accent-primary)"
                          : "transparent",
                      color:
                        draft.schedulerAuditRetentionDays === d ? "#fff" : "var(--text-secondary)",
                      border: "1px solid var(--border)",
                      borderRadius: 999,
                      cursor: canEdit ? "pointer" : "not-allowed",
                      fontFamily: "inherit",
                    }}
                  >
                    {d} d
                  </button>
                ))}
              </div>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSaveBar
        saving={saving}
        isDirty={isDirty}
        canEdit={canEdit}
        onSave={save}
        onReset={reset}
      />
    </>
  );
}

interface ToggleSwitchProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

function ToggleSwitch({ checked, disabled, onChange }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 44,
        height: 24,
        background: checked ? "var(--accent-primary)" : "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.12s ease",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 22 : 2,
          width: 18,
          height: 18,
          background: "#fff",
          borderRadius: "50%",
          transition: "left 0.12s ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}
