import { describe, it, expect } from "vitest";
import { renderRouteSheetPdf, type RouteSheet, type SheetStop } from "../../services/read-route/route-sheet.js";

/**
 * The PDF half of the printed sheet. A pure function over a plain object,
 * so no database: the data half is in `route-sheet.integration.test.ts`,
 * because its tests are query shapes over real joins.
 *
 * What this can and cannot say: react-pdf compresses page content, so the
 * bytes cannot be searched for an address. It proves the document renders
 * with the standard font (an unregistered font throws at render time) and
 * that a long route paginates rather than clipping.
 */

function stop(sequence: number, over: Partial<SheetStop> = {}): SheetStop {
  return {
    sequence,
    address: `${sequence} Elm Street, Testville`,
    accountNumber: `ACCT-${sequence}`,
    meterNumber: `MTR-${sequence}`,
    registerNumber: null,
    lastReading: "1234.5",
    lastReadDate: "2026-01-08",
    ...over,
  };
}

function sheet(stops: SheetStop[]): RouteSheet {
  return {
    routeCode: "R-1",
    routeName: "North side",
    cycleCode: "C-1",
    readsDueOn: "2026-01-15",
    forDate: "2026-01-10",
    stops,
    stopsWithNothingToRead: [],
  };
}

/** Pages in a PDF: each page object is `/Type /Page` (and not `/Pages`). */
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

describe("renderRouteSheetPdf", () => {
  it("renders a PDF", async () => {
    // Breaks if: the template throws (e.g. a non-standard font), or the
    // render call is removed.
    const pdf = await renderRouteSheetPdf(
      sheet([stop(100), stop(200, { registerNumber: "2" }), stop(300, { lastReading: null, lastReadDate: null })]),
    );
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pageCount(pdf)).toBe(1);
  });

  it("paginates a long route instead of clipping it", async () => {
    // Breaks if: rows stop flowing across pages (e.g. the page is given a
    // fixed height, or rows are all marked `fixed`).
    const many = Array.from({ length: 150 }, (_, i) => stop((i + 1) * 100));
    expect(pageCount(await renderRouteSheetPdf(sheet(many)))).toBeGreaterThan(1);
  });

  it("renders a route with no lines", async () => {
    // Breaks if: the template assumes a first stop.
    const pdf = await renderRouteSheetPdf(sheet([]));
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
