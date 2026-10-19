import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Rejects a request that has no tenant to act for.
 *
 * It deliberately does NOT establish `app.current_utility_id`. It used to,
 * with a bare session-scoped `set_config`, which could not work: the
 * statement went to whichever pooled connection was free, so the request's
 * own queries often ran on a different one and never saw it, while the
 * value stayed on that connection after the request finished and was
 * inherited by whoever got it next. A per-request setting needs a
 * per-request connection, and middleware has no way to pin one.
 *
 * The setting belongs to a transaction, not to a request: use `withTenant`
 * from lib/prisma.ts, which is what every reader of it already does.
 */
export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Bypass for routes explicitly marked { config: { skipAuth: true } }
  // or for the legacy /health path (kept for compatibility).
  const routeConfig = (request.routeOptions?.config ?? {}) as { skipAuth?: boolean };
  if (routeConfig.skipAuth || request.routeOptions?.url === "/health") {
    return;
  }

  // A platform request has no tenant, by definition — that is what the
  // platform actor is (tenancy design note Q2). This hook runs before
  // authorization, so without the exemption every platform route would
  // answer 400 here and the authorization branch for them would be
  // unreachable. Whether this identity may reach the route it asked for
  // is authorization's question, not this hook's.
  if (request.platformActor) {
    return;
  }

  if (!request.user?.utilityId) {
    reply.status(400).send({
      error: { code: "BAD_REQUEST", message: "No utility context available" },
    });
    return;
  }
}
