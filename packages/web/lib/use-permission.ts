"use client";

import { useAuth } from "./auth-context";
import { useModuleContext } from "./module-context";

export function usePermission(module?: string) {
  const { permissions, enabledModules } = useAuth();
  const contextModule = useModuleContext();
  const m = module ?? contextModule;

  // No module specified and no context — allow everything (unprotected page)
  if (!m) {
    return { canView: true, canCreate: true, canEdit: true, canDelete: true };
  }

  const isEnabled = enabledModules.includes(m);
  const perms = permissions[m] ?? [];

  return {
    canView: isEnabled && perms.includes("VIEW"),
    canCreate: isEnabled && perms.includes("CREATE"),
    canEdit: isEnabled && perms.includes("EDIT"),
    canDelete: isEnabled && perms.includes("DELETE"),
  };
}
