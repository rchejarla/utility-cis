import { describe, it, expect } from "vitest";
import { monthlyUsage } from "../../services/portal-usage.js";

/**
 * The portal's monthly usage, by the rating engine's rule: a meter's total
 * read wins over the TOU buckets that reconcile to it, and the buckets
 * stand in where there is no total. The portal used to add every row, so a
 * TOU customer's month showed about double — the first case below.
 */
describe("monthlyUsage", () => {
  const read = (readDate: string, consumption: number, peakCode: string | null, meterId = "m-1") => ({
    readDate,
    consumption,
    peakCode,
    meterId,
  });

  it("counts a TOU meter's month once: the total read, not the total plus its buckets", () => {
    expect(
      monthlyUsage([
        read("2026-06-08", 623, null),
        read("2026-06-08", 132, "peak"),
        read("2026-06-08", 89, "mid_peak"),
        read("2026-06-08", 402, "off_peak"),
      ]),
    ).toEqual([{ month: "2026-06", total: 623 }]);
  });

  it("falls back to the buckets for a meter with no total read, as an interval meter has", () => {
    expect(
      monthlyUsage([read("2026-06-30", 140, "peak"), read("2026-06-30", 485.5, "off_peak")]),
    ).toEqual([{ month: "2026-06", total: 625.5 }]);
  });

  it("decides per meter, so one meter's total cannot hide another meter's buckets", () => {
    expect(
      monthlyUsage([
        read("2026-06-08", 3500, null, "water"),
        read("2026-06-30", 140, "peak", "electric"),
        read("2026-06-30", 485, "off_peak", "electric"),
      ]),
    ).toEqual([{ month: "2026-06", total: 4125 }]);
  });

  it("keeps an ordinary meter's months as they were, in order", () => {
    expect(
      monthlyUsage([
        read("2026-07-08", 30, null),
        read("2026-05-08", 28, null),
        read("2026-06-08", 32.333, null),
      ]),
    ).toEqual([
      { month: "2026-05", total: 28 },
      { month: "2026-06", total: 32.33 },
      { month: "2026-07", total: 30 },
    ]);
  });

  it("accepts Dates as Prisma returns them, and Decimal-like consumption", () => {
    expect(
      monthlyUsage([
        { readDate: new Date("2026-06-08T00:00:00Z"), consumption: { toString: () => "12.5" }, peakCode: null, meterId: "m" },
      ]),
    ).toEqual([{ month: "2026-06", total: 12.5 }]);
  });
});
