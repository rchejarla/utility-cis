import { describe, it, expect } from "vitest";
import { isValidIANA, localHour, formatInTimeZone } from "../../lib/iana-tz.js";

describe("isValidIANA", () => {
  it("accepts UTC and Etc/UTC", () => {
    expect(isValidIANA("UTC")).toBe(true);
    expect(isValidIANA("Etc/UTC")).toBe(true);
  });

  it("accepts well-known IANA zones", () => {
    expect(isValidIANA("America/New_York")).toBe(true);
    expect(isValidIANA("America/Los_Angeles")).toBe(true);
    expect(isValidIANA("Asia/Tokyo")).toBe(true);
    expect(isValidIANA("Pacific/Auckland")).toBe(true);
    expect(isValidIANA("Europe/London")).toBe(true);
  });

  it("rejects empty / blank input", () => {
    expect(isValidIANA("")).toBe(false);
    expect(isValidIANA(" ")).toBe(false);
  });

  it("rejects wrong-case zone names", () => {
    // IANA names are case-sensitive — common typo we should catch.
    expect(isValidIANA("america/new_york")).toBe(false);
    expect(isValidIANA("AMERICA/NEW_YORK")).toBe(false);
  });

  it("rejects nonexistent zones", () => {
    expect(isValidIANA("Mars/Olympus_Mons")).toBe(false);
    expect(isValidIANA("America/Atlantis")).toBe(false);
  });

  it("rejects abbreviated / numeric offset forms", () => {
    // These look like timezones but aren't valid IANA names.
    expect(isValidIANA("EST")).toBe(false);
    expect(isValidIANA("PDT")).toBe(false);
    expect(isValidIANA("GMT+5")).toBe(false);
    expect(isValidIANA("+05:00")).toBe(false);
  });
});

describe("localHour", () => {
  it("returns 0 at midnight UTC in UTC zone", () => {
    const midnight = new Date("2026-04-25T00:00:00Z");
    expect(localHour(midnight, "UTC")).toBe(0);
  });

  it("returns 23 at 23:59 UTC in UTC zone", () => {
    const lateNight = new Date("2026-04-25T23:59:59Z");
    expect(localHour(lateNight, "UTC")).toBe(23);
  });

  it("returns 9 at 00:00 UTC in Asia/Tokyo (UTC+9, no DST)", () => {
    const midnight = new Date("2026-04-25T00:00:00Z");
    expect(localHour(midnight, "Asia/Tokyo")).toBe(9);
  });

  it("returns 7 at 12:00 UTC in America/New_York during EST (winter)", () => {
    // January is firmly EST (UTC-5). 12:00 UTC = 07:00 EST.
    const noonUtc = new Date("2026-01-15T12:00:00Z");
    expect(localHour(noonUtc, "America/New_York")).toBe(7);
  });

  it("returns 8 at 12:00 UTC in America/New_York during EDT (summer)", () => {
    // July is firmly EDT (UTC-4). 12:00 UTC = 08:00 EDT.
    const noonUtc = new Date("2026-07-15T12:00:00Z");
    expect(localHour(noonUtc, "America/New_York")).toBe(8);
  });

  it("handles DST spring-forward correctly in America/New_York", () => {
    // In 2026, DST spring-forward in the US happens on March 8 at 02:00
    // local time — clocks jump from 02:00 to 03:00. So 02:30 EST does
    // not exist that morning.
    //
    // 06:30 UTC on 2026-03-08 = 01:30 EST (still before spring-forward)
    const beforeSpringForward = new Date("2026-03-08T06:30:00Z");
    expect(localHour(beforeSpringForward, "America/New_York")).toBe(1);

    // 07:30 UTC on 2026-03-08 = 03:30 EDT (after spring-forward; 02:30
    // EST never exists this day, the wall clock jumps directly to 03:00)
    const afterSpringForward = new Date("2026-03-08T07:30:00Z");
    expect(localHour(afterSpringForward, "America/New_York")).toBe(3);
  });

  it("handles DST fall-back correctly in America/Los_Angeles", () => {
    // In 2026, DST fall-back is November 1 at 02:00 PDT (= 09:00 UTC),
    // when clocks roll back to 01:00 PST. The wall-clock hour 01:30
    // happens twice that morning (08:30 UTC = 01:30 PDT, 09:30 UTC =
    // 01:30 PST).
    const firstOneThirty = new Date("2026-11-01T08:30:00Z");
    expect(localHour(firstOneThirty, "America/Los_Angeles")).toBe(1);

    const secondOneThirty = new Date("2026-11-01T09:30:00Z");
    expect(localHour(secondOneThirty, "America/Los_Angeles")).toBe(1);
  });

  it("crosses date line correctly in Pacific/Kiritimati (UTC+14)", () => {
    // 12:00 UTC on April 25 = 02:00 the next morning in Kiritimati.
    const noonUtc = new Date("2026-04-25T12:00:00Z");
    expect(localHour(noonUtc, "Pacific/Kiritimati")).toBe(2);
  });

  it("normalizes locale-specific 24 to 0 for midnight", () => {
    // Some Intl locales return "24" for midnight at the end of a day.
    // Our code normalizes to 0. Validate the contract regardless of the
    // underlying locale quirk.
    const midnightUtc = new Date("2026-04-25T00:00:00Z");
    const hour = localHour(midnightUtc, "UTC");
    expect(hour).toBeGreaterThanOrEqual(0);
    expect(hour).toBeLessThanOrEqual(23);
    expect(hour).toBe(0);
  });
});

