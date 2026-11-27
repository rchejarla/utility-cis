"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * Tenant-level general settings tab.
 *
 * Home for tenant-wide on/off flags that don't belong to a more
 * specific tab (e.g. Numbering). Currently exposes:
 *
 *   - requireHoldApproval: when true, new service suspensions start
 *     as PENDING and remain there until a user with the APPROVE
 *     permission explicitly approves them. The scheduler's
 *     PENDING → ACTIVE transition also respects this gate.
 *   - transferCarriesRateSchedule: when true (the default), a transfer
 *     of service copies the source agreement's in-force rate-schedule
 *     assignments onto the new agreement.
 *
 * Data shape comes from GET /api/v1/tenant-config and is saved via
 * PATCH to the same endpoint. Only the fields the admin actually
 * toggled are sent in the PATCH body so unrelated settings
 * (numberFormats, etc.) are not clobbered.
 */

interface TenantConfigResponse {
  utilityId: string;
  requireHoldApproval: boolean;
  transferCarriesRateSchedule: boolean;
  settings: Record<string, unknown>;
}

/**
 * The flags this tab owns, as one object.
 *
 * Two pieces of `useState` plus a two-field `initial` was already the
 * shape this was growing into, and the dirty check has to compare every
 * flag or the Save button goes dead for the one it forgot.
 */
interface Flags {
  requireHoldApproval: boolean;
  transferCarriesRateSchedule: boolean;
}

const FALLBACK: Flags = {
  requireHoldApproval: false,
  // Matches the API's default for a tenant with no config row. A screen
  // that rendered this off while the workflow treated it as on would be
  // worse than no screen.
  transferCarriesRateSchedule: true,
};

export function GeneralTab() {
  const { canEdit } = usePermission("tenant_profile");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flags, setFlags] = useState<Flags>(FALLBACK);
  const [initial, setInitial] = useState<Flags | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await apiClient.get<TenantConfigResponse>("/api/v1/tenant-config");
        const loaded: Flags = {
          requireHoldApproval: cfg.requireHoldApproval,
          transferCarriesRateSchedule: cfg.transferCarriesRateSchedule,
        };
        setFlags(loaded);
        setInitial(loaded);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed to load settings", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  const set = <K extends keyof Flags>(key: K) => (next: Flags[K]) =>
    setFlags((prev) => ({ ...prev, [key]: next }));

  const isDirty =
    initial !== null &&
    (Object.keys(flags) as (keyof Flags)[]).some((k) => initial[k] !== flags[k]);

  async function save() {
    setSaving(true);
    try {
      await apiClient.patch("/api/v1/tenant-config", flags);
      setInitial(flags);
      toast("General settings saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p style={{ color: "var(--text-muted)", padding: 24 }}>Loading…</p>;
  }

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 24 }}>
      <section>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginTop: 0,
            marginBottom: 8,
          }}
        >
          Service Holds
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, marginBottom: 16 }}>
          Lifecycle behavior for service holds (also called suspensions). These apply
          to every hold you create.
        </p>

        <Row>
          <ToggleField
            label="Require approval before activation"
            description="When enabled, new holds start as PENDING and remain there until a user with the APPROVE permission on service_suspensions explicitly approves them. Only approved holds will be auto-activated by the scheduler. When disabled, the scheduler transitions PENDING → ACTIVE as soon as the start date arrives."
            checked={flags.requireHoldApproval}
            onChange={set("requireHoldApproval")}
            disabled={!canEdit}
          />
        </Row>
      </section>

      <section>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginTop: 0,
            marginBottom: 8,
          }}
        >
          Transfer of Service
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, marginBottom: 16 }}>
          What a transfer carries onto the new agreement when a service moves from one
          account to another.
        </p>

        <Row>
          <ToggleField
            label="Carry the rate schedule"
            description="When enabled, a transfer copies the source agreement's in-force rate-schedule assignments onto the new agreement, effective from the transfer date — the same service at the same premise keeps the same tariff. When disabled, the new agreement starts unrated and a billing run will hold it by name until someone assigns a schedule. Turn this off if a change of responsibility is also a re-rate."
            checked={flags.transferCarriesRateSchedule}
            onChange={set("transferCarriesRateSchedule")}
            disabled={!canEdit}
          />
        </Row>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={saving || !canEdit || !isDirty}
          style={{
            padding: "10px 20px",
            background: canEdit && isDirty ? "var(--accent-primary)" : "var(--bg-elevated)",
            color: canEdit && isDirty ? "white" : "var(--text-muted)",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: canEdit && isDirty ? "pointer" : "not-allowed",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        background: "var(--bg-surface)",
      }}
    >
      {children}
    </div>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 12,
        alignItems: "flex-start",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        style={{
          width: 18,
          height: 18,
          marginTop: 2,
          cursor: disabled ? "not-allowed" : "pointer",
          accentColor: "var(--accent-primary)",
        }}
      />
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
          {description}
        </div>
      </div>
    </label>
  );
}
