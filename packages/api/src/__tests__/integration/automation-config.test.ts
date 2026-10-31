import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Route-level integration test for /api/v1/settings/automation.
 *
 * Uses the existing in-memory mock harness from vitest.setup.ts (no
 * testcontainers — that lives in worker-suspension.test.ts and other
 * worker-* suites). This file's purpose is to validate request
 * shape, RBAC gating, response shape, and error handling for the
 * GET + PATCH endpoints.
 */

describe("automation-config routes", () => {
  const utilityId = "test-utility-001";
  const adminToken = createTestToken();
  const adminHeaders = { authorization: `Bearer ${adminToken}` };

  function defaultRow() {
    return {
      id: "tc1",
      utilityId,
      requireHoldApproval: false,
      settings: {},
      timezone: "UTC",
      notificationQuietStart: "22:00",
      notificationQuietEnd: "07:00",
      schedulerAuditRetentionDays: 365,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  function grantTenantProfileEdit() {
    // tenant_profile module enabled for this tenant + admin role with
    // VIEW + EDIT permission. Mirrors the mock pattern used by other
    // route integration tests in this suite.
    (prisma.utilityModule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { moduleKey: "tenant_profile" },
    ]);
    (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId,
      isActive: true,
      customerId: null,
    });
    (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      roleId: "role-admin",
      role: { name: "Admin", permissions: { tenant_profile: ["VIEW", "EDIT"] } },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    grantTenantProfileEdit();
    /*
     * A tenant being patched has a config row, so the re-read the patch
     * ends with finds one rather than lazily creating it. Set here
     * because otherwise the read's own upsert counts against the
     * patch's, which measures the mock rather than the service. The GET
     * cases override it where they need a miss.
     */
    (prisma.utilityConfig.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(defaultRow());
    (prisma.schedulerConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  describe("GET /api/v1/settings/automation", () => {
    it("returns the tenant's current automation config", async () => {
      (prisma.utilityConfig.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        defaultRow(),
      );

      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        timezone: "UTC",
        notificationQuietStart: "22:00",
        schedulerAuditRetentionDays: 365,
      });

      /*
       * Per-scheduler settings are a list, one entry per catalogue key
       * whether or not a row exists — so a scheduler added in code
       * appears for every tenant without a backfill, taking its
       * catalogue default until somebody saves one.
       */
      expect(body.schedulers.map((s: { key: string }) => s.key)).toEqual([
        "suspension",
        "notificationSend",
        "slaBreachSweep",
        "delinquency",
        "billing",
      ]);
      const billing = body.schedulers.find((s: { key: string }) => s.key === "billing");
      expect(billing).toMatchObject({ enabled: false, runHourLocal: 3, lastRunAt: null });
      // No hour for a job that has none, rather than a number nothing reads.
      expect(
        body.schedulers.find((s: { key: string }) => s.key === "suspension").runHourLocal,
      ).toBeNull();
    });

    it("creates a default row on first read for a tenant that has none", async () => {
      // First lookup misses; service falls through to upsert.
      (prisma.utilityConfig.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      (prisma.utilityConfig.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        defaultRow(),
      );

      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.utilityConfig.upsert).toHaveBeenCalledTimes(1);
    });

    it("denies without tenant_profile:VIEW permission", async () => {
      (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "test-user-001",
        utilityId,
        isActive: true,
        customerId: null,
      });
      (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        roleId: "role-readonly",
        role: { name: "ReadOnly", permissions: { other_module: ["VIEW"] } },
      });

      const app = await createTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("PATCH /api/v1/settings/automation", () => {
    it("applies a tenant-wide patch and returns the updated config", async () => {
      const upsertMock = prisma.utilityConfig.upsert as ReturnType<typeof vi.fn>;

      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { schedulerAuditRetentionDays: 90 },
      });

      expect(res.statusCode).toBe(200);
      expect(upsertMock).toHaveBeenCalledTimes(1);
      expect(upsertMock.mock.calls[0][0].update).toMatchObject({
        schedulerAuditRetentionDays: 90,
      });
    });

    it("patches one scheduler as a row, leaving the others untouched", async () => {
      /*
       * The point of the table: changing billing's hour writes one
       * `scheduler_config` row. It does not touch `utility_config`, and
       * it does not materialise rows for the four jobs nobody changed —
       * each of those keeps inheriting its catalogue default.
       */
      const schedulerUpsert = prisma.schedulerConfig.upsert as ReturnType<typeof vi.fn>;

      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { schedulers: [{ key: "billing", enabled: true, runHourLocal: 5 }] },
      });

      expect(res.statusCode).toBe(200);
      expect(schedulerUpsert).toHaveBeenCalledTimes(1);
      const args = schedulerUpsert.mock.calls[0][0];
      expect(args.where).toMatchObject({
        utilityId_schedulerKey: { utilityId, schedulerKey: "billing" },
      });
      expect(args.update).toMatchObject({ enabled: true, runHourLocal: 5 });
      expect(prisma.utilityConfig.upsert).not.toHaveBeenCalled();
    });

    it("rejects an invalid IANA timezone with 400 (semantic guard in the service)", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { timezone: "America/atlantis" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_TIMEZONE");
    });

    it("rejects malformed quiet-hour time with 400 (Zod guard at the route)", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { notificationQuietStart: "25:99" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an out-of-range run hour", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { schedulers: [{ key: "delinquency", runHourLocal: 24 }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects empty patch body", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("denies PATCH without tenant_profile:EDIT permission", async () => {
      (prisma.cisUser.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "test-user-001",
        utilityId,
        isActive: true,
        customerId: null,
      });
      (prisma.userRole.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        roleId: "role-viewer",
        role: { name: "Viewer", permissions: { tenant_profile: ["VIEW"] } },
      });

      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { schedulers: [{ key: "delinquency", runHourLocal: 5 }] },
      });
      expect(res.statusCode).toBe(403);
    });

    it("does not allow patching delinquencyLastRunAt (worker-only)", async () => {
      const app = await createTestApp();
      const res = await app.inject({
        method: "PATCH",
        url: "/api/v1/settings/automation",
        headers: adminHeaders,
        payload: { delinquencyLastRunAt: "2026-04-25T03:00:00Z" },
      });
      // The Zod schema omits this field — strict parse rejects unknown.
      expect(res.statusCode).toBe(400);
    });
  });
});
