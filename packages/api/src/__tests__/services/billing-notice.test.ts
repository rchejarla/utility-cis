import { describe, it, expect } from "vitest";
import {
  windowKey,
  newNotices,
  prunedNotices,
  NOTICE_RETENTION_DAYS,
} from "../../services/billing-notice.service.js";

/**
 * Telling the tenant that billing did not happen (SCH-BILL-11).
 *
 * "A silent failure to bill is the most expensive silence in the
 * product" — so the thing that matters most here is that the notice is
 * sent *once per window*, not once per hourly tick. A notice that
 * arrives every hour for a month is one an operator mutes, which leaves
 * exactly the silence this requirement exists to remove.
 *
 * The ledger of what has already been said lives in the billing
 * scheduler's own `scheduler_config.settings` jsonb — the storage rule's
 * case for a knob only one scheduler needs, and the only home that works
 * whether or not the tenant has an active template. Keeping it in the
 * `notification` table instead would record nothing for a tenant with no
 * template, which is precisely the tenant that would then be told
 * hourly.
 */

const WINDOW = "2026-11-10";

describe("the key a notice is remembered under", () => {
  it("names the cycle and the window, since a cycle is told once per window", () => {
    expect(windowKey("c1", WINDOW)).toBe("c1:2026-11-10");
  });

  it("takes the date off an instant, so two ticks in a day agree", () => {
    // The dispatcher fires hourly and the window end is a date. Keying
    // on the instant would make every tick a new key, which is the bug
    // this whole ledger exists to avoid.
    expect(windowKey("c1", new Date("2026-11-10T13:00:00.000Z"))).toBe("c1:2026-11-10");
  });
});

describe("which refusals have not been reported yet", () => {
  const refusal = (cycleId: string) => ({
    billingCycleId: cycleId,
    cycleCode: "R01",
    windowEnd: WINDOW,
    reason: "readsIncomplete" as const,
    detail: "No meter read in 2026-10-11..2026-11-10",
  });

  it("reports one the ledger has never seen", () => {
    expect(newNotices([refusal("c1")], {})).toEqual([refusal("c1")]);
  });

  it("stays silent on one already reported, however many ticks later", () => {
    const told = { "c1:2026-11-10": "2026-11-10T04:00:00.000Z" };
    expect(newNotices([refusal("c1")], told)).toEqual([]);
  });

  it("reports the next window even though the last one was reported", () => {
    /*
     * The failure mode worth guarding: a cycle that could not bill in
     * November and cannot bill in December has two things wrong, and
     * remembering "this cycle was reported" rather than "this window
     * was reported" would say nothing the second time.
     */
    const told = { "c1:2026-11-10": "2026-11-10T04:00:00.000Z" };
    const december = { ...refusal("c1"), windowEnd: "2026-12-10" };
    expect(newNotices([december], told)).toEqual([december]);
  });

  it("keeps each cycle's silence its own", () => {
    const told = { "c1:2026-11-10": "2026-11-10T04:00:00.000Z" };
    expect(newNotices([refusal("c1"), refusal("c2")], told)).toEqual([refusal("c2")]);
  });

  it("treats a malformed ledger as an empty one rather than refusing to notify", () => {
    /*
     * The jsonb is hand-editable and a decade of settings will pass
     * through it. The costly direction here is silence: a ledger that
     * cannot be read must not be read as "everything has been
     * reported".
     */
    expect(newNotices([refusal("c1")], null as never)).toEqual([refusal("c1")]);
    expect(newNotices([refusal("c1")], "nonsense" as never)).toEqual([refusal("c1")]);
  });
});

describe("keeping the ledger from growing forever", () => {
  const now = new Date("2026-11-10T04:00:00.000Z");

  it("keeps a recent entry", () => {
    const kept = prunedNotices({ "c1:2026-11-10": "2026-11-09T04:00:00.000Z" }, now);
    expect(Object.keys(kept)).toEqual(["c1:2026-11-10"]);
  });

  it("drops one older than the retention it declares", () => {
    const old = new Date(now.getTime() - (NOTICE_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const kept = prunedNotices({ "c1:2026-08-10": old }, now);
    expect(kept).toEqual({});
  });

  it("drops an entry whose timestamp cannot be read", () => {
    // An unreadable timestamp can never be pruned by age, so it would
    // sit in the jsonb forever and suppress that window's notice for
    // good.
    expect(prunedNotices({ "c1:2026-08-10": "not a date" }, now)).toEqual({});
  });

  it("survives a ledger that is not an object at all", () => {
    expect(prunedNotices(null as never, now)).toEqual({});
  });
});
