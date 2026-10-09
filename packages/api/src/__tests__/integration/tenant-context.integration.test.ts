import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyRequest, FastifyReply } from "fastify";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * `app.current_utility_id` must not outlive the work that set it.
 *
 * The RLS policies read this setting, so a value left behind on a pooled
 * connection is read by whatever request picks that connection up next.
 * While the application role is a superuser the policies are inert and
 * nothing happens; the day that changes, residue becomes a cross-tenant
 * read that raises no error.
 *
 * The pool is pinned to one connection (`connection_limit=1`) so "the
 * next request gets the same connection" is certain rather than likely —
 * which is what makes these assertions deterministic instead of flaky.
 */

const TENANT_A = "00000000-0000-4000-8000-0000000000aa";
const TENANT_B = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let tenantMiddleware: typeof import("../../middleware/tenant.js")["tenantMiddleware"];

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;

  // Pin the pool to a single connection BEFORE the prisma singleton is
  // constructed from this URL on import.
  process.env.DATABASE_URL =
    booted.dbUrl + (booted.dbUrl.includes("?") ? "&" : "?") + "connection_limit=1";

  prismaImports = await import("../../lib/prisma.js");
  ({ tenantMiddleware } = await import("../../middleware/tenant.js"));
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

/** What the next request on this connection would see. */
async function residualTenant(): Promise<string> {
  const [row] = await prismaImports.prisma.$queryRaw<{ v: string | null }[]>`
    SELECT COALESCE(current_setting('app.current_utility_id', true), '') AS v`;
  return row?.v ?? "";
}

/** Minimal fakes — tenantMiddleware reads only these three things. */
function fakeRequest(utilityId?: string): FastifyRequest {
  return {
    routeOptions: { config: {}, url: "/api/v1/accounts" },
    user: utilityId ? { utilityId } : undefined,
  } as unknown as FastifyRequest;
}

function fakeReply(): { reply: FastifyReply; statusCode: number | null } {
  const captured: { statusCode: number | null } = { statusCode: null };
  const reply = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    send() {
      return this;
    },
  };
  return { reply: reply as unknown as FastifyReply, statusCode: captured.statusCode };
}

describe("tenant context does not leak between requests", () => {
  it("leaves nothing behind after a request is handled", async () => {
    const { reply } = fakeReply();
    await tenantMiddleware(fakeRequest(TENANT_A), reply);

    // The request is over. A later request on this same connection must
    // not be able to see tenant A's id.
    expect(await residualTenant()).toBe("");
  });

  it("does not let one tenant's request see the previous tenant's id", async () => {
    const first = fakeReply();
    await tenantMiddleware(fakeRequest(TENANT_A), first.reply);

    const second = fakeReply();
    await tenantMiddleware(fakeRequest(TENANT_B), second.reply);

    // Whatever B's request does next, it must not inherit A.
    const residue = await residualTenant();
    expect(residue).not.toBe(TENANT_A);
    expect(residue).toBe("");
  });

  it("still rejects a request with no utility context", async () => {
    const captured: number[] = [];
    const reply = {
      status(code: number) {
        captured.push(code);
        return this;
      },
      send() {
        return this;
      },
    } as unknown as FastifyReply;

    await tenantMiddleware(fakeRequest(undefined), reply);
    expect(captured).toEqual([400]);
  });

  it("withTenant's context is confined to its own transaction", async () => {
    const { prisma, withTenant } = prismaImports;

    const seen = await withTenant(TENANT_A, async (tx) => {
      const [row] = await tx.$queryRaw<{ v: string | null }[]>`
        SELECT current_setting('app.current_utility_id', true) AS v`;
      return row?.v ?? "";
    });
    // Visible inside...
    expect(seen).toBe(TENANT_A);
    // ...gone once the transaction commits.
    expect(await residualTenant()).toBe("");
    expect(prisma).toBeDefined();
  });
});
