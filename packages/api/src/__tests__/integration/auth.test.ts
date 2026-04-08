import { describe, it, expect } from "vitest";
import { createTestApp } from "../setup.js";

describe("Auth middleware", () => {
  it("returns 401 without auth header", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/commodities" });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/commodities",
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with malformed Bearer token (missing payload)", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/commodities",
      headers: { authorization: "Bearer only-one-part" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 with token missing required fields", async () => {
    const app = await createTestApp();
    // Token with no sub or utility_id
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ email: "x@x.com" })).toString("base64url");
    const token = `${header}.${body}.sig`;
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/commodities",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
