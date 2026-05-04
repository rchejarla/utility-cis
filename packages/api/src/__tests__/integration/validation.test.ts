import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp } from "../setup.js";
import { createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

describe("Request validation", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };

  // Note: tests that pass validation will reach the DB and likely fail with a
  // connection error. These tests focus on requests that should be REJECTED
  // by Zod validation before hitting the DB.

  // Happy-path authorization: every known module enabled + admin role with full
  // permissions, so the authz middleware always lets requests through and the
  // Zod schema parser is what decides pass/fail.
  beforeEach(() => {
    vi.clearAllMocks();
    const ALL_MODULES = [
      "customers",
      "premises",
      "meters",
      "accounts",
      "agreements",
      "commodities",
      "rate_schedules",
      "billing_cycles",
      "attachments",
      "audit_log",
      "settings",
      "theme",
    ];
    (prisma.tenantModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      ALL_MODULES.map((moduleKey) => ({ moduleKey }))
    );
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId: "test-utility-001",
      roleId: "role-admin",
      isActive: true,
      role: {
        name: "Admin",
        permissions: Object.fromEntries(
          ALL_MODULES.map((m) => [m, ["VIEW", "CREATE", "EDIT", "DELETE"]])
        ),
      },
    });
  });

  describe("Premises", () => {
    it("rejects premise with missing required fields", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/premises",
        headers,
        payload: { city: "Springfield" }, // missing addressLine1, state, zip, premiseType, commodityIds
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.length).toBeGreaterThan(0);
    });

    it("rejects premise with invalid state (not 2 chars)", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/premises",
        headers,
        payload: {
          addressLine1: "123 Main St",
          city: "Springfield",
          state: "Illinois", // should be 2-char
          zip: "62701",
          premiseType: "RESIDENTIAL",
          commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects premise with empty commodityIds array", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/premises",
        headers,
        payload: {
          addressLine1: "123 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
          premiseType: "RESIDENTIAL",
          commodityIds: [], // must have at least 1
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects premise with invalid premiseType", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/premises",
        headers,
        payload: {
          addressLine1: "123 Main St",
          city: "Springfield",
          state: "IL",
          zip: "62701",
          premiseType: "UNKNOWN_TYPE",
          commodityIds: ["550e8400-e29b-41d4-a716-446655440000"],
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Meters", () => {
    it("rejects meter with invalid UUID fields", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/meters",
        headers,
        payload: {
          premiseId: "not-a-uuid",
          meterNumber: "M001",
          commodityId: "not-a-uuid",
          meterType: "MANUAL",
          uomId: "not-a-uuid",
          installDate: "2026-01-01",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects meter with invalid meterType", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/meters",
        headers,
        payload: {
          premiseId: "550e8400-e29b-41d4-a716-446655440000",
          meterNumber: "M001",
          commodityId: "550e8400-e29b-41d4-a716-446655440001",
          meterType: "INVALID_TYPE",
          uomId: "550e8400-e29b-41d4-a716-446655440002",
          installDate: "2026-01-01",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects meter with missing required fields", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/meters",
        headers,
        payload: { meterNumber: "M001" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Service Agreements", () => {
    it("rejects service agreement with empty meters array", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/service-agreements",
        headers,
        payload: {
          agreementNumber: "SA-001",
          accountId: "550e8400-e29b-41d4-a716-446655440000",
          premiseId: "550e8400-e29b-41d4-a716-446655440001",
          commodityId: "550e8400-e29b-41d4-a716-446655440002",
          billingCycleId: "550e8400-e29b-41d4-a716-446655440004",
          startDate: "2026-04-01",
          meters: [], // should fail - min 1
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects service agreement with missing required fields", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/service-agreements",
        headers,
        payload: { agreementNumber: "SA-001" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects service agreement with invalid status", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/service-agreements",
        headers,
        payload: {
          agreementNumber: "SA-001",
          accountId: "550e8400-e29b-41d4-a716-446655440000",
          premiseId: "550e8400-e29b-41d4-a716-446655440001",
          commodityId: "550e8400-e29b-41d4-a716-446655440002",
          billingCycleId: "550e8400-e29b-41d4-a716-446655440004",
          startDate: "2026-04-01",
          status: "INVALID_STATUS",
          meters: [{ meterId: "550e8400-e29b-41d4-a716-446655440005", isPrimary: true }],
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    // Lifecycle fields are NOT settable via PATCH — closing/transitioning
    // an SA goes through `POST /:id/close` (or future transitional
    // endpoints). These tests assert the strict-schema rejection.
    it("rejects PATCH that tries to set endDate", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/service-agreements/550e8400-e29b-41d4-a716-446655440000",
        headers,
        payload: { endDate: "2026-05-01" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects PATCH that tries to set status", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/service-agreements/550e8400-e29b-41d4-a716-446655440000",
        headers,
        payload: { status: "FINAL" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects POST /:id/close without endDate", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/service-agreements/550e8400-e29b-41d4-a716-446655440000/close",
        headers,
        payload: { status: "FINAL" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects POST /:id/close with non-terminal status", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/service-agreements/550e8400-e29b-41d4-a716-446655440000/close",
        headers,
        payload: { endDate: "2026-05-01", status: "ACTIVE" },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Rate Schedules", () => {
    // Legacy v1 validation tests targeted rateType + rateConfig
    // (FLAT/TIERED/etc.). Those fields no longer exist on the
    // RateSchedule — pricing moved to RateComponent rows in slice
    // 1 task 5, with grammar validators in task 4. The new
    // configurator's validation tests will replace these once
    // tasks 4-5 land.
    it.skip("rejects rate schedule with invalid component grammar (task 4-5)", () => {
      // placeholder — see slice 1 task 4 for rate-grammar tests
      // and task 5 for component CRUD validation tests.
    });

    it("rejects rate schedule with missing required name", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/rate-schedules",
        headers,
        payload: {
          code: "BAD",
          commodityId: "550e8400-e29b-41d4-a716-446655440000",
          effectiveDate: "2026-04-01",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Billing Cycles", () => {
    it("rejects billing cycle with read day > 28", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/billing-cycles",
        headers,
        payload: {
          name: "Bad Cycle",
          cycleCode: "BAD",
          readDayOfMonth: 31, // max is 28
          billDayOfMonth: 15,
          frequency: "MONTHLY",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects billing cycle with bill day > 28", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/billing-cycles",
        headers,
        payload: {
          name: "Bad Cycle",
          cycleCode: "BAD",
          readDayOfMonth: 15,
          billDayOfMonth: 29, // max is 28
          frequency: "MONTHLY",
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects billing cycle with invalid frequency", async () => {
      const app = await createTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/billing-cycles",
        headers,
        payload: {
          name: "Bad Cycle",
          cycleCode: "BAD",
          readDayOfMonth: 15,
          billDayOfMonth: 20,
          frequency: "WEEKLY", // not a valid enum value
        },
      });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
