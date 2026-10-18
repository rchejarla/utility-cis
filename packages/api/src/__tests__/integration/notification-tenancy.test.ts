import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestToken } from "../setup.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Tenant scoping on the two notification routes that take an id from the
 * caller.
 *
 * `notification.service.ts` received `utilityId` and spent it on one
 * query — the tenant config — while the recipient lookup, the five
 * template-variable lookups and the preview's template lookup all read
 * by primary key alone. The tenant argument read as scoping and scoped
 * nothing.
 *
 * Two routes made that reachable without a second tenant's credentials:
 *
 *   - `POST /notifications/send` takes `recipientId` (validated only as
 *     a uuid) and a free-form `context` map from the request body. Naming
 *     another tenant's customer addressed the message to that customer
 *     and rendered their name, email, phone — and, through `context`,
 *     their account number, premise address and meter number — into the
 *     body, which is then persisted in `notification.resolved_variables`
 *     under the *caller's* `utility_id` and readable through the
 *     caller's own tenant-scoped GET.
 *   - `POST /notification-templates/:id/preview` returned any tenant's
 *     template subject and body.
 *
 * These tests pin the predicates rather than the absence of a leak: with
 * a mocked client there is no second tenant's row to fail to fetch, so
 * the `where` clause is the only honest evidence. The send cases are the
 * exception — they assert on what gets written and on the refusal,
 * because the stored `resolved_variables` was the exfiltration vector.
 *
 * Verified to fail against the unscoped version (five of six cases;
 * "refuses to send to a recipient this tenant does not own" passes
 * either way, because the unscoped lookup also missed on a mock, which
 * is why the companion case asserting the `where` clause exists).
 */

