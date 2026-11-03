import { describe, it, expect } from "vitest";
import { standardOffsetMinutes, toLocalMoment, zoneOffsetMinutes } from "../tou-clock.js";

/**
 * Stored instant → local wall clock (spec 26, TOU-CAL-6 and TOU-CAL-7).
 *
 * Interval timestamps are stored in UTC. A calendar classifies by local
 * wall-clock time, so something has to convert — and that conversion is
 * where every daylight-saving surprise lives. It is separated from the
 * calendar itself because TOU-CAL-7 classifies the repeated fall-back
 * hour twice, "both by the same wall-clock rule": the rule must not
 * know about offsets, and the offsets must not know about peaks.
 *
 * `America/Denver` throughout, since it is the deployment's own zone.
 * Daylight saving 2026: forward 8 March (02:00 → 03:00), back
 * 1 November (02:00 → 01:00).
 */

const DENVER = "America/Denver";

/** A UTC instant. */
const at = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h, mi));

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("zoneOffsetMinutes", () => {
  it("reads the offset in force at an instant", () => {
    expect(zoneOffsetMinutes(at(2026, 1, 15, 12), DENVER)).toBe(-420); // MST, UTC-7
    expect(zoneOffsetMinutes(at(2026, 7, 15, 12), DENVER)).toBe(-360); // MDT, UTC-6
  });

  it("refuses a zone name it does not know", () => {
    // A typo in a published calendar's zone would otherwise fall back to
    // UTC and shift every peak by seven hours with nothing raised.
    expect(() => zoneOffsetMinutes(at(2026, 7, 15, 12), "America/Denvre")).toThrow();
  });
});

describe("standardOffsetMinutes", () => {
  it("is the winter offset in the northern hemisphere", () => {
    expect(standardOffsetMinutes(DENVER, 2026)).toBe(-420);
  });

  it("is the winter offset in the southern hemisphere too", () => {
    /*
     * Sydney is UTC+11 in January and UTC+10 in July, so "sample
     * January" would call daylight time standard and run every peak an
     * hour early for a whole year. Daylight saving always moves the
     * clock *forward*, so the standard offset is the lesser of the two
     * — which is hemisphere-independent.
     */
    expect(standardOffsetMinutes("Australia/Sydney", 2026)).toBe(600);
  });

  it("equals the only offset a zone without daylight saving has", () => {
    expect(standardOffsetMinutes("America/Phoenix", 2026)).toBe(-420);
  });
});

describe("toLocalMoment, prevailing time", () => {
  const local = (instant: Date) => toLocalMoment(instant, DENVER, "prevailing");

  it("converts a summer instant", () => {
    // 23:00 UTC on 1 July is 17:00 MDT, which is 1020 minutes.
    const m = local(at(2026, 7, 1, 23));
    expect(iso(m.date)).toBe("2026-07-01");
    expect(m.minuteOfDay).toBe(1020);
  });

  it("converts a winter instant", () => {
    // 00:00 UTC on 2 January is 17:00 MST on 1 January.
    const m = local(at(2026, 1, 2, 0));
    expect(iso(m.date)).toBe("2026-01-01");
    expect(m.minuteOfDay).toBe(1020);
  });

  it("gives the local calendar day, not the UTC one", () => {
    // 03:00 UTC on 2 July is 21:00 MDT on 1 July. Classifying this
    // against 2 July would read a Thursday's day type for a Wednesday
    // evening, and against 03:00 would price the night off-peak.
    const m = local(at(2026, 7, 2, 3));
    expect(iso(m.date)).toBe("2026-07-01");
    expect(m.minuteOfDay).toBe(1260);
  });

  it("skips the local hour that spring forward removes", () => {
    /*
     * 8 March 2026: 02:00 local becomes 03:00. 08:59 UTC is 01:59 MST,
     * and one minute later is 03:00 MDT — nothing maps into 02:00–03:00,
     * which is why TOU-CAL-7 says the missing hour has no intervals.
     */
    expect(local(at(2026, 3, 8, 8, 59)).minuteOfDay).toBe(119); // 01:59
    expect(local(at(2026, 3, 8, 9, 0)).minuteOfDay).toBe(180); // 03:00
  });

  it("maps both occurrences of the repeated fall-back hour to the same local time", () => {
    /*
     * 1 November 2026: 02:00 MDT becomes 01:00 MST, so 01:00–02:00
     * happens twice. TOU-CAL-7 classifies each occurrence by the same
     * wall-clock rule, which means both land on minute 60 and are
     * priced the same — two distinct intervals, one local time. The
     * interval rows stay distinct because they are stored in UTC.
     */
    const first = local(at(2026, 11, 1, 7)); // 01:00 MDT
    const second = local(at(2026, 11, 1, 8)); // 01:00 MST
    expect(first.minuteOfDay).toBe(60);
    expect(second.minuteOfDay).toBe(60);
    expect(iso(first.date)).toBe("2026-11-01");
    expect(iso(second.date)).toBe("2026-11-01");
  });
});

