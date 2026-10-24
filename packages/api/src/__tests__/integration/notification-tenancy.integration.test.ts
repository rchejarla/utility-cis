import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import {
  bootPostgres,
  resetDb,
  makeTenantFixture,
  TENANT_A,
  TENANT_B,
  ACTOR,
  type TenantFixture,
  ensurePrincipal,
  truncateTables,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";

/**
 * Tenant scoping on the notification routes, against a real Postgres
 * holding two tenants' rows.
 *
 * The companion file `notification-tenancy.test.ts` covers the same
 * seven predicates with a mocked client, and can only assert on the
 * `where` clauses — with mocks there is no second tenant's row to fail
 * to fetch, so a missing predicate and a correct one look identical
 * from the outside. That is the gap this file closes: tenant B's
 * customer, account, premise, agreement, meter and template all exist
 * here, so an unscoped lookup finds them and the leak is observable in
 * the response and in the stored row.
 *
 * The seven lookups live in `sendNotification` (the recipient),
 * `resolveVariables` (five entity reads driven by the caller-supplied
 * `context` map) and `previewTemplate` (a route parameter).
 */

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let app: FastifyInstance;
/**
 * Only tenant B's ids are referenced by the tests — they are the ones
 * that must not resolve. Tenant A still needs a full fixture, because
 * `resolveVariables` reads A's `utility_config` on every send.
 */
let fixB: TenantFixture;

/** Tenant A's own customer — the legitimate recipient. */
let customerA: { id: string; email: string | null };
/** Tenant B's rows. Nothing belonging to A may ever render these. */
let customerB: { id: string; email: string | null };
let agreementB: { id: string };
let templateA: { id: string };
let templateB: { id: string };

const EVENT_TYPE = "manual.notice";

/**
 * Every variable the five `resolveVariables` reads can set, so one send
 * exercises all five lookups at once. A missing row leaves its
 * variables unset and `renderTemplate` substitutes an empty string.
 */
const EMAIL_BODY =
  "Hi {{customer.firstName}}" +
  " | acct={{account.accountNumber}}" +
  " | addr={{premise.addressLine1}}" +
  " | sa={{agreement.agreementNumber}}" +
  " | mtr={{meter.meterNumber}}";

function makeToken(utilityId: string, actorId = ACTOR) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      utility_id: utilityId,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}

/** Tenant A's credentials. Every request in this file is made as A. */
const headers = () => ({
  authorization: `Bearer ${makeToken(TENANT_A)}`,
  "content-type": "application/json",
});

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  // RLS-OPT-OUT: this suite still connects as the migration owner.
  // Its routes run correctly as `cis_app` — no route or service was
  // found querying a tenant table without a scope — but its own test
  // bodies arrange and assert on rows through `prisma` directly, which
  // needs a `seedAsPlatform` or `runAsTenant` per site. See
  // `rate-schedule-revise-copy.integration.test.ts` for both shapes.
  // Counted by `src/__tests__/app/rls-suite-coverage.test.ts`, which
  // only lets the number go down.
  process.env.DATABASE_URL = booted.dbUrl;
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  // `$disconnect` does not dispose a pool the application owns — that
  // is the driver-adapter contract — so the pools are ended here.
  // Without it the container stops while connections are live and
  // Postgres reports 57P01 as an unhandled error after a green run.
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
  const { prisma } = prismaImports;
  await resetDb();

  // `resetDb`'s table list predates notifications and does not cover
  // these three. `notification_template` is unique on
  // (utility_id, event_type), so leftovers would collide on the second
  // test rather than fail quietly.
  await truncateTables("notification, notification_template, customer");
  await ensurePrincipal(prisma, TENANT_A);

  await makeTenantFixture(prisma, TENANT_A);
  fixB = await makeTenantFixture(prisma, TENANT_B);

  // The route is gated on the module, for the calling tenant only.
  await prisma.utilityModule.create({
    data: { utilityId: TENANT_A, moduleKey: "notifications" },
  });

  customerA = await prisma.customer.create({
    data: {
      utilityId: TENANT_A,
      customerType: "INDIVIDUAL",
      firstName: "Ada",
      lastName: "Own",
      email: "ada@tenant-a.example",
      phone: "+15550000001",
    },
    select: { id: true, email: true },
  });

  customerB = await prisma.customer.create({
    data: {
      utilityId: TENANT_B,
      customerType: "INDIVIDUAL",
      firstName: "Bea",
      lastName: "Other",
      email: "bea@tenant-b.example",
      phone: "+15550000002",
    },
    select: { id: true, email: true },
  });

  agreementB = await prisma.serviceAgreement.create({
    data: {
      utilityId: TENANT_B,
      agreementNumber: "SA-00bb",
      accountId: fixB.accountId,
      commodityId: fixB.commodityId,
      startDate: new Date("2024-01-01"),
      status: "ACTIVE",
    },
    select: { id: true },
  });

  templateA = await prisma.notificationTemplate.create({
    data: {
      utilityId: TENANT_A,
      name: "A's notice",
      eventType: EVENT_TYPE,
      isActive: true,
      channels: { email: { subject: "Notice for {{customer.firstName}}", body: EMAIL_BODY } },
      variables: [{ key: "customer.firstName", sample: "Sample" }],
    },
    select: { id: true },
  });

  templateB = await prisma.notificationTemplate.create({
    data: {
      utilityId: TENANT_B,
      name: "B's private notice",
      eventType: EVENT_TYPE,
      isActive: true,
      channels: { email: { subject: "B only", body: "B's confidential body" } },
      variables: [],
    },
    select: { id: true },
  });
}),
);

