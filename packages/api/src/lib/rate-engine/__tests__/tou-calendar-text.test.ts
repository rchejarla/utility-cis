import { describe, it, expect } from "vitest";
import { describeTouHours } from "../tou-calendar-text.js";
import type { TouCalendarDefinition } from "../tou-calendar.js";
import type { SeasonDefinition } from "../seasons.js";
import { SMUD_CALENDAR, SMUD_SEASONS } from "./tariff-golden/_smud-time-of-day-fixtures.js";

/**
 * The bill's hours footnote (spec 26, TOU-BIL-2), read off a published
 * calendar's spans. Against the real SMUD Time-of-Day calendar first,
 * because a footnote that misstates a published tariff is the failure that
 * matters.
 */

const SMUD_LABELS = new Map([
  ["peak", "Peak"],
  ["mid_peak", "Mid-peak"],
  ["off_peak", "Off-peak"],
]);
const SMUD_ORDER = ["peak", "mid_peak", "off_peak"];

const smud = (seasonCode: string, clockBasis = "local") =>
  describeTouHours({
    definition: SMUD_CALENDAR,
    seasons: SMUD_SEASONS,
    seasonCode,
    periodLabels: SMUD_LABELS,
    periodOrder: SMUD_ORDER,
    clockBasis,
  });

describe("describeTouHours", () => {
  it("states SMUD's summer hours, with off-peak as all other hours", () => {
    expect(smud("summer")).toEqual([
      "Time-of-day periods, summer season (1 Jun – 30 Sep):",
      "Peak: 5–8 pm weekdays, excluding holidays.",
      "Mid-peak: noon–5 pm and 8 pm–midnight weekdays, excluding holidays.",
      "Off-peak: all other hours.",
    ]);
  });

  it("describes only the season the bill was priced in", () => {
    expect(smud("non_summer")).toEqual([
      "Time-of-day periods, non summer season (1 Oct – 31 May):",
      "Peak: 5–8 pm weekdays, excluding holidays.",
      "Off-peak: all other hours.",
    ]);
  });

  it("says when the hours do not move with daylight saving time", () => {
    expect(smud("summer", "standard")[0]).toBe(
      "Time-of-day periods, summer season (1 Jun – 30 Sep), standard time all year:",
    );
  });

  const allYear: SeasonDefinition[] = [
    { seasonCode: "all", startMonth: 1, startDay: 1, endMonth: 12, endDay: 31 },
  ];

  it("joins a period that runs through midnight into one range", () => {
    // Super off-peak 11 pm – 6 am every night: two spans, one period.
    const calendar: TouCalendarDefinition = {
      dayTypes: [{ dayTypeCode: "day", weekdays: [1, 2, 3, 4, 5, 6, 7] }],
      slots: [
        { seasonCode: "all", dayTypeCode: "day", startMinute: 0, endMinute: 360, peakCode: "super_off" },
        { seasonCode: "all", dayTypeCode: "day", startMinute: 360, endMinute: 1380, peakCode: "standard" },
        { seasonCode: "all", dayTypeCode: "day", startMinute: 1380, endMinute: 1440, peakCode: "super_off" },
      ],
    };
    expect(
      describeTouHours({
        definition: calendar,
        seasons: allYear,
        seasonCode: "all",
        periodLabels: new Map([["super_off", "Super off-peak"], ["standard", "Standard"]]),
        periodOrder: ["super_off", "standard"],
        clockBasis: "local",
      }).slice(1),
    ).toEqual(["Super off-peak: 11 pm–6 am every day.", "Standard: all other hours."]);
  });

  it("names a day type by its weekdays when it is not a whole week or weekend", () => {
    // Saturday priced apart from Sunday is a real tariff.
    const calendar: TouCalendarDefinition = {
      dayTypes: [
        { dayTypeCode: "weekday", weekdays: [1, 2, 3, 4, 5] },
        { dayTypeCode: "saturday", weekdays: [6] },
        { dayTypeCode: "sunday", weekdays: [7] },
      ],
      slots: [
        { seasonCode: "all", dayTypeCode: "weekday", startMinute: 0, endMinute: 960, peakCode: "off" },
        { seasonCode: "all", dayTypeCode: "weekday", startMinute: 960, endMinute: 1260, peakCode: "on" },
        { seasonCode: "all", dayTypeCode: "weekday", startMinute: 1260, endMinute: 1440, peakCode: "off" },
        { seasonCode: "all", dayTypeCode: "saturday", startMinute: 0, endMinute: 600, peakCode: "off" },
        { seasonCode: "all", dayTypeCode: "saturday", startMinute: 600, endMinute: 840, peakCode: "on" },
        { seasonCode: "all", dayTypeCode: "saturday", startMinute: 840, endMinute: 1440, peakCode: "off" },
        { seasonCode: "all", dayTypeCode: "sunday", startMinute: 0, endMinute: 1440, peakCode: "off" },
      ],
    };
    expect(
      describeTouHours({
        definition: calendar,
        seasons: allYear,
        seasonCode: "all",
        periodLabels: new Map([["on", "On-peak"], ["off", "Off-peak"]]),
        periodOrder: ["on", "off"],
        clockBasis: "local",
      }).slice(1),
    ).toEqual(["On-peak: 4–9 pm weekdays; 10 am–2 pm Sat.", "Off-peak: all other hours."]);
  });

  it("says 'all hours' for a season with a single period", () => {
    const calendar: TouCalendarDefinition = {
      dayTypes: [{ dayTypeCode: "day", weekdays: [1, 2, 3, 4, 5, 6, 7] }],
      slots: [{ seasonCode: "all", dayTypeCode: "day", startMinute: 0, endMinute: 1440, peakCode: "flat" }],
    };
    expect(
      describeTouHours({
        definition: calendar,
        seasons: allYear,
        seasonCode: "all",
        periodLabels: new Map([["flat", "Standard"]]),
        periodOrder: ["flat"],
        clockBasis: "local",
      }).slice(1),
    ).toEqual(["Standard: all hours."]);
  });

  it("prints a code with no tenant label as itself, rather than dropping the period", () => {
    const lines = describeTouHours({
      definition: SMUD_CALENDAR,
      seasons: SMUD_SEASONS,
      seasonCode: "summer",
      periodLabels: new Map(),
      periodOrder: SMUD_ORDER,
      clockBasis: "local",
    });
    expect(lines[1]).toBe("peak: 5–8 pm weekdays, excluding holidays.");
  });
});
