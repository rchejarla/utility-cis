"use client";

import type { ReactNode } from "react";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

// Navigation between settings sub-pages now lives in the main sidebar
// under the collapsible "Settings" section. No side rail is rendered
// here — pages own their own PageHeader so each one reads as a
// first-class destination rather than a sub-tab.
//
// The layout gate admits anyone who can view at least one settings
// module, since /settings/* is split across several permission keys
// (tenant_profile for general/branding/theme/numbering/custom-fields/
// notifications, service_request_slas for /settings/slas, plain
// `settings` for billing/retention/api-keys/danger-zone). Per-page
// checks still decide whether each sub-page is rendered for the user.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { canView: canViewSettings } = usePermission("settings");
  const { canView: canViewTenantProfile } = usePermission("tenant_profile");
  const { canView: canViewTheme } = usePermission("theme");
  const { canView: canViewSlas } = usePermission("service_request_slas");
  const canView = canViewSettings || canViewTenantProfile || canViewTheme || canViewSlas;
  if (!canView) return <AccessDenied />;

  return <div>{children}</div>;
}
