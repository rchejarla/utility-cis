"use client";

import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";
import { SettingsRail } from "@/components/settings/settings-shell";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { canView } = usePermission("settings");
  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Tenant-level configuration, integrations, and administration"
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 1fr",
          gap: "40px",
          alignItems: "start",
        }}
      >
        <aside>
          <SettingsRail />
        </aside>
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    </div>
  );
}
