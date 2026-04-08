import { describe, it, expect } from "vitest";
import { createTestApp } from "../setup.js";

describe("GET /health", () => {
  it("returns 200 ok without auth", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok" });
  });
});
