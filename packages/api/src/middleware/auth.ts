import type { FastifyRequest, FastifyReply } from "fastify";

export interface AuthUser {
  id: string;
  utilityId: string;
  email: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Bypass auth for health check
  if (request.routeOptions?.url === "/health") {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Missing or invalid token" },
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    // Decode JWT payload (base64) for dev — no signature verification
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token format");
    }

    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
    const payload = JSON.parse(payloadJson) as {
      sub?: string;
      utility_id?: string;
      email?: string;
      role?: string;
    };

    if (!payload.sub || !payload.utility_id) {
      throw new Error("Missing required token fields");
    }

    request.user = {
      id: payload.sub,
      utilityId: payload.utility_id,
      email: payload.email ?? "",
      role: payload.role ?? "user",
    };
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }
}