describe("formatInTimeZone", () => {
  it("formats yyyyMMddHH in UTC", () => {
    const moment = new Date("2026-04-25T15:30:45Z");
    expect(formatInTimeZone(moment, "UTC", "yyyyMMddHH")).toBe("2026042515");
  });

  it("formats yyyyMMddHH in America/New_York during EDT", () => {
    // July 15 12:00 UTC = July 15 08:00 EDT.
    const moment = new Date("2026-07-15T12:00:00Z");
    expect(formatInTimeZone(moment, "America/New_York", "yyyyMMddHH")).toBe(
      "2026071508",
    );
  });

  it("crosses to previous day in westward zone", () => {
    // 02:00 UTC = 21:00 previous day Chicago time (UTC-5 in winter).
    const moment = new Date("2026-01-16T02:00:00Z");
    expect(formatInTimeZone(moment, "America/Chicago", "yyyyMMddHH")).toBe(
      "2026011520",
    );
  });

  it("supports separator patterns", () => {
    const moment = new Date("2026-04-25T15:30:45Z");
    expect(formatInTimeZone(moment, "UTC", "yyyy-MM-dd HH:mm:ss")).toBe(
      "2026-04-25 15:30:45",
    );
  });

  it("zero-pads single-digit components", () => {
    const moment = new Date("2026-01-05T03:04:05Z");
    expect(formatInTimeZone(moment, "UTC", "yyyy-MM-dd HH:mm:ss")).toBe(
      "2026-01-05 03:04:05",
    );
  });

  it("normalizes locale '24' to '00' at midnight", () => {
    const midnight = new Date("2026-04-26T00:00:00Z");
    expect(formatInTimeZone(midnight, "UTC", "HH")).toBe("00");
  });

  it("returns the same UTC-formatted string regardless of clock-time of construction", () => {
    // Determinism check: same instant + same tz + same pattern always
    // yields the same string. Important for our idempotency-key use
    // case where the dispatcher computes jobIds.
    const moment = new Date("2026-04-25T03:00:00Z");
    const a = formatInTimeZone(moment, "UTC", "yyyyMMddHH");
    const b = formatInTimeZone(moment, "UTC", "yyyyMMddHH");
    expect(a).toBe(b);
  });
});
