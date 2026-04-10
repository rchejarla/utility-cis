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
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Decode a JWT or a JSON blob without verifying the signature. Used for
 * the dev fallback path; never touched in production.
 */
function decodeUnsigned(token: string): Record<string, unknown> {
  // NextAuth sometimes serializes a plain JSON blob rather than a JWT;
  // try that shape first before falling back to base64 segment decoding.
  try {
    return JSON.parse(token) as Record<string, unknown>;
  } catch {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token format");
    }
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payloadJson) as Record<string, unknown>;
  }
}

/**
 * Pull the `alg` claim out of a JWT's header segment without verifying
 * anything. A value of "none" is how the web client signals that this
 * is a dev token and the API should bypass signature verification.
 * Returns null if the token doesn't have a parseable JWT header.
 */
function peekAlg(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf-8"),
    ) as { alg?: string };
    return header.alg ?? null;
  } catch {
    return null;
  }
}

function assignUser(
  request: FastifyRequest,
  payload: Record<string, unknown>,
): void {
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
    // Dev tokens declare `alg: "none"` in the header. Accept them without
    // signature verification in non-prod environments regardless of
    // whether NEXTAUTH_SECRET is set — dev ergonomics shouldn't depend on
    // whether the secret happens to be loaded. Production always rejects
    // unsigned tokens.
    const alg = peekAlg(token);
    const isUnsigned = alg === "none";

    if (isUnsigned && IS_PROD) {
      throw new Error("Unsigned tokens are not permitted in production");
    }

    if (!isUnsigned && NEXTAUTH_SECRET) {
      // Verified path: signed token + secret available.
      const secret = new TextEncoder().encode(NEXTAUTH_SECRET);
      const { payload } = await jwtVerify(token, secret);
      assignUser(request, payload as Record<string, unknown>);
      return;
    }

    // Dev fallback: either the token is explicitly unsigned (and we're
    // not in prod) or NEXTAUTH_SECRET isn't configured.
    assignUser(request, decodeUnsigned(token));
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }
}
