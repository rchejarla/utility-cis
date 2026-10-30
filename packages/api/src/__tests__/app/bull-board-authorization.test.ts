import { describe, it, expect, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { createTestToken, createPlatformToken } from "../setup.js";

/**
 * The queue UI stops borrowing a tenant permission.
 *
 * D4, and §1.6's concrete case: `app.ts` mounted Bull Board behind a
 * `preHandler` requiring `tenant_profile:EDIT`, over `ALL_QUEUE_NAMES`,
 * which are **not** tenant-scoped. Job payloads carry utilityIds,
 * account ids, run ids and file names, so one tenant's admin could
 * inspect — and with Bull Board's default controls retry or remove —
 * another tenant's jobs.
 *
 * It borrowed that permission because no better one existed: "a tenant
 * permission was all the model offered". The model offers the right one
 * now.
 *
 * `BULL_BOARD_ENABLED` is read once at import, so opening it means
 * stubbing the variable and re-importing the module graph — which also
 * hands back a fresh `lib/prisma.js` mock, so the mock a test configures
 * has to be the one the rebuilt app is wired to.
 */

const PLATFORM_ID = "test-platform-001";

const platformHeaders = { authorization: `Bearer ${createPlatformToken({ sub: PLATFORM_ID })}` };
const tenantHeaders = { authorization: `Bearer ${createTestToken()}` };

async function appWithBullBoard(permissions: Record<string, string[]>) {
  vi.resetModules();
  vi.stubEnv("BULL_BOARD_ENABLED", "true");
  const { prisma } = await import("../../lib/prisma.js");
  const { buildApp } = await import("../../app.js");

  (prisma.cisUser.findFirst as Mock).mockImplementation(
    (args: { where: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (where.utilityId === null) {
        if (where.isActive !== true || where.id !== PLATFORM_ID) return Promise.resolve(null);
        return Promise.resolve({
          id: PLATFORM_ID,
          email: "platform@utility.com",
          name: "Platform Operator",
        });
      }
      return Promise.resolve({
        id: "test-user-001",
        utilityId: "test-utility-001",
        email: "test@example.com",
        name: "Test User",
        customerId: null,
        isActive: true,
      });
    },
  );
  (prisma.utilityModule.findMany as Mock).mockResolvedValue(
    Object.keys(permissions).map((moduleKey) => ({ moduleKey })),
  );
  (prisma.utility.findUnique as Mock).mockResolvedValue({ status: "ACTIVE" });
  (prisma.userRole.findFirst as Mock).mockResolvedValue({
    roleId: "role-admin",
    role: { id: "role-admin", name: "Utility Admin", permissions },
  });

  return await buildApp();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/*
 * Each case builds a whole Fastify app with Bull Board mounted, which on
 * a loaded machine runs 4–5s against vitest's 5s default — so these
 * passed alone and timed out inside the full suite, reporting "Test
 * timed out" and nothing about authorization. 20s is headroom, not a
 * long-running test: if one of these ever genuinely hangs it still
 * fails, just slower.
 */
describe("/admin/queues", { timeout: 20_000 }, () => {
  it("refuses a tenant admin holding tenant_profile:EDIT", async () => {
    // The exact grant that used to be sufficient.
    const app = await appWithBullBoard({ tenant_profile: ["VIEW", "EDIT"] });
    const res = await app.inject({ method: "GET", url: "/admin/queues", headers: tenantHeaders });

    expect(res.statusCode).toBe(403);
  });

  it("refuses a tenant admin holding every tenant permission", async () => {
    const app = await appWithBullBoard({
      tenant_profile: ["VIEW", "CREATE", "EDIT", "DELETE"],
      settings: ["VIEW", "CREATE", "EDIT", "DELETE"],
    });
    const res = await app.inject({ method: "GET", url: "/admin/queues", headers: tenantHeaders });

    expect(res.statusCode).toBe(403);
  });

  it("does not refuse the platform actor", async () => {
    // Asserted as "not 403" rather than "200": what is under test is the
    // gate, and Bull Board's own handler needs a live Redis to render.
    const app = await appWithBullBoard({ tenant_profile: ["VIEW", "EDIT"] });
    const res = await app.inject({ method: "GET", url: "/admin/queues", headers: platformHeaders });

    expect(res.statusCode).not.toBe(403);
  });
});
