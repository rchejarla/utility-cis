import { describe, it, expect } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authMiddleware } from "../../middleware/auth.js";
import { createTestToken, createPlatformToken, createTokenFromClaims } from "../setup.js";

/**
 * A token says which kind of identity it carries.
 *
 * Q2 puts the platform actor in `cis_user` with a null `utility_id`, so
 * its token has no tenant to name. `assignUser` used to throw "Missing
 * required token fields" for exactly that shape, which is why a platform
 * actor could not authenticate at all before this.
 *
 * It gets a sibling rather than a relaxation, and `request.user` keeps
 * its non-nullable `utilityId`: 243 sites read it, and making it
 * `string | null` would turn every one of them into a site that has to
 * prove it meant a tenant — the opposite of what §1.7 asks for. So a
 * platform token populates `request.platformActor` and leaves
 * `request.user` unset, and the authorization middleware refuses each
 * kind on the other's routes (Task 4), which is what keeps
 * `request.user` read only where it is set.
 *
 * Tested against the middleware directly rather than through an injected
 * route: what is under test is which property gets populated, and a
 * route can only show that indirectly.
 */

function fakeRequest(token?: string): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    routeOptions: { config: {}, url: "/api/v1/anything" },
  } as unknown as FastifyRequest;
}

function fakeReply() {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.code = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

describe("authMiddleware and the two kinds of identity", () => {
  it("populates platformActor for a platform token, and leaves user unset", async () => {
    const request = fakeRequest(createPlatformToken({ sub: "actor-1", email: "ops@example.gov" }));
    const { reply, sent } = fakeReply();

    await authMiddleware(request, reply);

    expect(sent.code).toBeUndefined();
    expect(request.platformActor).toMatchObject({ id: "actor-1", email: "ops@example.gov" });
    expect(request.user).toBeUndefined();
  });

  it("populates user for a tenant token, and leaves platformActor unset", async () => {
    const request = fakeRequest(createTestToken());
    const { reply, sent } = fakeReply();

    await authMiddleware(request, reply);

    expect(sent.code).toBeUndefined();
    expect(request.user).toMatchObject({ id: "test-user-001", utilityId: "test-utility-001" });
    expect(request.platformActor).toBeUndefined();
  });

  it("refuses a token claiming both a tenant and the platform", async () => {
    // Ambiguous, and whichever kind we picked the token would carry
    // authority it was not issued. A 401 beats a silent choice.
    const request = fakeRequest(
      createTokenFromClaims({ sub: "x", utility_id: "test-utility-001", platform: true }),
    );
    const { reply, sent } = fakeReply();

    await authMiddleware(request, reply);

    expect(sent.code).toBe(401);
    expect(request.user).toBeUndefined();
    expect(request.platformActor).toBeUndefined();
  });

  it("refuses a token claiming neither", async () => {
    // The shape a truncated or hand-rolled token produces. Treating an
    // absent utility_id as "therefore the platform" would promote every
    // malformed token to the one identity that crosses tenants.
    const request = fakeRequest(createTokenFromClaims({ sub: "x", email: "a@b.gov" }));
    const { reply, sent } = fakeReply();

    await authMiddleware(request, reply);

    expect(sent.code).toBe(401);
    expect(request.platformActor).toBeUndefined();
  });

  it("refuses a platform token with no subject", async () => {
    // No subject is no identity, so there is nothing to look up.
    const request = fakeRequest(createTokenFromClaims({ platform: true, email: "a@b.gov" }));
    const { reply, sent } = fakeReply();

    await authMiddleware(request, reply);

    expect(sent.code).toBe(401);
    expect(request.platformActor).toBeUndefined();
  });

  it("names a platform actor that sent no name claim", async () => {
    // Same fallback the tenant path uses: audit attribution should never
    // read as blank.
    const request = fakeRequest(createTokenFromClaims({ sub: "a", platform: true, email: "e@x.gov" }));
    const { reply } = fakeReply();

    await authMiddleware(request, reply);

    expect(request.platformActor?.name).toBe("e@x.gov");
  });
});
