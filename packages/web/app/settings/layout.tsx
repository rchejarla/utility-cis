"use client";

import type { ReactNode } from "react";
import { usePermission } from "@/lib/use-permission";
import { AccessDenied } from "@/components/ui/access-denied";

// Navigation between settings sub-pages now lives in the main sidebar
// under the collapsible "Settings" section. No side rail is rendered
// here — pages own their own PageHeader so each one reads as a
// first-class destination rather than a sub-tab.
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { canView } = usePermission("settings");
  if (!canView) return <AccessDenied />;

  return <div>{children}</div>;
}
