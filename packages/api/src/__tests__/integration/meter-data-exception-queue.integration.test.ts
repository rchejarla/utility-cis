import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
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
  endAdminPool,
  ensurePrincipal,
  seedAsPlatform,
} from "./_effective-dating-fixtures.js";
import { runAsTenant } from "../../lib/tenant-context.js";

/**
 * Working the interval-coverage queue (spec 26, TOU-GAP-1).
 *
 * The sweep opens these rows and resolves them when the data arrives.
 * Everything else is a judgement somebody makes, and one of those
 * judgements has teeth: **`accepted` stops the pre-run check blocking
 * those minutes**, so the month bills with a hole in it. That is the
 * point of the status — a gap the head-end will never backfill has to
 * be billable by somebody's decision — and it is why the transitions
 * are tested here against real rows rather than asserted in a unit
 * suite over a mocked client.
 *
 * The transition rules, and why each one is a refusal rather than a
 * no-op:
 *
 * - **Accept only from `open`.** `minutesAccepted` is a *sum* over
 *   accepted rows, so accepting a `resolved` row — one whose data has
 *   since arrived — would forgive minutes that are no longer missing,
 *   and could let a genuinely incomplete month through. Accepting an
 *   already-accepted row is refused too: silence there reads as "it
 *   worked" to a caller who may have meant a different row.
 * - **Reopen only from `accepted`.** It is the undo for a decision with
 *   billing consequences. `resolved` is the sweep's to set and to
 *   unset: a person reopening it would be claiming a hole exists when
 *   the data says otherwise.
 */

/*
 * Nothing here enqueues, and nothing here should: the only reason this
 * file builds the app at all is the permission gate. Mocked anyway,
 * because an enqueue that reached the dev Redis would leave a job
 * naming rows in a container that is about to be torn down — which is
 * how 102 unrunnable jobs once appeared on the platform console.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let app: FastifyInstance;
/*
 * Dynamic, after `bootPostgres` has pointed `DATABASE_URL` at the
 * container: the service holds `prisma` at module scope, so a static
 * import builds its pool against an empty environment and fails with
 * "SASL: client password must be a string".
 */
let svc: typeof import("../../services/meter-data-exception.service.js");

let fixA: TenantFixture;
let fixB: TenantFixture;

const WINDOW_A = new Date("2026-01-10T00:00:00.000Z");
const WINDOW_B = new Date("2026-01-11T00:00:00.000Z");

const ctx = {
  utilityId: TENANT_A,
  actorId: ACTOR,
  actorName: "Tester",
  entityType: "meter_data_exception",
};

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [TENANT_A, TENANT_B] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  svc = await import("../../services/meter-data-exception.service.js");
  const appImports = await import("../../app.js");
  app = await appImports.buildApp();
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await prismaImports?.pool.end().catch(() => {});
  await endAdminPool();
  await pgContainer?.stop().catch(() => {});
});

beforeEach(() =>
  seedAsPlatform(async () => {
    await resetDb();
    fixA = await makeTenantFixture(prismaImports.prisma, TENANT_A);
    fixB = await makeTenantFixture(prismaImports.prisma, TENANT_B);
    await ensurePrincipal(prismaImports.prisma, TENANT_A);
    await prismaImports.prisma.utilityModule.create({
      data: { utilityId: TENANT_A, moduleKey: "meter_reads" },
    });
    // RBAC caches a tenant's modules in Redis for 600s, so a file that
    // did not invalidate would read the previous file's answer.
    const rbac = await import("../../services/rbac.service.js");
    await rbac.invalidateTenantModulesCache(TENANT_A);
  }));

/** A signature-free token, as every integration file here mints one. */
function headers() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR,
      utility_id: TENANT_A,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return { authorization: `Bearer ${header}.${payload}.fake-signature` };
}

/**
 * One exception row. `async` inside the platform scope, never a
 * returned `PrismaPromise`: a lazy promise handed out of the scope runs
 * after it has exited, and surfaces as
 * `invalid input syntax for type uuid: ""` from a line that plainly
 * asked for the platform.
 */
