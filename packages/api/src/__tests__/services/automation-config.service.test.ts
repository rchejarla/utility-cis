import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isSchedulerEnabled,
  isInQuietHours,
  priorityForTenant,
  patchAutomationConfig,
} from "../../services/automation-config.service.js";
import { prisma } from "../../lib/prisma.js";
import {
  type AutomationConfig,
  type SchedulerKey,
  SCHEDULER_DEFINITIONS,
} from "@utility-cis/shared";

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

/**
 * Per-scheduler settings are a list since 2026-10-31, one entry per
 * catalogue key, rather than a column group per job on the config
 * object. `enabled` here lets a case name only the jobs it cares about.
 */
function fixture(
  overrides: Partial<Omit<AutomationConfig, "schedulers">> & {
    enabled?: Partial<Record<SchedulerKey, boolean>>;
    runHourLocal?: Partial<Record<SchedulerKey, number>>;
  } = {},
): AutomationConfig {
  const { enabled = {}, runHourLocal = {}, ...rest } = overrides;
  return {
    timezone: "UTC",
    notificationQuietStart: "22:00",
    notificationQuietEnd: "07:00",
    schedulerAuditRetentionDays: 365,
    autoPostBills: true,
    schedulers: SCHEDULER_DEFINITIONS.map((def) => ({
      key: def.key,
      enabled: enabled[def.key] ?? def.defaultEnabled,
      runHourLocal: def.hasRunHour ? (runHourLocal[def.key] ?? 3) : null,
      lastRunAt: null,
      settings: {},
    })),
    ...rest,
  };
}

/** The tenant-wide columns, as `utility_config` now holds them. */
function tenantRow(over: Record<string, unknown> = {}) {
  return {
    timezone: "UTC",
    notificationQuietStart: "22:00",
    notificationQuietEnd: "07:00",
    schedulerAuditRetentionDays: 365,
    autoPostBills: true,
    ...over,
  };
}

describe("isSchedulerEnabled", () => {
  it("returns the per-scheduler boolean for each key", () => {
    const cfg = fixture({
      enabled: {
        suspension: true,
        notificationSend: false,
        slaBreachSweep: true,
        delinquency: false,
      },
    });
    expect(isSchedulerEnabled(cfg, "suspension")).toBe(true);
    expect(isSchedulerEnabled(cfg, "notificationSend")).toBe(false);
    expect(isSchedulerEnabled(cfg, "slaBreachSweep")).toBe(true);
    expect(isSchedulerEnabled(cfg, "delinquency")).toBe(false);
  });

  it("falls back to the catalogue default for a scheduler with no entry", () => {
    /*
     * A tenant has no row until they save one, so a missing entry is
     * the ordinary case rather than an error — and billing's default is
     * off, which is what keeps automation nobody asked for from
     * charging their customers.
     */
    const cfg = { ...fixture(), schedulers: [] };

    expect(isSchedulerEnabled(cfg, "billing")).toBe(false);
    expect(isSchedulerEnabled(cfg, "suspension")).toBe(true);
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
    (prisma.utilityConfig.upsert as ReturnType<typeof vi.fn>).mockReset();
    /*
     * A patched tenant has a config row, so the re-read at the end of
     * the patch finds one rather than lazily creating it. Without this
     * the read's own upsert counts against the patch's, which is the
     * mock's shape rather than the service's behaviour.
     */
    (prisma.utilityConfig.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(tenantRow());
    (prisma.schedulerConfig.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("rejects an invalid IANA timezone before touching the DB", async () => {
    await expect(
      patchAutomationConfig("11111111-1111-4111-8111-111111111111", {
        timezone: "America/atlantis",
      }),
    ).rejects.toThrow(/Invalid IANA timezone/);

    expect(prisma.utilityConfig.upsert).not.toHaveBeenCalled();
  });

  it("accepts a valid IANA zone and forwards the patch to upsert", async () => {
    (prisma.utilityConfig.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      tenantRow({ timezone: "America/Los_Angeles" }),
    );

    const result = await patchAutomationConfig(
      "11111111-1111-4111-8111-111111111111",
      { timezone: "America/Los_Angeles" },
    );

    expect(result.timezone).toBe("America/Los_Angeles");
    expect(prisma.utilityConfig.upsert).toHaveBeenCalledTimes(1);
  });

  it("writes one scheduler row per job listed, and none for the rest", async () => {
    /*
     * The reason the table exists. Changing billing's hour writes one
     * row; the four jobs nobody mentioned keep inheriting their
     * catalogue default rather than acquiring rows that say the same
     * thing.
     */
    const schedulerUpsert = prisma.schedulerConfig.upsert as ReturnType<typeof vi.fn>;
    schedulerUpsert.mockReset();

    await patchAutomationConfig("11111111-1111-4111-8111-111111111111", {
      schedulers: [{ key: "billing", enabled: true, runHourLocal: 5 }],
    });

    expect(schedulerUpsert).toHaveBeenCalledTimes(1);
    expect(schedulerUpsert.mock.calls[0][0].update).toMatchObject({
      enabled: true,
      runHourLocal: 5,
    });
    // Nothing tenant-wide changed, so nothing tenant-wide was written.
    expect(prisma.utilityConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses to store an hour for a job that has no time of day", async () => {
    // An hour on the suspension sweep would be a value nothing reads,
    // and the next person to see it would reasonably think it mattered.
    const schedulerUpsert = prisma.schedulerConfig.upsert as ReturnType<typeof vi.fn>;
    schedulerUpsert.mockReset();

    await patchAutomationConfig("11111111-1111-4111-8111-111111111111", {
      schedulers: [{ key: "suspension", runHourLocal: 7 }],
    });

    expect(schedulerUpsert.mock.calls[0][0].update).toMatchObject({ runHourLocal: null });
  });
});
