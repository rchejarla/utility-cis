import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Bill message CRUD. Gated on the `settings` module like the other
 * reference-data catalogues a tenant edits, not on `accounts` — a
 * message is tenant configuration, and nobody should need the authority
 * to see every account in order to edit the text printed on bills.
 */

describe("/api/v1/bill-messages", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const utilityId = "test-utility-001";
  // Real UUIDs: the validator takes `accountTypeDefId` as a uuid, so a
  // readable stub id fails at the Zod layer and never reaches the
  // targeting check these cases are about.
  const GLOBAL_TYPE_ID = "aa3428ae-f760-45dc-95fe-f709ea2b8ab0";
  const OTHER_TENANT_TYPE_ID = "bb3428ae-f760-45dc-95fe-f709ea2b8ab1";

  // Permissions are read from userRole.findFirst, not from a role
  // embedded on cisUser — see mockAuthUser in authorization.test.ts,
  // which is the canonical shape.
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
      roleId: "role-admin",
      role: { id: "role-admin", name: "Admin", permissions },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    grant({ settings: ["VIEW", "CREATE", "EDIT", "DELETE"] });
  });

  it("lists the tenant's messages in print order", async () => {
    (prisma.billMessage.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "m-1", label: "Notice", body: "Text", priority: 10 },
    ]);

    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/bill-messages", headers });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
  });

  it("creates a message", async () => {
    (prisma.billMessage.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "m-1",
      label: "Notice",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Notice",
        body: "Water restrictions begin June 1.",
        activeFrom: "2026-06-01",
        priority: 10,
      },
    });

    expect(res.statusCode).toBe(201);
    const createArgs = (prisma.billMessage.create as never as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(createArgs.data.utilityId).toBe(utilityId);
    expect(createArgs.data.label).toBe("Notice");
  });

  /**
   * Targeting by account type, which had never worked.
   *
   * `account_type_def` ships five rows with `utility_id = NULL` and a
   * tenant owns none of them until it adds its own. The targeting check
   * demanded ownership, so the picker on Configuration → Bill Messages offered
   * five types from `listAccountTypes` and the save answered 404 to every
   * one — while Req 137 was recorded as shipped in two documents.
   *
   * These two cases pin both halves: a global type is targetable, and
   * another tenant's row still is not. Losing the second would turn a
   * usability fix into a cross-tenant reference.
   */
  it("accepts a message targeted at a global account type", async () => {
    const findTarget = prisma.accountTypeDef.findFirstOrThrow as never as ReturnType<typeof vi.fn>;
    findTarget.mockResolvedValue({ id: GLOBAL_TYPE_ID });
    (prisma.billMessage.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "m-2",
      label: "Residential notice",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Residential notice",
        body: "Summer watering rules.",
        activeFrom: "2026-06-01",
        accountTypeDefId: GLOBAL_TYPE_ID,
      },
    });

    expect(res.statusCode).toBe(201);
    // The lookup must admit a row this tenant does not own, which is
    // what a global default is.
    expect(findTarget.mock.calls[0][0].where).toEqual({
      id: GLOBAL_TYPE_ID,
      OR: [{ utilityId }, { utilityId: null }],
    });
  });

  it("still refuses a message targeted at another tenant's account type", async () => {
    const findTarget = prisma.accountTypeDef.findFirstOrThrow as never as ReturnType<typeof vi.fn>;
    findTarget.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No record was found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Someone else's type",
        body: "Text",
        activeFrom: "2026-06-01",
        accountTypeDefId: OTHER_TENANT_TYPE_ID,
      },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.billMessage.create).not.toHaveBeenCalled();
  });

  it("rejects a message with no active-from date", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: { label: "Notice", body: "Text" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects an active window that ends before it starts", async () => {
    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: {
        label: "Notice",
        body: "Text",
        activeFrom: "2026-06-01",
        activeTo: "2026-05-01",
      },
    });

    expect(res.statusCode).toBe(400);
  });

  /**
   * PATCH and DELETE had no tests at all, and the only thing keeping one
   * tenant out of another's messages is the `findFirstOrThrow({ id,
   * utilityId })` each performs before writing — the update and delete
   * themselves match on `id` alone. Removing that guard broke nothing,
   * which is the state these three tests exist to end.
   */
  const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
  const OTHER_TENANTS_MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

  it("updates a message, having first proved it belongs to this tenant", async () => {
    const found = prisma.billMessage.findFirstOrThrow as never as ReturnType<typeof vi.fn>;
    found.mockResolvedValue({ id: MESSAGE_ID, utilityId, label: "Notice", body: "Old" });
    (prisma.billMessage.update as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: MESSAGE_ID,
      label: "Notice",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/bill-messages/${MESSAGE_ID}`,
      headers,
      payload: { body: "New text" },
    });

    expect(res.statusCode).toBe(200);
    expect(found.mock.calls[0][0].where).toEqual({ id: MESSAGE_ID, utilityId });
  });

  it("answers 404 for a message belonging to another tenant", async () => {
    // The real error class, not a plain Error carrying a `code`: the
    // handler's P2025 → 404 branch is an `instanceof` check, so a
    // look-alike would have been a 500 here and the test would have
    // asserted behaviour the application does not have.
    (prisma.billMessage.findFirstOrThrow as never as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("No BillMessage found", {
        code: "P2025",
        clientVersion: "test",
      }),
    );

    const app = await createTestApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/bill-messages/${OTHER_TENANTS_MESSAGE_ID}`,
      headers,
      payload: { body: "New text" },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.billMessage.update as never as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("deletes a message and audits it with no after-state", async () => {
    const found = prisma.billMessage.findFirstOrThrow as never as ReturnType<typeof vi.fn>;
    found.mockResolvedValue({ id: MESSAGE_ID, utilityId, label: "Notice", body: "Text" });

    const app = await createTestApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/bill-messages/${MESSAGE_ID}`,
      // Authorization only: declaring a JSON content-type on a request
      // with no body is a 400 before the route is ever reached.
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);
    expect(found.mock.calls[0][0].where).toEqual({ id: MESSAGE_ID, utilityId });
    const audit = (prisma.auditLog.create as never as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(audit.data.action).toBe("DELETE");
    // A deleted row is in no state; this used to record `{ id }`.
    expect(audit.data.afterState).not.toEqual({ id: MESSAGE_ID });
    expect(audit.data.beforeState).toMatchObject({ id: MESSAGE_ID });
  });

  it("refuses a caller without settings:EDIT", async () => {
    grant({ settings: ["VIEW"] });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bill-messages",
      headers,
      payload: { label: "Notice", body: "Text", activeFrom: "2026-06-01" },
    });

    expect(res.statusCode).toBe(403);
  });
});
