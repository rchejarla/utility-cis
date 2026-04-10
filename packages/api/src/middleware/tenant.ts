import type { FastifyRequest, FastifyReply } from "fastify";
import { setTenantContext } from "../lib/prisma.js";

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

  if (!request.user?.utilityId) {
    reply.status(400).send({
      error: { code: "BAD_REQUEST", message: "No utility context available" },
    });
    return;
  }

  await setTenantContext(request.user.utilityId);
}
