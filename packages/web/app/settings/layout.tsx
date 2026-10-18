"use client";

import type { ReactNode } from "react";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

// Navigation to these pages lives in the main sidebar, and no longer
// all in one section: `/settings/*` URLs are listed under Settings,
// Configuration (custom-fields, bill-messages, slas) and Administration
// (api-keys, retention, ledger-integrity, danger-zone), per the section
// rules at the top of components/sidebar.tsx. The URL prefix is
// therefore not a grouping — it is just where these pages happen to
// live. No side rail is rendered here; pages own their own PageHeader
// so each one reads as a first-class destination rather than a sub-tab.
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
