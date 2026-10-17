import { describe, it, expect, afterEach } from "vitest";
import { createTestApp } from "../setup.js";
import { redis } from "../../lib/cache-redis.js";

/**
 * The health endpoint, and the one thing it must never do.
 *
 * It reports the cache's connection state because that state is
 * otherwise invisible: a client stuck off `ready` answers nothing, every
 * request quietly falls through to the database, and the only symptom is
 * that the application feels slow. Reading it off `/health` is the
 * difference between knowing to restart the API and guessing.
 *
 * And it must stay 200 while that is true. This app serves every request
 * correctly without Redis — the cache is an optimisation, by design — so
 * a probe that failed on a cache outage would have a deploy kill a
 * process that is working perfectly.
 */

const mockRedis = redis as unknown as { status: string };

afterEach(() => {
  mockRedis.status = "ready";
});

describe("GET /health", () => {
  it("returns 200 ok without auth, and says the cache is ready", async () => {
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok", cache: "ready" });
  });

  it("still answers 200 when the cache is down, and names the state", async () => {
    mockRedis.status = "reconnecting";
    const app = await createTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });

    // 200, deliberately: failing here would take a working API out of
    // service for the loss of an optimisation.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: "ok", cache: "reconnecting" });
  });
});
