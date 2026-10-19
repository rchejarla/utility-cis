import { buildApp } from "../app.js";

// Helper to create a JWT-like token for testing
export function createTestToken(
  overrides?: Partial<{
    sub: string;
    utility_id: string;
    email: string;
    // Absent by default, which is deliberate: `auth.ts:77` falls back to
    // the email and then to "Unknown", so a token without this claim
    // still yields a usable actor name. Tests asserting on audit
    // attribution set it to something distinctive.
    name: string;
    role: string;
  }>
) {
  const payload = {
    sub: "test-user-001",
    utility_id: "test-utility-001",
    email: "test@example.com",
    role: "admin",
    ...overrides,
  };
  return createTokenFromClaims(payload);
}

/**
 * A token carrying no tenant — the platform actor's shape.
 *
 * Q2: the platform identity is a `CisUser` with a null `utility_id`, so
 * its token has no `utility_id` claim and says `platform: true` instead.
 * The claim only selects which lookup authorization runs; the authority
 * is the database row (`utility_id IS NULL`, active).
 */
export function createPlatformToken(
  overrides?: Partial<{ sub: string; email: string; name: string }>,
) {
  return createTokenFromClaims({
    sub: "test-platform-001",
    platform: true,
    email: "platform@example.com",
    ...overrides,
  });
}

/**
 * Build a token from exactly these claims and nothing else — for the
 * shapes a well-behaved client never sends, which are the ones the
 * middleware has to refuse.
 */
export function createTokenFromClaims(payload: Record<string, unknown>) {
  // A fake JWT (header.payload.signature). `alg: "none"` is how the web
  // client marks a dev token; production rejects unsigned tokens.
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

export async function createTestApp() {
  const app = await buildApp();
  return app;
}