describe("POST /api/v1/notifications/send — across tenants", () => {
  /**
   * The case mocks cannot express. Tenant B's customer exists and has a
   * deliverable address, so unscoped the lookup succeeds, the send is
   * accepted, and the message is addressed to B's customer.
   */
  it("refuses to send to a customer belonging to another tenant", async () => {
    const { prisma } = prismaImports;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers: headers(),
      payload: {
        eventType: EVENT_TYPE,
        channel: "EMAIL",
        recipientId: customerB.id,
        context: {},
      },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("SEND_FAILED");

    // Nothing queued, and in particular nothing addressed to B.
    expect(await prisma.notification.count()).toBe(0);
  });

  it("sends to a customer this tenant owns", async () => {
    const { prisma } = prismaImports;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers: headers(),
      payload: {
        eventType: EVENT_TYPE,
        channel: "EMAIL",
        recipientId: customerA.id,
        context: {},
      },
    });

    expect(res.statusCode).toBe(201);

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: JSON.parse(res.body).notificationId },
    });
    expect(row.utilityId).toBe(TENANT_A);
    expect(row.recipientEmail).toBe(customerA.email);
    expect(row.resolvedBody).toContain("Hi Ada");
  });

  /**
   * `context` is caller-supplied, so it is a second route to another
   * tenant's data — and the one that persists, since the rendered body
   * and `resolved_variables` are stored under the caller's own
   * `utility_id` and readable through the caller's tenant-scoped GET.
   */
  it("resolves none of another tenant's entities named in context", async () => {
    const { prisma } = prismaImports;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/send",
      headers: headers(),
      payload: {
        eventType: EVENT_TYPE,
        channel: "EMAIL",
        recipientId: customerA.id,
        context: {
          accountId: fixB.accountId,
          premiseId: fixB.premiseId,
          agreementId: agreementB.id,
          meterId: fixB.meterId,
        },
      },
    });

    expect(res.statusCode).toBe(201);

    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: JSON.parse(res.body).notificationId },
    });

    // Every fixture value of tenant B carries its `00bb` suffix —
    // ACCT-00bb, 1 Test Lane 00bb, SA-00bb, MTR-00bb-1 — so one
    // assertion covers all four lookups.
    expect(row.resolvedBody).not.toContain("00bb");
    expect(row.resolvedBody).toContain("Hi Ada");

    // Unresolved variables are absent rather than empty-valued.
    const vars = row.resolvedVariables as Record<string, string>;
    expect(Object.keys(vars)).not.toContain("account.accountNumber");
    expect(Object.keys(vars)).not.toContain("premise.addressLine1");
    expect(Object.keys(vars)).not.toContain("agreement.agreementNumber");
    expect(Object.keys(vars)).not.toContain("meter.meterNumber");
  });
});

describe("POST /api/v1/notification-templates/:id/preview — across tenants", () => {
  it("answers 404 for another tenant's template", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/notification-templates/${templateB.id}/preview`,
      headers: headers(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    // The body of B's template must not appear in the response at all.
    expect(res.body).not.toContain("confidential");
  });

  it("still previews this tenant's own template", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/notification-templates/${templateA.id}/preview`,
      headers: headers(),
      payload: { sampleContext: { "customer.firstName": "Ada" } },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).subject).toBe("Notice for Ada");
  });
});