describe("notification routes — tenant scoping on caller-supplied ids", () => {
  const token = createTestToken();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const utilityId = "test-utility-001";

  // Real uuids: both routes validate their ids with `z.string().uuid()`,
  // so a readable stub fails at the Zod layer and never reaches the
  // lookups these cases are about.
  const OWN_CUSTOMER_ID = "aa000000-0000-4000-8000-000000000001";
  const OTHER_TENANTS_CUSTOMER_ID = "bb000000-0000-4000-8000-000000000002";
  const OTHER_TENANTS_ACCOUNT_ID = "cc000000-0000-4000-8000-000000000003";
  const OWN_TEMPLATE_ID = "dd000000-0000-4000-8000-000000000004";
  const OTHER_TENANTS_TEMPLATE_ID = "ee000000-0000-4000-8000-000000000005";

  function grant(permissions: Record<string, string[]>) {
    (prisma.utilityModule.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(
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

  /** An active EMAIL template, which `sendNotification` requires first. */
  function templateExists() {
    (prisma.notificationTemplate.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        id: OWN_TEMPLATE_ID,
        utilityId,
        eventType: "delinquency.notice",
        isActive: true,
        channels: {
          email: {
            subject: "Notice for {{customer.firstName}}",
            body: "Account {{account.accountNumber}} belongs to {{customer.firstName}}.",
          },
        },
        variables: [],
      },
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    grant({ notifications: ["VIEW", "CREATE", "EDIT", "DELETE"] });
  });

  // ─── POST /notifications/send ──────────────────────────────────

  it("refuses to send to a recipient this tenant does not own", async () => {
    templateExists();
    // Scoped, the lookup for another tenant's customer misses.
    (prisma.customer.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers,
      payload: {
        eventType: "delinquency.notice",
        channel: "EMAIL",
        recipientId: OTHER_TENANTS_CUSTOMER_ID,
        context: {},
      },
    });

    // No address resolved, so the send is refused rather than delivered
    // to a stranger.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("SEND_FAILED");
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("scopes the recipient lookup by tenant", async () => {
    templateExists();
    (prisma.customer.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const app = await createTestApp();
    await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers,
      payload: {
        eventType: "delinquency.notice",
        channel: "EMAIL",
        recipientId: OTHER_TENANTS_CUSTOMER_ID,
        context: {},
      },
    });

    const find = prisma.customer.findFirst as never as ReturnType<typeof vi.fn>;
    expect(find).toHaveBeenCalled();
    expect(find.mock.calls[0][0].where).toEqual({
      id: OTHER_TENANTS_CUSTOMER_ID,
      utilityId,
    });
  });

  it("still sends to a recipient this tenant owns", async () => {
    templateExists();
    (prisma.customer.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "jane@example.com",
      phone: null,
      firstName: "Jane",
      lastName: "Smith",
      organizationName: null,
      customerType: "INDIVIDUAL",
    });
    (prisma.notification.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "notif-1",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers,
      payload: {
        eventType: "delinquency.notice",
        channel: "EMAIL",
        recipientId: OWN_CUSTOMER_ID,
        context: {},
      },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).notificationId).toBe("notif-1");
    // Every customer read on this path is scoped — the recipient lookup
    // and the one `resolveVariables` makes for the same id.
    const find = prisma.customer.findFirst as never as ReturnType<typeof vi.fn>;
    for (const call of find.mock.calls) {
      expect(call[0].where).toMatchObject({ utilityId });
    }
  });

  /**
   * The `context` map is caller-supplied, so the entity lookups it
   * triggers are a second route to another tenant's data — and the one
   * that persists. A foreign `accountId` must resolve to nothing and
   * leave its variables unset, which is how a deleted id already
   * behaved.
   */
  it("does not render another tenant's account into the message it stores", async () => {
    templateExists();
    (prisma.customer.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: "jane@example.com",
      phone: null,
      firstName: "Jane",
      lastName: "Smith",
      organizationName: null,
      customerType: "INDIVIDUAL",
    });
    // Scoped, the foreign account misses. The default mock returns null
    // for `findFirst`; setting it explicitly says so out loud.
    (prisma.account.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.notification.create as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "notif-2",
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers,
      payload: {
        eventType: "delinquency.notice",
        channel: "EMAIL",
        recipientId: OWN_CUSTOMER_ID,
        context: { accountId: OTHER_TENANTS_ACCOUNT_ID },
      },
    });

    expect(res.statusCode).toBe(201);
    expect(
      (prisma.account.findFirst as never as ReturnType<typeof vi.fn>).mock.calls[0][0].where,
    ).toEqual({ id: OTHER_TENANTS_ACCOUNT_ID, utilityId });

    // What was written is the thing that mattered: the body renders the
    // account number as blank and `resolvedVariables` carries no account
    // keys at all, so the stored row holds nothing of the other tenant's.
    const written = (prisma.notification.create as never as ReturnType<typeof vi.fn>).mock
      .calls[0][0].data;
    expect(written.utilityId).toBe(utilityId);
    expect(written.resolvedBody).toBe("Account  belongs to Jane.");
    expect(Object.keys(written.resolvedVariables)).not.toContain("account.accountNumber");
  });

  // ─── POST /notification-templates/:id/preview ──────────────────

  it("answers 404 previewing another tenant's template", async () => {
    (prisma.notificationTemplate.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/notification-templates/${OTHER_TENANTS_TEMPLATE_ID}/preview`,
      headers,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(
      (prisma.notificationTemplate.findFirst as never as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .where,
    ).toEqual({ id: OTHER_TENANTS_TEMPLATE_ID, utilityId });
  });

  it("still previews this tenant's own template", async () => {
    (prisma.notificationTemplate.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: OWN_TEMPLATE_ID,
      utilityId,
      channels: { email: { subject: "Hello {{customer.firstName}}", body: "Dear {{customer.firstName}}," } },
      variables: [{ key: "customer.firstName", sample: "Jane" }],
    });

    const app = await createTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/notification-templates/${OWN_TEMPLATE_ID}/preview`,
      headers,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.subject).toBe("Hello Jane");
    expect(body.body).toBe("Dear Jane,");
  });
});
