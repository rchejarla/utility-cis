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
  // Create a fake JWT (header.payload.signature)
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

export async function createTestApp() {
  const app = await buildApp();
  return app;
}