async function seedEx(over: {
  utilityId?: string;
  meterId?: string;
  windowStart?: Date;
  kind?: string;
  status?: string;
  minutesAffected?: number;
} = {}): Promise<string> {
  const windowStart = over.windowStart ?? WINDOW_A;
  return seedAsPlatform(async () => {
    const row = await prismaImports.prisma.meterDataException.create({
      data: {
        utilityId: over.utilityId ?? TENANT_A,
        meterId: over.meterId ?? (over.utilityId === TENANT_B ? fixB.meterId : fixA.meterId),
        windowStart,
        windowEnd: new Date(windowStart.getTime() + 86_400_000),
        kind: over.kind ?? "gap",
        minutesAffected: over.minutesAffected ?? 180,
        detail: `${over.minutesAffected ?? 180} minutes missing`,
        status: over.status ?? "open",
        /*
         * Null only for an open row. `resolved_at` is "when it stopped
         * being open", and its CHECK ties it to `status` both ways — so
         * an accepted row without one cannot be written, which is how
         * this helper first failed.
         */
        resolvedAt: (over.status ?? "open") === "open" ? null : new Date(),
      },
      select: { id: true },
    });
    return row.id;
  });
}

const list = (query: Record<string, unknown> = {}) =>
  runAsTenant(TENANT_A, async () =>
    svc.listDataExceptions(TENANT_A, {
      page: 1,
      limit: 20,
      sort: "windowStart" as const,
      order: "desc" as const,
      ...query,
    } as Parameters<typeof svc.listDataExceptions>[1]),
  );

describe("listing the queue", () => {
  it("returns the rows with the meter they belong to, newest window first", async () => {
    await seedEx({ windowStart: WINDOW_A });
    await seedEx({ windowStart: WINDOW_B });

    const page = await list();

    expect(page.meta.total).toBe(2);
    expect(page.data.map((r) => r.windowStart.toISOString())).toEqual([
      WINDOW_B.toISOString(),
      WINDOW_A.toISOString(),
    ]);
    // The meter number is what a person recognises; the id is not.
    expect(page.data[0].meter.meterNumber).toBeTruthy();
  });

  it("filters to one status", async () => {
    await seedEx({ status: "open" });
    await seedEx({ status: "resolved", windowStart: WINDOW_B });

    const page = await list({ status: "open" });

    expect(page.meta.total).toBe(1);
    expect(page.data[0].status).toBe("open");
  });

  it("filters to one kind", async () => {
    await seedEx({ kind: "gap" });
    await seedEx({ kind: "missing_reading", windowStart: WINDOW_B });

    const page = await list({ kind: "missing_reading" });

    expect(page.meta.total).toBe(1);
    expect(page.data[0].kind).toBe("missing_reading");
  });

  it("does not reach another tenant's exceptions", async () => {
    await seedEx({ utilityId: TENANT_B });

    const page = await list();

    expect(page.meta.total).toBe(0);
  });
});

