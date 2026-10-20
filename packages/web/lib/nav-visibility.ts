/**
 * Which navigation entries a user may see.
 *
 * Kept apart from `use-permission.ts` and from the sidebar itself so it
 * is plain data in, plain data out: no React, no context, no component
 * tree. `usePermission` answers for one module at the point of use;
 * this answers for a list, which is what deciding whether to render a
 * whole section needs.
 */

export type PermissionMap = Record<string, string[]>;

/** The same rule `usePermission().canView` applies to a single module. */
export function canViewModule(
  permissions: PermissionMap,
  enabledModules: string[],
  module: string,
): boolean {
  return enabledModules.includes(module) && (permissions[module] ?? []).includes("VIEW");
}

/**
 * The entries of one section this user may see. An empty result means
 * the section should not render at all — otherwise its header opens
 * onto nothing.
 */
/**
 * An item with no `module` is always visible: there is no key that
 * decides whether the destination exists for this person. The Dashboard
 * is the case — every staff member lands there and it shows whichever
 * widgets they can see, so gating the entry on any one key would hide
 * the landing page from whoever lacks it.
 */
export function visibleNavItems<T extends { module?: string }>(
  items: readonly T[],
  permissions: PermissionMap,
  enabledModules: string[],
): T[] {
  return items.filter(
    (item) => !item.module || canViewModule(permissions, enabledModules, item.module),
  );
}
