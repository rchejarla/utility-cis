import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { YearStrip, seasonColour, type CoverageDay } from "../year-strip";

/**
 * The year bar is the verification half of the season editor: the
 * seasons are a short list of month/day ranges, and this shows they
 * cover the year exactly once.
 *
 * The coverage comes from the server — it is the engine's own
 * computation, the same one that decides whether the set may be
 * published — so what is tested here is the rendering of it, and in
 * particular that a day claimed by nobody and a day claimed by two look
 * different from each other and from a covered day.
 */

/** A full leap year claimed by one season. */
function fullYear(code = "all"): CoverageDay[] {
  const days: CoverageDay[] = [];
  for (let month = 1; month <= 12; month++) {
    const length = new Date(Date.UTC(2028, month, 0)).getUTCDate();
    for (let day = 1; day <= length; day++) days.push({ month, day, claimedBy: [code] });
  }
  return days;
}

const cells = () => screen.getByTestId("year-strip").children;
const kinds = () =>
  Array.from(cells()).map((cell) => (cell as HTMLElement).dataset.kind as string);

describe("the year strip", () => {
  it("is 366 days, because the year the engine enumerates is a leap year", () => {
    /*
     * Not cosmetic: a set that ends February on the 28th tiles 365 days
     * exactly and loses a day every fourth year. The bar has to have
     * somewhere to show that.
     */
    render(<YearStrip coverage={fullYear()} seasonCodes={["all"]} />);
    expect(cells()).toHaveLength(366);
  });

  it("shows a covered year as covered throughout", () => {
    render(<YearStrip coverage={fullYear()} seasonCodes={["all"]} />);
    expect(kinds().every((k) => k === "covered")).toBe(true);
  });

  it("marks the leap day when only it is unclaimed", () => {
    const coverage = fullYear().map((d) =>
      d.month === 2 && d.day === 29 ? { ...d, claimedBy: [] } : d,
    );
    render(<YearStrip coverage={coverage} seasonCodes={["all"]} />);
    expect(kinds().filter((k) => k === "gap")).toHaveLength(1);

    const gap = Array.from(cells()).find(
      (c) => (c as HTMLElement).dataset.kind === "gap",
    ) as HTMLElement;
    expect(gap.getAttribute("title")).toBe("29 Feb: no season");
  });

  it("marks a day two seasons both claim, and names both", () => {
    const coverage = fullYear().map((d) =>
      d.month === 7 && d.day === 1 ? { ...d, claimedBy: ["summer", "winter"] } : d,
    );
    render(<YearStrip coverage={coverage} seasonCodes={["summer", "winter"]} />);
    const overlap = Array.from(cells()).find(
      (c) => (c as HTMLElement).dataset.kind === "overlap",
    ) as HTMLElement;
    expect(overlap.getAttribute("title")).toBe("1 Jul: summer and winter both");
  });

  it("names the season on a covered day, for the hover", () => {
    render(<YearStrip coverage={fullYear("summer")} seasonCodes={["summer"]} />);
    expect((Array.from(cells())[0] as HTMLElement).getAttribute("title")).toBe("1 Jan: summer");
  });

  it("labels the twelve months", () => {
    render(<YearStrip coverage={fullYear()} seasonCodes={["all"]} />);
    expect(screen.getByText("Jan")).toBeInTheDocument();
    expect(screen.getByText("Dec")).toBeInTheDocument();
  });
});

describe("season colours", () => {
  it("are assigned by position, so two sets with different codes match", () => {
    expect(seasonColour(["summer", "winter"], "summer")).toEqual(
      seasonColour(["hot", "cold"], "hot"),
    );
  });

  it("falls back rather than throwing on an unknown code", () => {
    expect(seasonColour(["summer"], "shoulder").fill).toBeTruthy();
  });
});