describe("accepting an exception", () => {
  it("marks it accepted, so the pre-run check stops blocking those minutes", async () => {
    const id = await seedEx({ status: "open" });

    const row = await runAsTenant(TENANT_A, () => svc.acceptDataException(id, ctx));

    expect(row.status).toBe("accepted");
    /*
     * `resolved_at` is set, which looks wrong and is not: the column
     * means "when it stopped being open", and its CHECK ties it to
     * `status` in both directions. On an accepted row it is the moment
     * somebody took responsibility for billing the hole — the hole
     * itself is still there, which `status` is what says.
     */
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });

  it("records who accepted it", async () => {
    const id = await seedEx({ status: "open" });

    await runAsTenant(TENANT_A, () => svc.acceptDataException(id, ctx));

    const audit = await seedAsPlatform(async () =>
      prismaImports.prisma.auditLog.findMany({
        where: { utilityId: TENANT_A, entityId: id },
        select: { action: true, actorName: true, metadata: true },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "UPDATE", actorName: "Tester" });
    expect(audit[0].metadata).toMatchObject({ eventType: "meter_data_exception.accepted" });
  });

  it("refuses a resolved row, whose minutes are no longer missing", async () => {
    const id = await seedEx({ status: "resolved" });

    await expect(
      runAsTenant(TENANT_A, () => svc.acceptDataException(id, ctx)),
    ).rejects.toMatchObject({ code: "DATA_EXCEPTION_NOT_OPEN", statusCode: 409 });
  });

  it("refuses one that is already accepted, rather than silently agreeing", async () => {
    const id = await seedEx({ status: "accepted" });

    await expect(
      runAsTenant(TENANT_A, () => svc.acceptDataException(id, ctx)),
    ).rejects.toMatchObject({ code: "DATA_EXCEPTION_NOT_OPEN" });
  });

  it("does not reach another tenant's exception", async () => {
    const id = await seedEx({ utilityId: TENANT_B });

    await expect(
      runAsTenant(TENANT_A, () => svc.acceptDataException(id, ctx)),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("reopening an exception", () => {
  it("puts an accepted one back, because acceptance decides what gets billed", async () => {
    const id = await seedEx({ status: "accepted" });

    const row = await runAsTenant(TENANT_A, () => svc.reopenDataException(id, ctx));

    expect(row.status).toBe("open");
    // Cleared with it: an open row carrying a resolution time is a
    // record nobody can read, and the CHECK refuses it.
    expect(row.resolvedAt).toBeNull();
  });

  it("refuses a resolved one, which is the sweep's to say", async () => {
    const id = await seedEx({ status: "resolved" });

    await expect(
      runAsTenant(TENANT_A, () => svc.reopenDataException(id, ctx)),
    ).rejects.toMatchObject({ code: "DATA_EXCEPTION_NOT_ACCEPTED", statusCode: 409 });
  });
});

/**
 * The HTTP surface, for the one thing the service tests cannot see:
 * **which key the route answers to.**
 *
 * This repo has shipped the other outcome twice — a menu entry whose
 * API answered 403 for every role, and two write routes whose module
 * had moved while the test fixture's list had not. Both passed every
 * service test they had. So the gate is asserted from the outside, in
 * both directions: enabled, and not.
 */
describe("over HTTP", () => {
  it("lists the queue for a tenant with meter reads enabled", async () => {
    await seedEx({ status: "open" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meter-data-exceptions?status=open",
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ status: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0].status).toBe("open");
  });

  it("refuses a misspelled filter rather than ignoring it and listing everything", async () => {
    await seedEx({ status: "open" });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meter-data-exceptions?statuss=open",
      headers: headers(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("accepts one, and reports the row it changed", async () => {
    const id = await seedEx({ status: "open" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/meter-data-exceptions/${id}/accept`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("accepted");
  });

  it("answers 409 with the reason when the row is not open", async () => {
    const id = await seedEx({ status: "resolved" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/meter-data-exceptions/${id}/accept`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("DATA_EXCEPTION_NOT_OPEN");
    // The message has to say which state it was in: "cannot accept" on
    // its own sends somebody to look for a bug.
    expect(body.error.message).toContain("resolved");
  });

  it("reopens an accepted one", async () => {
    const id = await seedEx({ status: "accepted" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/meter-data-exceptions/${id}/reopen`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("open");
  });

  it("answers 403 when the tenant does not have meter reads enabled", async () => {
    await seedEx({ status: "open" });
    await seedAsPlatform(async () => {
      await prismaImports.prisma.utilityModule.deleteMany({
        where: { utilityId: TENANT_A, moduleKey: "meter_reads" },
      });
      const rbac = await import("../../services/rbac.service.js");
      await rbac.invalidateTenantModulesCache(TENANT_A);
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/meter-data-exceptions",
      headers: headers(),
    });

    expect(res.statusCode).toBe(403);
  });
});
