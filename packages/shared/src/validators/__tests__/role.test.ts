import { describe, it, expect } from "vitest";
import { createRoleSchema } from "../role";

describe("createRoleSchema", () => {
  it("validates a valid role", () => {
    const result = createRoleSchema.safeParse({
      name: "CSR",
      permissions: { customers: ["VIEW", "CREATE", "EDIT"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects CREATE without VIEW (BR-RB-004)", () => {
    const result = createRoleSchema.safeParse({
      name: "Bad Role",
      permissions: { customers: ["CREATE"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects EDIT without VIEW (BR-RB-004)", () => {
    const result = createRoleSchema.safeParse({
      name: "Bad Role",
      permissions: { meters: ["EDIT"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects DELETE without VIEW (BR-RB-004)", () => {
    const result = createRoleSchema.safeParse({
      name: "Bad Role",
      permissions: { accounts: ["DELETE"] },
    });
    expect(result.success).toBe(false);
  });

  it("allows VIEW only", () => {
    const result = createRoleSchema.safeParse({
      name: "Read Only",
      permissions: { customers: ["VIEW"], premises: ["VIEW"] },
    });
    expect(result.success).toBe(true);
  });

  it("allows empty permissions (no access)", () => {
    const result = createRoleSchema.safeParse({
      name: "No Access",
      permissions: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid module key", () => {
    const result = createRoleSchema.safeParse({
      name: "Bad",
      permissions: { nonexistent: ["VIEW"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid permission", () => {
    const result = createRoleSchema.safeParse({
      name: "Bad",
      permissions: { customers: ["SUPERADMIN"] },
    });
    expect(result.success).toBe(false);
  });
});
