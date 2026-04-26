import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSchedulerEnabled,
  isInQuietHours,
  priorityForTenant,
  patchAutomationConfig,
} from "../../services/automation-config.service.js";
import { prisma } from "../../lib/prisma.js";
import type { AutomationConfig } from "@utility-cis/shared";

/**
 * Unit tests for the automation config service. The DB-touching
 * helpers (`getAutomationConfig`, `patchAutomationConfig`) talk
 * through the Prisma mock from vitest.setup.ts. Pure helpers
 * (`isSchedulerEnabled`, `isInQuietHours`, `priorityForTenant`) get
 * direct unit coverage.
 *
 * IANA validation in `patchAutomationConfig` is explicitly tested
 * with both a valid zone (passes) and an invalid one (throws). The
 * deeper tz math is covered by `iana-tz.test.ts`; this suite just
 * verifies the service-layer guard is wired in.
 */

function fixture(overrides: Partial<AutomationConfig> = {}): AutomationConfig {
  return {
    timezone: "UTC",
    suspensionEnabled: true,
    notificationSendEnabled: true,
    slaBreachSweepEnabled: true,
    delinquencyEnabled: true,
    delinquencyRunHourLocal: 3,
    delinquencyLastRunAt: null,
    notificationQuietStart: "22:00",
    notificationQuietEnd: "07:00",
    schedulerAuditRetentionDays: 365,
    ...overrides,
  };
}

describe("isSchedulerEnabled", () => {
  it("returns the per-scheduler boolean for each key", () => {
    const cfg = fixture({
      suspensionEnabled: true,
      notificationSendEnabled: false,
      slaBreachSweepEnabled: true,
      delinquencyEnabled: false,
    });
    expect(isSchedulerEnabled(cfg, "suspension")).toBe(true);
    expect(isSchedulerEnabled(cfg, "notificationSend")).toBe(false);
    expect(isSchedulerEnabled(cfg, "slaBreachSweep")).toBe(true);
    expect(isSchedulerEnabled(cfg, "delinquency")).toBe(false);
  });
});

describe("isInQuietHours", () => {
  it("returns false when start equals end (disabled-quiet-hours convention)", () => {
    const cfg = fixture({
      notificationQuietStart: "00:00",
      notificationQuietEnd: "00:00",
    });
    // Doesn't matter what time it is — the window is empty.
    expect(isInQuietHours(new Date("2026-04-25T03:00:00Z"), cfg)).toBe(false);
    expect(isInQuietHours(new Date("2026-04-25T15:00:00Z"), cfg)).toBe(false);
  });

  describe("same-day window (start < end)", () => {
    const cfg = fixture({
      timezone: "UTC",
      notificationQuietStart: "13:00",
      notificationQuietEnd: "17:00",
    });

    it("inside window → quiet", () => {
      expect(isInQuietHours(new Date("2026-04-25T14:30:00Z"), cfg)).toBe(true);
      expect(isInQuietHours(new Date("2026-04-25T13:00:00Z"), cfg)).toBe(true); // inclusive start
    });

    it("at end boundary → not quiet (exclusive end)", () => {
      expect(isInQuietHours(new Date("2026-04-25T17:00:00Z"), cfg)).toBe(false);
    });

    it("outside window → not quiet", () => {
      expect(isInQuietHours(new Date("2026-04-25T08:00:00Z"), cfg)).toBe(false);
      expect(isInQuietHours(new Date("2026-04-25T20:00:00Z"), cfg)).toBe(false);
    });
  });

  describe("wrap-around window (start > end, e.g., 22:00 → 07:00)", () => {
    const cfg = fixture({
      timezone: "UTC",
      notificationQuietStart: "22:00",
      notificationQuietEnd: "07:00",
    });

    it("late night (after start) → quiet", () => {
      expect(isInQuietHours(new Date("2026-04-25T22:30:00Z"), cfg)).toBe(true);
      expect(isInQuietHours(new Date("2026-04-25T23:59:00Z"), cfg)).toBe(true);
    });

    it("early morning (before end) → quiet", () => {
      expect(isInQuietHours(new Date("2026-04-26T03:00:00Z"), cfg)).toBe(true);
      expect(isInQuietHours(new Date("2026-04-26T06:59:00Z"), cfg)).toBe(true);
    });

    it("at start boundary (22:00) → quiet (inclusive)", () => {
      expect(isInQuietHours(new Date("2026-04-25T22:00:00Z"), cfg)).toBe(true);
    });

    it("at end boundary (07:00) → not quiet (exclusive)", () => {
      expect(isInQuietHours(new Date("2026-04-26T07:00:00Z"), cfg)).toBe(false);
    });

    it("midday → not quiet", () => {
      expect(isInQuietHours(new Date("2026-04-25T15:00:00Z"), cfg)).toBe(false);
    });
  });

  describe("timezone-aware (tenant-local matters, not UTC)", () => {
    const cfg = fixture({
      timezone: "America/New_York", // EDT in summer = UTC-4
      notificationQuietStart: "22:00",
      notificationQuietEnd: "07:00",
    });

    it("01:00 UTC in summer = 21:00 NY = NOT quiet (still 1 hour before window)", () => {
      // 2026-07-26T01:00:00Z = 2026-07-25 21:00 EDT
      expect(isInQuietHours(new Date("2026-07-26T01:00:00Z"), cfg)).toBe(false);
    });

    it("03:00 UTC in summer = 23:00 NY = quiet", () => {
      // 2026-07-26T03:00:00Z = 2026-07-25 23:00 EDT
      expect(isInQuietHours(new Date("2026-07-26T03:00:00Z"), cfg)).toBe(true);
    });

    it("15:00 UTC in summer = 11:00 NY = NOT quiet (midday local)", () => {
      expect(isInQuietHours(new Date("2026-07-25T15:00:00Z"), cfg)).toBe(false);
    });
  });
});

