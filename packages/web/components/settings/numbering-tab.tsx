"use client";

import { useEffect, useState } from "react";
import { previewTemplate } from "@utility-cis/shared";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { usePermission } from "@/lib/use-permission";

/**
 * Tenant numbering-format admin tab.
 *
 * Lets a utility admin configure the identifier template for
 * auto-generated agreement and account numbers. The template grammar
 * is documented in packages/shared/src/lib/number-template.ts; the
 * rendered preview on this page uses the same parser, so what you
 * see is exactly what the generator will produce.
 *
 * Storage lives inside tenant_config.settings.numberFormats; the
 * backend PATCH handler merges it into the existing settings bucket
 * without clobbering unrelated keys.
 */

interface NumberFormatConfig {
  template: string;
  startAt: number;
}

interface NumberFormats {
  agreement?: NumberFormatConfig;
  account?: NumberFormatConfig;
}

interface TenantConfigResponse {
  utilityId: string;
  requireHoldApproval: boolean;
  settings: Record<string, unknown>;
}

const DEFAULTS: Record<"agreement" | "account", NumberFormatConfig> = {
  agreement: { template: "SA-{seq:4}", startAt: 1 },
  account: { template: "AC-{seq:5}", startAt: 1 },
};

const TOKEN_HELP: Array<{ token: string; meaning: string; example: string }> = [
  { token: "{YYYY}", meaning: "4-digit year", example: "2026" },
  { token: "{YY}", meaning: "2-digit year", example: "26" },
  { token: "{MM}", meaning: "2-digit month", example: "04" },
  { token: "{seq:N}", meaning: "Sequence, zero-padded to N digits", example: "{seq:4} → 0042" },
  { token: "{seq}", meaning: "Sequence, no padding", example: "42" },
];

export function NumberingTab() {
  const { canEdit } = usePermission("tenant_profile");
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [agreement, setAgreement] = useState<NumberFormatConfig>(DEFAULTS.agreement);
  const [account, setAccount] = useState<NumberFormatConfig>(DEFAULTS.account);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await apiClient.get<TenantConfigResponse>("/api/v1/tenant-config");
        const formats = (cfg.settings?.numberFormats ?? {}) as NumberFormats;
        if (formats.agreement) setAgreement(formats.agreement);
        if (formats.account) setAccount(formats.account);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed to load tenant config", "error");
      } finally {
        setLoading(false);
      }
    })();
  }, [toast]);

  async function save() {
    setSaving(true);
    try {
      await apiClient.patch("/api/v1/tenant-config", {
        numberFormats: { agreement, account },
      });
      toast("Numbering format saved", "success");
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
    <div style={{ maxWidth: 880, display: "flex", flexDirection: "column", gap: 24 }}>
      <section>
        <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 0, marginBottom: 8 }}>
          Identifier Templates
        </h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, marginBottom: 16 }}>
          Control how new agreement and account numbers are generated when a CSR leaves the number blank on a form. Templates use tokens for year, month, and sequence; the preview below updates live as you type.
        </p>

        <FormatCard
          label="Service Agreement"
          value={agreement}
          onChange={setAgreement}
          disabled={!canEdit}
          defaultValue={DEFAULTS.agreement}
        />

        <div style={{ height: 12 }} />

        <FormatCard
          label="Account"
          value={account}
          onChange={setAccount}
          disabled={!canEdit}
          defaultValue={DEFAULTS.account}
        />
      </section>

      <section>
        <h3 style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-muted)", marginTop: 0, marginBottom: 8 }}>
          Token reference
        </h3>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <tbody>
            {TOKEN_HELP.map((t) => (
              <tr key={t.token} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "6px 12px 6px 0", fontFamily: "'JetBrains Mono', monospace", color: "var(--accent-primary)", whiteSpace: "nowrap" }}>
                  {t.token}
                </td>
                <td style={{ padding: "6px 12px", color: "var(--text-primary)" }}>{t.meaning}</td>
                <td style={{ padding: "6px 0", color: "var(--text-muted)", fontFamily: "'JetBrains Mono', monospace" }}>{t.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
          Sequence resets are implicit: include <code>{"{YYYY}"}</code> for annual reset or <code>{"{MM}"}</code> for monthly reset. Templates without date tokens never reset.
        </p>
      </section>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={save}
          disabled={saving || !canEdit}
          style={{
            padding: "10px 20px",
            background: canEdit ? "var(--accent-primary)" : "var(--bg-elevated)",
            color: canEdit ? "white" : "var(--text-muted)",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: canEdit ? "pointer" : "not-allowed",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Saving…" : "Save Numbering"}
        </button>
      </div>
    </div>
  );
}

function FormatCard({
  label,
  value,
  onChange,
  disabled,
  defaultValue,
}: {
  label: string;
  value: NumberFormatConfig;
  onChange: (next: NumberFormatConfig) => void;
  disabled: boolean;
  defaultValue: NumberFormatConfig;
}) {
  // Live preview: run the template through the shared engine with the
  // configured startAt as a dummy sequence. If parsing fails, show the
  // error verbatim — users need to see exactly what's wrong.
  const preview = previewTemplate(value.template || "", value.startAt || 1);

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 16, background: "var(--bg-surface)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h4 style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>{label}</h4>
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          disabled={disabled}
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            padding: "4px 10px",
            borderRadius: 4,
            fontSize: 10,
            cursor: disabled ? "not-allowed" : "pointer",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Reset to default
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <div>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            Template
          </label>
          <input
            type="text"
            value={value.template}
            onChange={(e) => onChange({ ...value, template: e.target.value })}
            disabled={disabled}
            placeholder="SA-{YYYY}-{seq:4}"
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-primary)",
            }}
          />
        </div>

        <div>
          <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
            Start at
          </label>
          <input
            type="number"
            min={0}
            value={value.startAt}
            onChange={(e) => onChange({ ...value, startAt: Number(e.target.value) || 0 })}
            disabled={disabled}
            style={{
              width: "100%",
              padding: "8px 10px",
              fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace",
              background: "var(--bg-elevated)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-primary)",
            }}
          />
        </div>
      </div>

      <div style={{ marginTop: 12, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>Preview:&nbsp;</span>
        {preview.ok ? (
          <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "var(--accent-primary)", fontWeight: 700 }}>
            {preview.value}
          </span>
        ) : (
          <span style={{ color: "var(--danger)" }}>{preview.error}</span>
        )}
      </div>
    </div>
  );
}
