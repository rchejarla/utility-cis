import { describe, it, expect } from "vitest";
import { canViewModule, visibleNavItems } from "../nav-visibility";

/**
 * A sidebar section whose every item is hidden must not render its own
 * header, or the user gets a heading that opens onto nothing.
 *
 * This became reachable when the Audit Log entry moved from
 * `audit_log` to `settings`: the CSR and Field Technician presets hold
 * `audit_log` for the per-entity Audit tabs but no key in
 * Administration, so that section went from one visible entry to zero.
 */

const ADMINISTRATION = [
  { module: "tenant_users" },
  { module: "settings" },
  { module: "settings" },
  { module: "settings" },
  { module: "settings" },
  { module: "settings" },
];

/** The CSR preset, trimmed to what matters here. */
const CSR = {
  permissions: { customers: ["VIEW", "CREATE"], audit_log: ["VIEW"] },
  enabledModules: ["customers", "audit_log", "settings", "tenant_users"],
};

/** Utility Admin: holds `settings` at VIEW. */
const ADMIN = {
  permissions: { settings: ["VIEW"], tenant_users: ["VIEW", "EDIT"] },
  enabledModules: ["settings", "tenant_users"],
};

describe("canViewModule", () => {
  it("requires both the tenant module and the VIEW permission", () => {
    expect(canViewModule(ADMIN.permissions, ADMIN.enabledModules, "settings")).toBe(true);
    // Granted, but the tenant has not enabled it.
    expect(canViewModule({ theme: ["VIEW"] }, [], "theme")).toBe(false);
    // Enabled, but not granted.
    expect(canViewModule({}, ["theme"], "theme")).toBe(false);
  });

  it("treats a permission list without VIEW as not viewable", () => {
    expect(canViewModule({ settings: ["EDIT"] }, ["settings"], "settings")).toBe(false);
  });
});

describe("visibleNavItems", () => {
  it("hides every Administration entry from a CSR", () => {
    expect(visibleNavItems(ADMINISTRATION, CSR.permissions, CSR.enabledModules)).toEqual([]);
  });

  it("shows all of them to an admin", () => {
    expect(visibleNavItems(ADMINISTRATION, ADMIN.permissions, ADMIN.enabledModules)).toHaveLength(
      6,
    );
  });

  it("returns only the viewable entries from a mixed section", () => {
    const mixed = [{ module: "customers" }, { module: "settings" }, { module: "audit_log" }];
    expect(visibleNavItems(mixed, CSR.permissions, CSR.enabledModules)).toEqual([
      { module: "customers" },
      { module: "audit_log" },
    ]);
  });
});
