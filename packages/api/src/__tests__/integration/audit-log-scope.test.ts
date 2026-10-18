import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * `GET /api/v1/audit-log` serves two different needs through one
 * endpoint, and used to serve them with one authority.
 *
 * Five entity detail pages — account, premise, rate schedule, service
 * agreement, service request — each have an Audit tab that calls it
 * with `entityType` + `entityId`. That is counter work: who changed
 * this address, who reversed that payment. The CSR and Field
 * Technician presets are granted `audit_log: ["VIEW"]` for it.
 *
 * The global Audit Log page calls the same endpoint with free-form
 * filters, and every filter is optional. So the same grant also
 * returned every audit row for the tenant — role changes, user
 * management, settings edits — to anyone who could open an account.
 * The sidebar hid the menu entry from them; it could not hide the
 * endpoint.
 *
 * An unfiltered read is now an admin surface, keyed on `settings`
 * (the key the rest of the Administration section already uses, which
 * avoids a new module and a migration for existing tenants). A read
 * pinned to one entity stays on `audit_log` alone.
 */

describe("GET /api/v1/audit-log — scope required without the admin key", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}` };
  const utilityId = "test-utility-001";

  const ACCOUNT_ID = "aa000000-0000-4000-8000-000000000001";

  function grant(permissions: Record<string, string[]>) {
    (prisma.tenantModule.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      Object.keys(permissions).map((moduleKey) => ({ moduleKey })),
    );
    (prisma.cisUser.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId,
      email: "test@example.com",
      name: "Test User",
      customerId: null,
      isActive: true,
    });
    (prisma.userRole.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      roleId: "role-under-test",
      role: { id: "role-under-test", name: "Role Under Test", permissions },
    });
  }

  /** What the CSR and Field Technician presets hold. */
  const CSR_LIKE = { audit_log: ["VIEW"] };
  /** What Utility Admin holds: the same, plus the admin key. */
  const ADMIN_LIKE = { audit_log: ["VIEW"], settings: ["VIEW"] };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.auditLog.count as never as ReturnType<typeof vi.fn>).mockResolvedValue(0);
  });

  it("refuses an unfiltered read to a role without the admin key", async () => {
    grant(CSR_LIKE);

    const app = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-log",
      headers,
    });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
    // Refused before the query, not filtered after it.
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  /**
   * `entityType` alone would sweep a whole table — every Role change,
   * every CisUser edit — which is the thing being closed. Both or
   * neither.
   */
  it("refuses a read filtered by type alone", async () => {
    grant(CSR_LIKE);

    const app = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-log?entityType=Role",
      headers,
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("allows a read pinned to one entity, which is what the Audit tabs send", async () => {
    grant(CSR_LIKE);

    const app = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/audit-log?entityType=Account&entityId=${ACCOUNT_ID}`,
      headers,
    });

    expect(res.statusCode).toBe(200);
    const where = (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .where;
    expect(where).toMatchObject({ utilityId, entityType: "Account", entityId: ACCOUNT_ID });
  });

  /**
   * The Entity Type filter on the audit log page was a hardcoded list of
   * six, while the API writes 27 distinct types — so most of the log
   * could not be filtered for. Serving the distinct values from the data
   * is what stops it drifting again.
   */
  it("lists the entity types present in this tenant's log", async () => {
    grant(CSR_LIKE);
    (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entityType: "Account" },
      { entityType: "BillDocument" },
    ]);

    const app = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-log/entity-types",
      headers,
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual(["Account", "BillDocument"]);

    const args = (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.where).toEqual({ utilityId });
    expect(args.distinct).toEqual(["entityType"]);
  });

  it("allows an unfiltered read to a role holding the admin key", async () => {
    grant(ADMIN_LIKE);

    const app = await createTestApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/audit-log",
      headers,
    });

    expect(res.statusCode).toBe(200);
    // Tenant-scoped, but otherwise the whole log.
    expect(
      (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mock.calls[0][0].where,
    ).toEqual({ utilityId });
  });
});
