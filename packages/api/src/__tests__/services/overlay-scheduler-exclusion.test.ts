import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { tenantsForScheduler } from "../../services/automation-config.service.js";

/**
 * An overlay tenant is excluded from the scheduled work its legacy CIS
 * owns (spec 28, OVL-T-2).
 *
 * The request-level refusal is only half a gate. Nobody presses a
 * button for a billing run on a bill day — the dispatcher reaches it on
 * a schedule — so an overlay tenant with a cycle configured and a
 * worker attached would be billed by the system entirely unprompted,
 * for a period its legacy CIS has already billed.
 *
 * `tenantsForScheduler` is where this belongs because it is the one
 * place every scheduled dispatcher selects tenants: one flag per
 * scheduler in `SCHEDULER_DEFINITIONS`, enforced once, covers the whole
 * scheduled surface. It already filtered `status: "ACTIVE"` for the
 * same reason.
 */

const FULL = "00000000-0000-4000-8000-00000000f011";
const OVERLAY = "00000000-0000-4000-8000-0000000000v1".replace("v", "a");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.utilityConfig.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.schedulerConfig.findMany).mockResolvedValue([] as never);
});

function utilities(rows: Array<{ id: string; operatingMode: string }>) {
  vi.mocked(prisma.utility.findMany).mockResolvedValue(rows as never);
  /*
   * Enable the scheduler for every tenant, so enablement is not the
   * variable under test. `billing` and `delinquency` default to
   * disabled — new schedulers are opt-in — and without this the
   * assertion would pass or fail for the wrong reason.
   */
  vi.mocked(prisma.schedulerConfig.findMany).mockResolvedValue(
    rows.map((r) => ({
      utilityId: r.id,
      enabled: true,
      runHourLocal: 3,
      lastRunAt: null,
    })) as never,
  );
}

describe("tenantsForScheduler and overlay tenants", () => {
  it("leaves an overlay tenant out of billing", async () => {
    utilities([
      { id: FULL, operatingMode: "FULL" },
      { id: OVERLAY, operatingMode: "OVERLAY" },
    ]);
    const tenants = await tenantsForScheduler("billing");
    expect(tenants.map((t) => t.utilityId)).toEqual([FULL]);
  });

  it("leaves it out of delinquency and customer notifications too", async () => {
    utilities([
      { id: FULL, operatingMode: "FULL" },
      { id: OVERLAY, operatingMode: "OVERLAY" },
    ]);
    for (const key of ["delinquency", "notificationSend"] as const) {
      const tenants = await tenantsForScheduler(key);
      expect(tenants.map((t) => t.utilityId), key).toEqual([FULL]);
    }
  });

  it("still includes it in the jobs that carry no money and send nothing", async () => {
    /*
     * A judgement, not an omission: a service hold transitioning is a
     * state change with no outward effect, and service requests are
     * ours in either mode — spec 28 §6 builds workflows on them.
     */
    utilities([
      { id: FULL, operatingMode: "FULL" },
      { id: OVERLAY, operatingMode: "OVERLAY" },
    ]);
    for (const key of ["suspension", "slaBreachSweep"] as const) {
      const tenants = await tenantsForScheduler(key);
      expect(tenants.map((t) => t.utilityId).sort(), key).toEqual([FULL, OVERLAY].sort());
    }
  });

  it("asks the database only for what it needs, including the mode", async () => {
    utilities([{ id: FULL, operatingMode: "FULL" }]);
    await tenantsForScheduler("billing");
    const call = vi.mocked(prisma.utility.findMany).mock.calls[0][0] as {
      select: Record<string, boolean>;
    };
    expect(call.select).toMatchObject({ id: true, operatingMode: true });
  });
});
