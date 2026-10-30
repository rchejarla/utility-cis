import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Which crons are armed in Redis that this build does not know about.
 *
 * Boot used to *delete* them, and that is wrong the moment there are two
 * builds: a node coming up during a rolling deploy deletes the cron the
 * newer node just armed, and since registration happens only at boot it
 * stays gone until something restarts. It logged the deletion at info,
 * which reads like housekeeping succeeding.
 *
 * So boot reports and removal is deliberate. The failure that remains is
 * the opposite one and far cheaper: a cron removed in code keeps firing
 * until an operator takes it out, which is a job nothing handles rather
 * than a month that does not bill.
 *
 * `docs/specs/27-job-scheduling.md` SCH-NODE-1.
 */

/** What each queue reports as armed, keyed by queue name. */
const armed: Record<string, { key?: string; name?: string; pattern?: string | null }[]> = {};
const removed: { queue: string; key: string }[] = [];
/** Set to make one queue refuse to list, as a Redis without the data does. */
let listFails: string | null = null;

vi.mock("../../lib/queues.js", () => ({
  ALL_QUEUE_NAMES: ["suspension-transitions", "billing-runs"],
  getQueue: vi.fn((name: string) => ({
    getJobSchedulers: vi.fn(async () => {
      if (listFails === name) throw new Error("ERR unknown command");
      return armed[name] ?? [];
    }),
    removeJobScheduler: vi.fn(async (key: string) => {
      removed.push({ queue: name, key });
      return true;
    }),
  })),
}));

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let lib: typeof import("../../lib/schedulers.js");
let logger: { warn: ReturnType<typeof vi.fn> };

/** A build that knows one cron. */
const REGISTRY = new Set(["suspension-cron"]);

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(armed)) delete armed[key];
  removed.length = 0;
  listFails = null;
  lib = await import("../../lib/schedulers.js");
  logger = (await import("../../lib/logger.js")).logger as never;
});

describe("finding orphaned schedulers", () => {
  it("reports one this build does not know, and removes nothing", async () => {
    // The rolling-deploy case: the newer node armed `billing-dispatch-cron`
    // moments ago and this older build has never heard of it.
    armed["billing-runs"] = [{ key: "billing-dispatch-cron", name: "dispatch", pattern: "0 * * * *" }];

    const orphans = await lib.findOrphanedSchedulers(
      ["suspension-transitions", "billing-runs"],
      REGISTRY,
    );

    expect(orphans).toEqual([
      expect.objectContaining({ queue: "billing-runs", schedulerId: "billing-dispatch-cron" }),
    ]);
    expect(removed).toEqual([]);
  });

  it("warns rather than informs, since nobody goes looking at info", async () => {
    armed["billing-runs"] = [{ key: "billing-dispatch-cron" }];

    await lib.findOrphanedSchedulers(["billing-runs"], REGISTRY);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ schedulerId: "billing-dispatch-cron" }),
      expect.stringContaining("this build does not know"),
    );
  });

  it("says nothing about a scheduler this build registers", async () => {
    armed["suspension-transitions"] = [{ key: "suspension-cron", pattern: "0 * * * *" }];

    expect(await lib.findOrphanedSchedulers(["suspension-transitions"], REGISTRY)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("looks only at the queues this process serves", async () => {
    // WORKER_QUEUES can name a subset. A queue nobody here is attached to
    // is not this process's to judge.
    armed["billing-runs"] = [{ key: "billing-dispatch-cron" }];

    expect(await lib.findOrphanedSchedulers(["suspension-transitions"], REGISTRY)).toEqual([]);
  });

  it("keeps going when one queue cannot be listed", async () => {
    listFails = "suspension-transitions";
    armed["billing-runs"] = [{ key: "billing-dispatch-cron" }];

    const orphans = await lib.findOrphanedSchedulers(
      ["suspension-transitions", "billing-runs"],
      REGISTRY,
    );

    expect(orphans).toHaveLength(1);
  });

  it("ignores a record with no id, which is nothing it can act on", async () => {
    armed["billing-runs"] = [{ name: "nameless" }];

    expect(await lib.findOrphanedSchedulers(["billing-runs"], REGISTRY)).toEqual([]);
  });
});

describe("removing a scheduler deliberately", () => {
  it("removes an orphan when an operator asks", async () => {
    await lib.removeScheduler("billing-runs", "billing-dispatch-cron", REGISTRY);

    expect(removed).toEqual([{ queue: "billing-runs", key: "billing-dispatch-cron" }]);
  });

  it("refuses one this build still registers", async () => {
    /*
     * The inverse guard, and the reason removal takes the registry at
     * all. Boot can no longer delete a live cron by accident; a hand
     * doing it on purpose would be the same outage, and this is the only
     * place left that could.
     */
    await expect(
      lib.removeScheduler("suspension-transitions", "suspension-cron", REGISTRY),
    ).rejects.toMatchObject({ code: "SCHEDULER_IS_REGISTERED" });

    expect(removed).toEqual([]);
  });
});
