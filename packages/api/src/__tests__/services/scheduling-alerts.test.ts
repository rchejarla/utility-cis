import { describe, it, expect } from "vitest";
import {
  cronIntervalMs,
  longestQuietWindowMs,
  mailHeldAlert,
  unpromotedSchedulerAlerts,
  QUIET_WINDOW_FALLBACK_MS,
} from "../../services/scheduling-alerts.js";
import type { SchedulerView } from "../../services/scheduler-view.service.js";

/**
 * The two conditions nobody is looking at a page to see.
 *
 * SCH-NODE-4 and SCH-PAUSE-6 are the same shape as each other: work that
 * is not happening, where every count on the console looks ordinary. A
 * queue with nothing attached has healthy-looking counts, and mail held
 * behind a paused queue is indistinguishable from mail that has already
 * gone out.
 *
 * Both are pure functions over data the console already reads, so the
 * cases below are the month-end and timezone cases that would otherwise
 * need a live Redis to reach.
 */

function scheduler(over: Partial<SchedulerView> = {}): SchedulerView {
  return {
    queue: "billing-dispatch",
    schedulerId: "billing-dispatch-cron",
    jobName: "dispatch-billing",
    pattern: "0 * * * *",
    everyMs: null,
    timezone: "UTC",
    nextRunAt: null,
    overdue: false,
    lastRunAt: null,
    iterations: null,
    orphan: false,
    workers: 1,
    paused: false,
    ...over,
  };
}

describe("how long a scheduler's own interval is", () => {
  it("measures the gap between the next two occurrences", () => {
    expect(cronIntervalMs("0 * * * *", "UTC")).toBe(3_600_000);
    expect(cronIntervalMs("*/5 * * * *", "UTC")).toBe(300_000);
    expect(cronIntervalMs("0 4 * * *", "UTC")).toBe(86_400_000);
  });

  it("reads a six-field pattern as seconds, not minutes", () => {
    // `notification-send` fires on `*/10 * * * * *`. Read as five
    // fields that is every ten minutes, which would make the alert
    // threshold sixty times too long for the one queue where held mail
    // matters most.
    expect(cronIntervalMs("*/10 * * * * *", "UTC")).toBe(10_000);
  });

  it("returns null for a pattern it cannot read, rather than a wrong number", () => {
    // An unparseable pattern must not become a threshold of zero, which
    // would alert on every scheduler the instant it went a second past
    // due.
    expect(cronIntervalMs("not a cron", "UTC")).toBeNull();
    expect(cronIntervalMs(null, "UTC")).toBeNull();
  });
});

describe("a scheduler nothing is promoting", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("alerts when an hourly cron is more than an hour overdue with nothing attached", () => {
    const alerts = unpromotedSchedulerAlerts(
      [
        scheduler({
          workers: 0,
          nextRunAt: "2026-11-02T10:00:00.000Z", // two hours late
          overdue: true,
        }),
      ],
      now,
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "unpromotedScheduler",
      queue: "billing-dispatch",
      schedulerId: "billing-dispatch-cron",
    });
    // The operator needs the duration, not the timestamp: a bare
    // timestamp makes the reader do the subtraction, which is how a
    // stalled scheduler goes unnoticed in the first place.
    expect(alerts[0].forSeconds).toBe(7200);
  });

  it("stays quiet inside one interval, which is an ordinary moment between fires", () => {
    /*
     * The threshold is the scheduler's own interval and not zero. A
     * worker that restarted a second ago leaves a scheduler briefly
     * past due with nothing attached, and alerting on that would make
     * every deploy ring.
     */
    const alerts = unpromotedSchedulerAlerts(
      [scheduler({ workers: 0, nextRunAt: "2026-11-02T11:30:00.000Z", overdue: true })],
      now,
    );
    expect(alerts).toEqual([]);
  });

  it("stays quiet when a worker is attached, however late the scheduler is", () => {
    // Late with a worker attached is a different fault — a slow or
    // wedged handler — and SCH-NODE-4 is specifically about nothing
    // being there to promote it.
    const alerts = unpromotedSchedulerAlerts(
      [scheduler({ workers: 2, nextRunAt: "2026-11-01T00:00:00.000Z", overdue: true })],
      now,
    );
    expect(alerts).toEqual([]);
  });

  it("stays quiet for a paused queue, which is already reported by name", () => {
    /*
     * A pause is deliberate and carries who, when and why (SCH-PAUSE-5).
     * Reporting it a second time as an unpromoted scheduler would bury
     * the record that says an operator did this on purpose.
     */
    const alerts = unpromotedSchedulerAlerts(
      [
        scheduler({
          workers: 0,
          paused: true,
          nextRunAt: "2026-11-01T00:00:00.000Z",
          overdue: true,
        }),
      ],
      now,
    );
    expect(alerts).toEqual([]);
  });

  it("says nothing when worker attachment could not be read", () => {
    /*
     * Null is "this Redis will not list its clients" (a managed Redis
     * refuses CLIENT LIST), not "zero workers". Treating it as zero
     * would alert on every scheduler on every deployment that uses one.
     */
    const alerts = unpromotedSchedulerAlerts(
      [scheduler({ workers: null, nextRunAt: "2026-11-01T00:00:00.000Z", overdue: true })],
      now,
    );
    expect(alerts).toEqual([]);
  });

  it("uses a fixed interval where the scheduler has one instead of a cron", () => {
    const alerts = unpromotedSchedulerAlerts(
      [
        scheduler({
          pattern: null,
          everyMs: 60_000,
          workers: 0,
          nextRunAt: "2026-11-02T11:58:00.000Z", // two minutes late
          overdue: true,
        }),
      ],
      now,
    );
    expect(alerts).toHaveLength(1);
  });

  it("reports an orphan that nothing is promoting as the orphan it is", () => {
    /*
     * An armed scheduler this build does not know keeps firing until
     * somebody removes it (SCH-NODE-1). One with nothing attached is
     * both conditions at once, and the message has to say which action
     * to take — removing it, not starting a worker for it.
     */
    const alerts = unpromotedSchedulerAlerts(
      [
        scheduler({
          orphan: true,
          schedulerId: "retired-cron",
          workers: 0,
          nextRunAt: "2026-11-02T09:00:00.000Z",
          overdue: true,
        }),
      ],
      now,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/does not know/i);
  });
});