describe("toLocalMoment, standard time basis", () => {
  const standard = (instant: Date) => toLocalMoment(instant, DENVER, "standard");
  const prevailing = (instant: Date) => toLocalMoment(instant, DENVER, "prevailing");

  it("runs an hour behind prevailing time during daylight saving", () => {
    /*
     * TOU-CAL-6's example: a tariff written in standard time with a
     * 4–9 pm peak runs 5–10 pm by the summer clock. So the instant the
     * prevailing calendar calls 17:00 is 16:00 to a standard-basis one,
     * and an hour of the afternoon that looks on-peak is not.
     */
    const instant = at(2026, 7, 1, 23);
    expect(prevailing(instant).minuteOfDay).toBe(1020); // 17:00
    expect(standard(instant).minuteOfDay).toBe(960); // 16:00
  });

  it("agrees with prevailing time outside daylight saving", () => {
    const instant = at(2026, 1, 2, 0);
    expect(standard(instant)).toEqual(prevailing(instant));
  });

  it("does not skip or repeat an hour on the transition days", () => {
    // The point of the standard basis: there are no transitions, so the
    // day has 1440 minutes on 8 March and on 1 November alike.
    expect(standard(at(2026, 3, 8, 8, 59)).minuteOfDay).toBe(119); // 01:59
    expect(standard(at(2026, 3, 8, 9, 0)).minuteOfDay).toBe(120); // 02:00, which prevailing has not got
    expect(standard(at(2026, 11, 1, 7)).minuteOfDay).toBe(0); // 00:00
    expect(standard(at(2026, 11, 1, 8)).minuteOfDay).toBe(60); // 01:00, once
  });

  it("disagrees with prevailing time about which local day an instant is on", () => {
    /*
     * 06:00 UTC on 2 July is 00:00 MDT — already the 2nd — but 23:00
     * MST, still the 1st. The *day* is what decides the day type, so
     * for one hour each summer night the two bases can read a different
     * day type as well as a different hour. Worth pinning: this is the
     * boundary that makes a standard-basis calendar more than an hour's
     * offset.
     *
     * The expectations here were an hour out when first written (06:00
     * minus seven hours is the previous day, not midnight) — the kind
     * of arithmetic to compute rather than assume.
     */
    const instant = at(2026, 7, 2, 6);
    const p = prevailing(instant);
    expect(iso(p.date)).toBe("2026-07-02");
    expect(p.minuteOfDay).toBe(0);

    const s = standard(instant);
    expect(iso(s.date)).toBe("2026-07-01");
    expect(s.minuteOfDay).toBe(1380); // 23:00
  });
});

describe("toLocalMoment, other zones", () => {
  it("converts a zone east of Greenwich", () => {
    // 09:00 UTC is 19:00 AEST on the same day (Sydney, July, UTC+10).
    const m = toLocalMoment(at(2026, 7, 1, 9), "Australia/Sydney", "prevailing");
    expect(iso(m.date)).toBe("2026-07-01");
    expect(m.minuteOfDay).toBe(1140);
  });

  it("converts a zone with a half-hour offset", () => {
    // Kolkata is UTC+5:30 with no daylight saving.
    const m = toLocalMoment(at(2026, 7, 1, 9), "Asia/Kolkata", "prevailing");
    expect(m.minuteOfDay).toBe(14 * 60 + 30);
  });

  it("refuses a zone name it does not know", () => {
    expect(() => toLocalMoment(at(2026, 7, 1, 9), "Mars/Olympus", "prevailing")).toThrow();
  });
});
