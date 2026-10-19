import { describe, it, expect } from "vitest";
import { PRESET_ROLES, presetDrift } from "../role-presets";

/**
 * Whether a utility's role still matches the preset it came from.
 *
 * `PRESET_ROLES` is a template copied into `role` rows at provisioning,
 * not a definition anything reads afterwards: each utility owns its
 * copies, editing one diverges it permanently, and re-provisioning will
 * not revert it (`provisioning.service.ts` says so where it refuses to
 * update an existing role). So "CSR" legitimately means different things
 * in different utilities.
 *
 * `isSystem` does not record that. It is set on all six presets at
 * creation and never changes, so a column driven by it claims a role is
 * "the standard CSR" for one whose permissions were edited into
 * something else. This is the derived answer instead — computed from the
 * permissions actually stored, so it cannot go stale.
 */

const csr = PRESET_ROLES.find((r) => r.name === "CSR")!;

describe("presetDrift", () => {
  it("calls a role nobody shipped custom", () => {
    expect(presetDrift("Auditor", { audit_log: ["VIEW"] })).toBe("custom");
  });

  it("calls an untouched preset a preset", () => {
    expect(presetDrift("CSR", csr.permissions)).toBe("preset");
  });

  it("ignores the order verbs happen to be stored in", () => {
    // Nothing guarantees array order survives a round trip through JSON
    // and an editor, and a re-ordered list grants exactly the same thing.
    const reordered = Object.fromEntries(
      Object.entries(csr.permissions).map(([m, verbs]) => [m, [...(verbs as string[])].reverse()]),
    );
    expect(presetDrift("CSR", reordered)).toBe("preset");
  });

  it("notices a verb added to a preset", () => {
    const widened = { ...csr.permissions, customers: ["VIEW", "CREATE", "EDIT", "DELETE"] };
    expect(presetDrift("CSR", widened)).toBe("modified");
  });

  it("notices a verb removed from a preset", () => {
    const narrowed = { ...csr.permissions, customers: ["VIEW"] };
    expect(presetDrift("CSR", narrowed)).toBe("modified");
  });

  it("notices a module added to a preset", () => {
    expect(presetDrift("CSR", { ...csr.permissions, theme: ["VIEW"] })).toBe("modified");
  });

  it("notices a module removed from a preset", () => {
    const { customers: _dropped, ...rest } = csr.permissions as Record<string, string[]>;
    expect(presetDrift("CSR", rest)).toBe("modified");
  });

  it("treats a module granting nothing as absent", () => {
    // An editor that unchecks every box leaves an empty array rather
    // than removing the key; that grants the same as not being there.
    expect(presetDrift("CSR", { ...csr.permissions, theme: [] })).toBe("preset");
  });
});
