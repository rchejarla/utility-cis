import type { FastifyRequest, FastifyReply } from "fastify";
import { jwtVerify } from "jose";

export interface AuthUser {
  id: string;
  utilityId: string;
  email: string;
  name: string;
  role: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Bypass auth when a route is explicitly marked { config: { skipAuth: true } }.
  // /health and /api/v1/openapi.json are the two public routes today; adding
  // more only requires setting skipAuth on the route options.
  const routeConfig = (request.routeOptions?.config ?? {}) as { skipAuth?: boolean };
  if (routeConfig.skipAuth || request.routeOptions?.url === "/health") {
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
    if (NEXTAUTH_SECRET) {
      // Production: verify JWT signature using NEXTAUTH_SECRET
      const secret = new TextEncoder().encode(NEXTAUTH_SECRET);
      const { payload } = await jwtVerify(token, secret);

      const userId = (payload.sub || (payload as Record<string, unknown>).id) as string | undefined;
      const utilityId = (
        (payload as Record<string, unknown>).utility_id ||
        (payload as Record<string, unknown>).utilityId
      ) as string | undefined;

      if (!userId || !utilityId) {
        throw new Error("Missing required token fields");
      }

      request.user = {
        id: userId,
        utilityId,
        email: (payload.email as string) ?? "",
        name: ((payload as Record<string, unknown>).name as string) ?? (payload.email as string) ?? "Unknown",
        role: ((payload as Record<string, unknown>).role as string) ?? "user",
      };
    } else {
      // Dev mode fallback: decode without verification (only when NEXTAUTH_SECRET not set)
      let payload: Record<string, unknown>;

      // Try JSON parse first (NextAuth sends token object via JSON.stringify)
      try {
        payload = JSON.parse(token);
      } catch {
        // Fall back to JWT base64 decode
        const parts = token.split(".");
        if (parts.length !== 3) {
          throw new Error("Invalid token format");
        }
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
        payload = JSON.parse(payloadJson);
      }

      // Accept both utility_id (JWT convention) and utilityId (NextAuth convention)
      const userId = (payload.sub || payload.id) as string | undefined;
      const utilityId = (payload.utility_id || payload.utilityId) as string | undefined;

      if (!userId || !utilityId) {
        throw new Error("Missing required token fields");
      }

      request.user = {
        id: userId,
        utilityId,
        email: (payload.email as string) ?? "",
        name: (payload.name as string) ?? (payload.email as string) ?? "Unknown",
        role: (payload.role as string) ?? "user",
      };
    }
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }
}
