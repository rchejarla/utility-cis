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
 *
 * Data shape comes from GET /api/v1/tenant-config and is saved via
 * PATCH to the same endpoint. Only the fields the admin actually
 * toggled are sent in the PATCH body so unrelated settings
 * (numberFormats, etc.) are not clobbered.
 */

interface TenantConfigResponse {
  utilityId: string;
  requireHoldApproval: boolean;
  settings: Record<string, unknown>;
}

export function GeneralTab() {
  const { canEdit } = usePermission("settings");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [requireHoldApproval, setRequireHoldApproval] = useState(false);
  const [initial, setInitial] = useState<{ requireHoldApproval: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await apiClient.get<TenantConfigResponse>("/api/v1/tenant-config");
        setRequireHoldApproval(cfg.requireHoldApproval);
        setInitial({ requireHoldApproval: cfg.requireHoldApproval });
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed to load tenant config", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  const isDirty = initial !== null && initial.requireHoldApproval !== requireHoldApproval;

  async function save() {
    setSaving(true);
    try {
      await apiClient.patch("/api/v1/tenant-config", { requireHoldApproval });
      setInitial({ requireHoldApproval });
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
          to every hold your tenant creates.
        </p>

        <Row>
          <ToggleField
            label="Require approval before activation"
            description="When enabled, new holds start as PENDING and remain there until a user with the APPROVE permission on service_suspensions explicitly approves them. Only approved holds will be auto-activated by the scheduler. When disabled, the scheduler transitions PENDING → ACTIVE as soon as the start date arrives."
            checked={requireHoldApproval}
            onChange={setRequireHoldApproval}
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
