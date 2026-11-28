import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import { historyForRows, historyKey } from "../../services/read-route/reading-band.js";

/**
 * The entry screen's band (spec 30 §5.7), for the two kinds of dial.
 *
 * An energy dial accumulates, so its next reading is expected at the last
 * one plus a typical month. A demand dial (spec 31, DEM-RD-1) shows the
 * period's peak and is reset when read, so its next reading is expected
 * near its typical peak — measured from the last reading, the band would
 * hold every ordinary peak and pass only one twice the usual.
 */

const UID = "00000000-0000-4000-8000-00000000000a";
const METER = "00000000-0000-4000-8000-000000000100";
const ENERGY = "00000000-0000-4000-8000-000000000201";
const DEMAND = "00000000-0000-4000-8000-000000000202";

const raw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

/** Newest first, as the query returns them. */
function reads(registerId: string, measure: string, rows: [reading: number, consumption: number][]) {
  return rows.map(([reading, consumption], i) => ({
    meter_id: METER,
    register_id: registerId,
    reading,
    consumption,
    read_date: new Date(Date.UTC(2026, 9 - i, 8)),
    measure,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  raw.mockResolvedValue([
    ...reads(ENERGY, "USAGE", [[4000, 1000], [3000, 1000], [2000, 1000]]),
    ...reads(DEMAND, "DEMAND", [[300, 300], [320, 320], [310, 310]]),
  ]);
});

describe("historyForRows", () => {
  it("puts an energy dial's band on top of its last reading", async () => {
    const out = await historyForRows(UID, [{ meterId: METER, registerId: ENERGY }, { meterId: METER, registerId: DEMAND }], new Date("2026-11-08"));

    const band = out.get(historyKey(METER, ENERGY))!.band!;
    expect(band.low).toBe("4500");
    expect(band.high).toBe("6000");
  });

  it("puts a demand dial's band around its typical peak, not on top of the last", async () => {
    const out = await historyForRows(UID, [{ meterId: METER, registerId: ENERGY }, { meterId: METER, registerId: DEMAND }], new Date("2026-11-08"));

    const history = out.get(historyKey(METER, DEMAND))!;
    expect(history.lastReading).toBe("300");
    expect(history.band).toMatchObject({ typical: "310", low: "155", high: "620" });
  });
});
