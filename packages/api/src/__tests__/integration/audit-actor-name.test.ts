import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * An audit row without an actor name is not a lesser audit row — it is
 * a row that has lost the thing the table exists to record.
 *
 * `AuditContext.actorName` was optional and `writeAuditRow` did
 * `ctx.actorName ?? undefined`, so a service that simply never passed
 * it wrote null and nothing complained. Three call sites did exactly
 * that; in the dev database all twenty `BillDocument` rows had a null
 * actor name while every other entity's rows carried one.
 *
 * Nothing legitimately produces a null:
 *   - `CisUser.name` is NOT NULL in the schema.
 *   - `auth.ts:77` resolves `request.user.name` to the name claim, then
 *     the email, then "Unknown" — never empty.
 *   - Scheduler audits name themselves ("SLA breach sweeper") and null
 *     `actorId` instead.
 *
 * So the field is now required, and this test covers the path that had
 * no coverage at all rather than the type (which the compiler checks).
 */

describe("audit rows carry the actor's name", () => {
  const token = createTestToken({ name: "Audit Tester" });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const utilityId = "test-utility-001";

  const ACCOUNT_ID = "aa000000-0000-4000-8000-000000000001";
  // Both routes validate the path id with `z.string().uuid()`.
  const CONTACT_ID = "bb000000-0000-4000-8000-000000000002";

  function grant(permissions: Record<string, string[]>) {
    (prisma.utilityModule.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      Object.keys(permissions).map((moduleKey) => ({ moduleKey })),
    );
    (prisma.cisUser.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "test-user-001",
      utilityId,
      email: "test@example.com",
      name: "Audit Tester",
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
    grant({ customers: ["VIEW", "CREATE", "EDIT", "DELETE"] });
  });

  it("names the actor on a Contact audit row", async () => {
    (prisma.contact.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "contact-1",
      utilityId,
      accountId: ACCOUNT_ID,
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/contacts",
      headers,
      payload: {
        accountId: ACCOUNT_ID,
        firstName: "Pat",
        lastName: "Contact",
        phone: "+15550000001",
      },
    });

    expect(res.statusCode).toBe(201);

    const written = (prisma.auditLog.create as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .data;
    expect(written.entityType).toBe("Contact");
    expect(written.actorId).toBe("test-user-001");
    expect(written.actorName).toBe("Audit Tester");
  });

  /**
   * `deleteContact` took `_actorId` and wrote no audit row at all, so a
   * contact could be removed with no record of it — the one state
   * change this table is supposed to make impossible to lose. Deletion
   * is also the case where the audit row is the only surviving evidence,
   * since the row it describes is gone.
   */
  it("records a Contact deletion, with the actor and the prior state", async () => {
    const before = {
      id: CONTACT_ID,
      utilityId,
      accountId: ACCOUNT_ID,
      firstName: "Pat",
      lastName: "Contact",
    };
    (prisma.contact.findFirstOrThrow as never as ReturnType<typeof vi.fn>).mockResolvedValue(before);
    (prisma.contact.delete as never as ReturnType<typeof vi.fn>).mockResolvedValue(before);

    const app = await createTestApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/contacts/${CONTACT_ID}`,
      // Authorization only: declaring `content-type: application/json`
      // on a body-less DELETE makes Fastify answer 400 before the route
      // is reached.
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(204);

    const written = (prisma.auditLog.create as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .data;
    expect(written.entityType).toBe("Contact");
    expect(written.action).toBe("DELETE");
    expect(written.actorName).toBe("Audit Tester");
    // The prior state is the only record of what was removed.
    expect(written.beforeState).toMatchObject({ firstName: "Pat", lastName: "Contact" });
    // A deleted row is in no state. Not `toBeNull()`: `toJsonInput`
    // converts null to `Prisma.JsonNull`, a sentinel object, because the
    // Json column rejects `undefined` — so the assertion is that nothing
    // of the contact survives here.
    expect(written.afterState).not.toMatchObject({ firstName: "Pat" });
    expect(written.afterState).not.toEqual({ id: CONTACT_ID });
  });

  /**
   * The rows already written cannot be repaired — the name they should
   * have recorded is not recoverable, and `actor_name` is denormalized
   * precisely so history survives a rename. Backfilling it with the
   * actor's present name would quietly falsify that.
   *
   * So the list resolves a missing name for *display* only, in a
   * separate field the UI can label as current rather than historical.
   */
  it("offers the actor's current name for a row that never recorded one", async () => {
    grant({ audit_log: ["VIEW"], settings: ["VIEW"] });
    (prisma.auditLog.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "a1", actorId: "test-user-001", actorName: null, entityType: "BillDocument" },
      { id: "a2", actorId: "test-user-001", actorName: "Recorded Name", entityType: "Account" },
    ]);
    (prisma.auditLog.count as never as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (prisma.cisUser.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "test-user-001", name: "Sarah Mitchell" },
    ]);

    const app = await createTestApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/audit-log", headers });

    expect(res.statusCode).toBe(200);
    const rows = JSON.parse(res.body).data;
    // Missing name: the current one is offered alongside.
    expect(rows[0].actorNameCurrent).toBe("Sarah Mitchell");
    // Recorded name: left exactly as recorded, with no suggestion.
    expect(rows[1].actorName).toBe("Recorded Name");
    expect(rows[1].actorNameCurrent).toBeNull();

    // The lookup is tenant-scoped like every other read.
    const where = (prisma.cisUser.findMany as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .where;
    expect(where).toMatchObject({ utilityId });
  });
});
