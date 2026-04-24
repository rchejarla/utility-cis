"use client";

import { useMemo } from "react";
import type { BrandingSettings } from "@utility-cis/shared";
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

type Shape = Required<Pick<BrandingSettings, "logoUrl" | "loginSplashUrl">>;

const DEFAULTS: Shape = { logoUrl: "", loginSplashUrl: "" };

export default function BrandingSettingsPage() {
  const { canEdit } = usePermission("tenant_profile");
  const defaults = useMemo(() => DEFAULTS, []);
  const { loading, saving, draft, setDraft, isDirty, save, reset } =
    useTenantSettingsNamespace<"branding", Shape>("branding", defaults);

  if (loading) {
    return (
      <SettingsSection
        title="Branding"
        description="Apply your utility's brand to the customer portal and outgoing communications."
      >
        <p style={{ color: "var(--text-muted)", padding: "24px 0" }}>Loading…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title="Branding"
      description="Apply your utility's brand to the customer portal, outgoing email headers, and printed bill stationery."
    >
      <SettingsCard>
        <SettingRow
          label="Logo URL"
          description="Public URL of your logo (SVG or PNG). Shown on the customer portal header and bill stationery. File upload is not wired up yet — host the image elsewhere and paste the URL."
          control={
            <input
              type="url"
              placeholder="https://cdn.example.com/logo.svg"
              style={settingInputStyle}
              value={draft.logoUrl}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
            />
          }
        />
        <SettingRow
          label="Login splash image URL"
          description="Optional full-bleed background on the staff sign-in page. Recommended 2000×1200 JPG hosted on a public URL."
          control={
            <input
              type="url"
              placeholder="https://cdn.example.com/splash.jpg"
              style={settingInputStyle}
              value={draft.loginSplashUrl}
              disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, loginSplashUrl: e.target.value })}
            />
          }
        />
        <SettingRow
          label="Accent color"
          description="Primary accent used on portal buttons, links, and highlights. Lives in the Theme Editor under System → Theme Editor."
          control={<button style={settingMutedBtnStyle} disabled>See Theme Editor</button>}
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
          Only URL-based branding is persisted here. Direct file upload requires wiring the attachment service, which is deferred.
        </SettingPlaceholder>
      </div>
    </SettingsSection>
  );
}