describe("priorityForTenant", () => {
  it("< 1000 accounts → priority 1 (highest, processed first)", () => {
    expect(priorityForTenant(0)).toBe(1);
    expect(priorityForTenant(999)).toBe(1);
  });

  it("1000-9999 accounts → priority 2", () => {
    expect(priorityForTenant(1000)).toBe(2);
    expect(priorityForTenant(5000)).toBe(2);
    expect(priorityForTenant(9999)).toBe(2);
  });

  it(">= 10000 accounts → priority 3 (large; processed last)", () => {
    expect(priorityForTenant(10_000)).toBe(3);
    expect(priorityForTenant(50_000)).toBe(3);
    expect(priorityForTenant(1_000_000)).toBe(3);
  });
});

describe("patchAutomationConfig — IANA validation guard", () => {
  beforeEach(() => {
    (prisma.tenantConfig.upsert as ReturnType<typeof vi.fn>).mockReset();
  });

  it("rejects an invalid IANA timezone before touching the DB", async () => {
    await expect(
      patchAutomationConfig("11111111-1111-4111-8111-111111111111", {
        timezone: "America/atlantis",
      }),
    ).rejects.toThrow(/Invalid IANA timezone/);

    expect(prisma.tenantConfig.upsert).not.toHaveBeenCalled();
  });

  it("accepts a valid IANA zone and forwards the patch to upsert", async () => {
    (prisma.tenantConfig.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      timezone: "America/Los_Angeles",
      suspensionEnabled: true,
      notificationSendEnabled: true,
      slaBreachSweepEnabled: true,
      delinquencyEnabled: true,
      delinquencyRunHourLocal: 3,
      delinquencyLastRunAt: null,
      notificationQuietStart: "22:00",
      notificationQuietEnd: "07:00",
      schedulerAuditRetentionDays: 365,
    });

    const result = await patchAutomationConfig(
      "11111111-1111-4111-8111-111111111111",
      { timezone: "America/Los_Angeles" },
    );

    expect(result.timezone).toBe("America/Los_Angeles");
    expect(prisma.tenantConfig.upsert).toHaveBeenCalledTimes(1);
  });
});
