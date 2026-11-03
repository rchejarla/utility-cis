import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DayStrip, periodColour } from "../day-strip";

/**
 * The strip is the verification half of TOU-UI-1: the spans are the
 * input, and this is what shows they tile the day. So what matters is
 * that it marks the two states a list of rows cannot show — an hour no
 * period covers, and an hour two of them do.
 */

const PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "peak", label: "Peak" },
];

const cells = () => screen.getByTestId("day-strip").children;
const kinds = () =>
  Array.from(cells()).map((cell) => (cell as HTMLElement).dataset.kind as string);

describe("the day strip", () => {
  it("is 96 quarter-hours", () => {
    render(<DayStrip spans={[]} periods={PERIODS} />);
    expect(cells()).toHaveLength(96);
  });

  it("marks every quarter-hour as a gap when nothing is assigned", () => {
    render(<DayStrip spans={[]} periods={PERIODS} />);
    expect(kinds().every((k) => k === "gap")).toBe(true);
  });

  it("covers the whole day when one span does", () => {
    render(
      <DayStrip
        spans={[{ startMinute: 0, endMinute: 1440, peakCode: "off_peak" }]}
        periods={PERIODS}
      />,
    );
    expect(kinds().every((k) => k === "covered")).toBe(true);
  });

  it("marks exactly the uncovered hour, at the right place", () => {
    /*
     * 17:00–18:00 missing out of an otherwise full day. The point of
     * the strip is that this is visible without reading the rows, so
     * the test pins which cells it is: quarters 68–71.
     */
    render(
      <DayStrip
        spans={[
          { startMinute: 0, endMinute: 1020, peakCode: "off_peak" },
          { startMinute: 1080, endMinute: 1440, peakCode: "off_peak" },
        ]}
        periods={PERIODS}
      />,
    );
    const gaps = kinds()
      .map((kind, index) => ({ kind, index }))
      .filter((c) => c.kind === "gap")
      .map((c) => c.index);
    expect(gaps).toEqual([68, 69, 70, 71]);
  });

  it("marks an hour two periods both claim", () => {
    render(
      <DayStrip
        spans={[
          { startMinute: 0, endMinute: 1080, peakCode: "off_peak" },
          { startMinute: 1020, endMinute: 1200, peakCode: "peak" },
        ]}
        periods={PERIODS}
      />,
    );
    const overlaps = kinds().filter((k) => k === "overlap");
    // 17:00–18:00 is claimed twice: four quarter-hours.
    expect(overlaps).toHaveLength(4);
  });

  it("names the period and the time on each cell, for the hover", () => {
    render(
      <DayStrip
        spans={[{ startMinute: 1020, endMinute: 1200, peakCode: "peak" }]}
        periods={PERIODS}
      />,
    );
    const cell = Array.from(cells())[68] as HTMLElement;
    expect(cell.getAttribute("title")).toBe("17:00–17:15: Peak");
  });

  it("says when two periods both claim an hour, rather than showing one", () => {
    render(
      <DayStrip
        spans={[
          { startMinute: 1020, endMinute: 1200, peakCode: "peak" },
          { startMinute: 1020, endMinute: 1200, peakCode: "off_peak" },
        ]}
        periods={PERIODS}
      />,
    );
    const cell = Array.from(cells())[68] as HTMLElement;
    expect(cell.getAttribute("title")).toMatch(/both/);
  });
});

describe("period colours", () => {
  it("are assigned by position, not by the code's spelling", () => {
    /*
     * `peak_code` is a tenant string — TOU-CAL-2 leaves the vocabulary
     * open — so a palette keyed on "peak" would leave a tenant who
     * wrote "on_peak" grey everywhere. Two calendars with different
     * spellings must get the same two colours.
     */
    const theirs = [
      { peakCode: "on_peak", label: "On-Peak" },
      { peakCode: "mid", label: "Mid" },
    ];
    expect(periodColour(theirs, "on_peak")).toEqual(periodColour(PERIODS, "off_peak"));
    expect(periodColour(theirs, "mid")).toEqual(periodColour(PERIODS, "peak"));
  });

  it("falls back rather than throwing on a code the calendar has not got", () => {
    expect(periodColour(PERIODS, "super_off_peak").fill).toBeTruthy();
  });
});
