import type { FastifyRequest, FastifyReply } from "fastify";
import { jwtVerify } from "jose";
import { config } from "../config.js";

export interface AuthUser {
  id: string;
  utilityId: string;
  email: string;
  name: string;
  role: string;
  customerId: string | null;
}

/**
 * An identity that belongs to no tenant (tenancy design note Q2).
 *
 * It carries no role, because being the platform actor *is* the
 * authority — platform routes ask "is this the platform actor", not
 * "which permissions does it hold". There is no platform permission
 * matrix until a second class of platform actor exists to need one.
 */
export interface PlatformActor {
  id: string;
  email: string;
  name: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The tenant user. Set on every authenticated tenant request and on
     * no platform request — `utilityId` stays non-nullable because 243
     * sites read it, and the authorization middleware refuses a platform
     * token on a tenant route, so it is only read where it is set.
     */
    user: AuthUser;
    /** The platform actor, set instead of `user` on a platform token. */
    platformActor?: PlatformActor;
  }
}

const NEXTAUTH_SECRET = config.NEXTAUTH_SECRET;
const IS_PROD = config.NODE_ENV === "production";

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

/**
 * Populate exactly one of `request.user` / `request.platformActor`, by
 * what the token declares itself to be.
 *
 * A token says `platform: true` or it names a `utility_id`. Both or
 * neither is refused rather than resolved:
 *
 *   - **Neither** is the shape a truncated or hand-rolled token
 *     produces. Reading an absent `utility_id` as "therefore the
 *     platform" would promote every malformed token to the one identity
 *     that crosses tenants.
 *   - **Both** is ambiguous, and whichever we picked, the token would
 *     carry authority it was not issued.
 *
 * The claim selects which lookup runs; it is not the authority. A
 * platform token is only honoured if `getPlatformActor` finds a real
 * row with `utility_id IS NULL` and `is_active` (see
 * `middleware/authorization.ts`).
 */
function assignIdentity(
  request: FastifyRequest,
  payload: Record<string, unknown>,
): void {
  // Accept both utility_id (JWT convention) and utilityId (NextAuth convention)
  const userId = (payload.sub || payload.id) as string | undefined;
  const utilityId = (payload.utility_id || payload.utilityId) as string | undefined;
  const claimsPlatform = payload.platform === true;

  if (!userId) {
    throw new Error("Missing required token fields");
  }

  if (claimsPlatform) {
    if (utilityId) {
      throw new Error("Token claims both a tenant and the platform");
    }
    request.platformActor = {
      id: userId,
      email: (payload.email as string) ?? "",
      name: (payload.name as string) ?? (payload.email as string) ?? "Unknown",
    };
    return;
  }

  if (!utilityId) {
    throw new Error("Missing required token fields");
  }

  request.user = {
    id: userId,
    utilityId,
    email: (payload.email as string) ?? "",
    name: (payload.name as string) ?? (payload.email as string) ?? "Unknown",
    role: (payload.role as string) ?? "user",
    customerId: (payload.customer_id as string) ?? (payload.customerId as string) ?? null,
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
      assignIdentity(request, payload as Record<string, unknown>);
      return;
    }

    // Dev fallback: either the token is explicitly unsigned (and we're
    // not in prod) or NEXTAUTH_SECRET isn't configured.
    assignIdentity(request, decodeUnsigned(token));
  } catch {
    reply.status(401).send({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }
}
