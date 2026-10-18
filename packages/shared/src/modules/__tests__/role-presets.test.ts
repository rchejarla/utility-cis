import { describe, it, expect } from "vitest";
import { MODULES } from "../constants";
import { PRESET_ROLES } from "../role-presets";

/**
 * These presets lived in two places once — here and in `seed.js` — and
 * drifted four modules apart before the copy here was deleted on
 * 2026-10-18 for having no consumer at all. `provisionTenant` is that
 * consumer, so they are back, and `seed.js` now delegates rather than
 * declaring its own.
 *
 * The second test is the one that would have caught the original drift:
 * it asserts the presets and `MODULES` still agree.
 */

describe("PRESET_ROLES", () => {
  it("defines the six roles, in the order a tenant gets them", () => {
    expect(PRESET_ROLES.map((r) => r.name)).toEqual([
      "System Admin",
      "Utility Admin",
      "CSR",
      "Field Technician",
      "Read-Only",
      "Portal Customer",
    ]);
  });

  it("grants no module that does not exist", () => {
    for (const role of PRESET_ROLES) {
      for (const key of Object.keys(role.permissions)) {
        expect(MODULES).toContain(key);
      }
    }
  });

  it("separates the two admins by settings alone", () => {
    const system = PRESET_ROLES.find((r) => r.name === "System Admin")!;
    const utility = PRESET_ROLES.find((r) => r.name === "Utility Admin")!;

    // Both hold every module; the only difference is who may change this
    // tenant's own settings. That pair is what §1.2 of the tenancy design
    // note is about.
    expect(Object.keys(system.permissions)).toHaveLength(MODULES.length);
    expect(Object.keys(utility.permissions)).toHaveLength(MODULES.length);
    expect(system.permissions.settings).toEqual(["VIEW", "CREATE", "EDIT", "DELETE"]);
    expect(utility.permissions.settings).toEqual(["VIEW"]);
  });

  it("gives Read-Only everything except settings, theme and the portal", () => {
    const readOnly = PRESET_ROLES.find((r) => r.name === "Read-Only")!;
    const granted = Object.keys(readOnly.permissions);

    expect(granted).not.toContain("settings");
    expect(granted).not.toContain("theme");
    expect(granted.filter((k) => k.startsWith("portal_"))).toEqual([]);
    // 26 of the 32: the three above plus four portal_* keys.
    expect(granted).toHaveLength(
      MODULES.filter((m) => m !== "settings" && m !== "theme" && !m.startsWith("portal_")).length,
    );
    expect(Object.values(readOnly.permissions).every((p) => p?.length === 1)).toBe(true);
  });

  it("confines Portal Customer to the four portal modules", () => {
    const portal = PRESET_ROLES.find((r) => r.name === "Portal Customer")!;
    expect(Object.keys(portal.permissions).every((k) => k.startsWith("portal_"))).toBe(true);
    expect(portal.permissions.portal_profile).toEqual(["VIEW", "EDIT"]);
  });

  it("marks every preset as a system role", () => {
    expect(PRESET_ROLES.every((r) => r.isSystem)).toBe(true);
  });
});
