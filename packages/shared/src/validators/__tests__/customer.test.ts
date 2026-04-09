import { describe, it, expect } from "vitest";
import {
  createCustomerSchema,
  updateCustomerSchema,
  customerQuerySchema,
} from "../customer";

describe("createCustomerSchema", () => {
  it("validates an individual customer", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "INDIVIDUAL",
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
      phone: "555-0100",
    });
    expect(result.success).toBe(true);
  });

  it("validates an organization customer", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "ORGANIZATION",
      organizationName: "Acme Corp",
      email: "info@acme.com",
    });
    expect(result.success).toBe(true);
  });

  it("rejects individual without firstName", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "INDIVIDUAL",
      lastName: "Doe",
    });
    expect(result.success).toBe(false);
  });

  it("rejects individual without lastName", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "INDIVIDUAL",
      firstName: "John",
    });
    expect(result.success).toBe(false);
  });

  it("rejects organization without organizationName", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "ORGANIZATION",
      email: "info@acme.com",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "INDIVIDUAL",
      firstName: "John",
      lastName: "Doe",
      email: "not-an-email",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid customerType", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "COMPANY",
      organizationName: "Acme",
    });
    expect(result.success).toBe(false);
  });

  it("defaults status to ACTIVE", () => {
    const result = createCustomerSchema.safeParse({
      customerType: "INDIVIDUAL",
      firstName: "John",
      lastName: "Doe",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("ACTIVE");
    }
  });
});

describe("updateCustomerSchema", () => {
  it("allows partial updates", () => {
    const result = updateCustomerSchema.safeParse({
      firstName: "Jane",
    });
    expect(result.success).toBe(true);
  });

  it("allows empty update", () => {
    const result = updateCustomerSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("does not allow changing customerType", () => {
    const result = updateCustomerSchema.safeParse({
      customerType: "ORGANIZATION",
    });
    // customerType should be stripped (omitted), not cause an error
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("customerType");
    }
  });

  it("validates email format on update", () => {
    const result = updateCustomerSchema.safeParse({
      email: "bad-email",
    });
    expect(result.success).toBe(false);
  });
});

describe("customerQuerySchema", () => {
  it("provides defaults for empty query", () => {
    const result = customerQuerySchema.parse({});
    expect(result.page).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.order).toBe("desc");
  });

  it("accepts search parameter", () => {
    const result = customerQuerySchema.parse({ search: "john" });
    expect(result.search).toBe("john");
  });

  it("accepts customerType filter", () => {
    const result = customerQuerySchema.parse({ customerType: "INDIVIDUAL" });
    expect(result.customerType).toBe("INDIVIDUAL");
  });

  it("rejects invalid customerType", () => {
    const result = customerQuerySchema.safeParse({ customerType: "PERSON" });
    expect(result.success).toBe(false);
  });
});
