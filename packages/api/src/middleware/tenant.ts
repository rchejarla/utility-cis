import type { FastifyRequest, FastifyReply } from "fastify";
import { setTenantContext } from "../lib/prisma.js";

export async function tenantMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Bypass for health check (user may not be set)
  if (request.routeOptions?.url === "/health") {
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