describe("the longest quiet-hours window any tenant has set", () => {
  it("takes the widest, because it is the span the product already calls acceptable silence", () => {
    expect(
      longestQuietWindowMs([
        { notificationQuietStart: "21:00", notificationQuietEnd: "07:00" }, // 10h
        { notificationQuietStart: "22:00", notificationQuietEnd: "06:00" }, // 8h
      ]),
    ).toBe(10 * 3_600_000);
  });

  it("reads a window that wraps midnight as the night it is", () => {
    // 21:00..07:00 is ten hours, not minus fourteen. Subtracting
    // naively would give a negative threshold and alert instantly.
    expect(
      longestQuietWindowMs([{ notificationQuietStart: "23:30", notificationQuietEnd: "00:30" }]),
    ).toBe(3_600_000);
  });

  it("falls back to a declared span when no tenant has configured one", () => {
    expect(longestQuietWindowMs([])).toBe(QUIET_WINDOW_FALLBACK_MS);
  });

  it("ignores a malformed window rather than letting it set the threshold", () => {
    expect(
      longestQuietWindowMs([
        { notificationQuietStart: "nonsense", notificationQuietEnd: "07:00" },
        { notificationQuietStart: "22:00", notificationQuietEnd: "06:00" },
      ]),
    ).toBe(8 * 3_600_000);
  });
});

describe("mail held behind a paused queue", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const record = (at: string) => ({
    at,
    by: "Ops",
    byId: "11111111-1111-4111-8111-111111111111",
    reason: "provider maintenance",
  });

  it("alerts once the pause has outlived the longest quiet-hours window", () => {
    const alert = mailHeldAlert(true, record("2026-11-02T00:00:00.000Z"), 41, 10 * 3_600_000, now);

    expect(alert).toMatchObject({ kind: "mailHeldPaused", queue: "notification-send" });
    expect(alert?.forSeconds).toBe(12 * 3600);
    // Both facts the operator needs: how long, and how much is behind it.
    expect(alert?.message).toContain("41");
    expect(alert?.message).toContain("provider maintenance");
  });

  it("stays quiet inside the window, which is a span the product already tolerates", () => {
    expect(
      mailHeldAlert(true, record("2026-11-02T08:00:00.000Z"), 41, 10 * 3_600_000, now),
    ).toBeNull();
  });

  it("alerts on a long pause even with nothing queued behind it yet", () => {
    /*
     * Nothing waiting is not reassurance. The sweep is what *moves*
     * messages into the queue, and a paused queue that nobody resumes
     * is the reason a tenant's mail stops — the emptiness is the
     * symptom, not the all-clear.
     */
    const alert = mailHeldAlert(true, record("2026-11-01T00:00:00.000Z"), 0, 10 * 3_600_000, now);
    expect(alert).not.toBeNull();
  });

  it("says nothing when the queue is not paused", () => {
    // Running with a stale record left behind is the ordinary case:
    // resume never requires a record to exist, so one survives the
    // resume. A report of a stop that has ended is a false alarm.
    expect(mailHeldAlert(false, record("2026-11-01T00:00:00.000Z"), 0, 10 * 3_600_000, now)).toBeNull();
  });

  it("alerts on a pause whose record was lost, rather than trusting the gap", () => {
    /*
     * A queue paused straight in Redis has no record (SCH-PAUSE-5 keeps
     * the reason, and resume never requires one). With no `pausedAt`
     * there is no duration to compare, and the safe reading of "paused
     * for unknown reasons by nobody" is to say so — the alternative is
     * silence on the pause nobody can explain.
     */
    const alert = mailHeldAlert(true, null, 7, 1_000, now);
    expect(alert).not.toBeNull();
    expect(alert?.forSeconds).toBeNull();
    expect(alert?.message).toMatch(/no record/i);
  });
});
