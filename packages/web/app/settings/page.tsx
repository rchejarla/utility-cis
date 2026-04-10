"use client";

import { PageHeader } from "../../components/ui/page-header";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

export default function SettingsPage() {
  const { canView } = usePermission("settings");
  if (!canView) return <AccessDenied />;

  return (
    <div>
      <PageHeader title="Settings" subtitle="Tenant configuration" />
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "40px",
          textAlign: "center",
          color: "var(--text-muted)",
        }}
      >
        <p style={{ fontSize: "16px", marginBottom: "8px" }}>Settings</p>
        <p style={{ fontSize: "13px" }}>
          Tenant configuration will be available in a future update.
        </p>
      </div>
    </div>
  );
}
