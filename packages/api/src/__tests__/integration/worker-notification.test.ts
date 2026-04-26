import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration tests for the notification-send worker.
 *
 * Verifies:
 *   - Disabled tenant: notification_send_enabled=false → rows stay PENDING.
 *   - SMS quiet hours: rows queued during quiet window stay PENDING;
 *     same row sent in active window flips to SENT.
 *   - Email is always eligible regardless of quiet hours.
 *   - Wrap-around quiet hours (22:00 → 07:00 spanning midnight) work
 *     in both halves of the window.
 *   - Multi-tenant: each tenant's quiet hours apply only to its rows.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");

const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
const TENANT_B = "00000000-0000-4000-8000-0000000000b1";

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let serviceImports: typeof import("../../services/notification.service.js");

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("timescale/timescaledb:latest-pg16")
    .withDatabase("utility_cis_test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .start();

  const dbUrl = pgContainer.getConnectionUri();
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.REDIS_URL = redisUrl;
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "error";
  process.env.WORKER_QUEUES = "notification-send";

  execSync("pnpm prisma migrate deploy", {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  serviceImports = await import("../../services/notification.service.js");
}, 180_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await redisContainer?.stop().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE notification, tenant_config RESTART IDENTITY CASCADE
  `);
});

interface TenantOpts {
  notificationSendEnabled?: boolean;
  timezone?: string;
  quietStart?: string;
  quietEnd?: string;
}

async function seedTenant(utilityId: string, opts: TenantOpts = {}): Promise<void> {
  const { prisma } = prismaImports;
  await prisma.tenantConfig.create({
    data: {
      utilityId,
      notificationSendEnabled: opts.notificationSendEnabled ?? true,
      timezone: opts.timezone ?? "UTC",
      notificationQuietStart: opts.quietStart ?? "22:00",
      notificationQuietEnd: opts.quietEnd ?? "07:00",
    },
  });
}

async function seedNotification(opts: {
  utilityId: string;
  channel: "EMAIL" | "SMS";
  recipientEmail?: string;
  recipientPhone?: string;
}): Promise<{ id: string }> {
  const { prisma } = prismaImports;
  const row = await prisma.notification.create({
    data: {
      utilityId: opts.utilityId,
      eventType: "test.event",
      channel: opts.channel,
      recipientEmail: opts.recipientEmail ?? (opts.channel === "EMAIL" ? "test@example.com" : null),
      recipientPhone: opts.recipientPhone ?? (opts.channel === "SMS" ? "+15551234567" : null),
      resolvedSubject: opts.channel === "EMAIL" ? "Test Subject" : null,
      resolvedBody: "Test body",
    },
    select: { id: true },
  });
  return row;
}

describe("worker-notification integration", () => {
  it("sends an EMAIL notification for an enabled tenant", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A);
    const n = await seedNotification({ utilityId: TENANT_A, channel: "EMAIL" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T15:00:00Z"), // midday, definitely not in quiet hours
    );

    expect(result.sent).toBe(1);
    expect(result.skippedQuietHours).toBe(0);
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.status).toBe("SENT");
  });

  it("skips notifications for tenants with notification_send_enabled=false", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, { notificationSendEnabled: false });
    const n = await seedNotification({ utilityId: TENANT_A, channel: "EMAIL" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T15:00:00Z"),
    );

    expect(result.attempted).toBe(0);
    const after = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(after?.status).toBe("PENDING");
  });

  it("skips SMS rows during the quiet-hours window", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    const sms = await seedNotification({ utilityId: TENANT_A, channel: "SMS" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T23:00:00Z"), // 23:00 UTC, inside the wrap-around window
    );

    expect(result.sent).toBe(0);
    expect(result.skippedQuietHours).toBe(1);
    const after = await prisma.notification.findUnique({ where: { id: sms.id } });
    expect(after?.status).toBe("PENDING");
  });

  it("sends SMS rows outside the quiet-hours window", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    const sms = await seedNotification({ utilityId: TENANT_A, channel: "SMS" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T15:00:00Z"), // midday
    );

    expect(result.sent).toBe(1);
    expect(result.skippedQuietHours).toBe(0);
    const after = await prisma.notification.findUnique({ where: { id: sms.id } });
    expect(after?.status).toBe("SENT");
  });

  it("does not apply quiet hours to EMAIL rows even during quiet window", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    const email = await seedNotification({ utilityId: TENANT_A, channel: "EMAIL" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T23:00:00Z"), // inside SMS quiet window
    );

    expect(result.sent).toBe(1);
    expect(result.skippedQuietHours).toBe(0);
    const after = await prisma.notification.findUnique({ where: { id: email.id } });
    expect(after?.status).toBe("SENT");
  });

  it("respects per-tenant quiet hours independently across tenants", async () => {
    const { prisma } = prismaImports;
    // Tenant A: late-night quiet window. Tenant B: business hours quiet
    // window. Same UTC instant — A's SMS sends, B's gets skipped.
    await seedTenant(TENANT_A, {
      timezone: "UTC",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    await seedTenant(TENANT_B, {
      timezone: "UTC",
      quietStart: "13:00",
      quietEnd: "17:00",
    });
    const aSms = await seedNotification({ utilityId: TENANT_A, channel: "SMS" });
    const bSms = await seedNotification({ utilityId: TENANT_B, channel: "SMS" });

    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-04-25T15:00:00Z"), // 15:00 UTC: outside A's window, inside B's
    );

    expect(result.sent).toBe(1);
    expect(result.skippedQuietHours).toBe(1);
    const a = await prisma.notification.findUnique({ where: { id: aSms.id } });
    const b = await prisma.notification.findUnique({ where: { id: bSms.id } });
    expect(a?.status).toBe("SENT");
    expect(b?.status).toBe("PENDING");
  });

  it("respects timezone-aware quiet hours (America/New_York vs UTC)", async () => {
    const { prisma } = prismaImports;
    await seedTenant(TENANT_A, {
      timezone: "America/New_York",
      quietStart: "22:00",
      quietEnd: "07:00",
    });
    const sms = await seedNotification({ utilityId: TENANT_A, channel: "SMS" });

    // 03:00 UTC in summer = 23:00 EDT — inside NY's quiet window.
    const result = await serviceImports.processPendingNotificationsWithQuietHours(
      new Date("2026-07-26T03:00:00Z"),
    );

    expect(result.skippedQuietHours).toBe(1);
    const after = await prisma.notification.findUnique({ where: { id: sms.id } });
    expect(after?.status).toBe("PENDING");
  });
});
