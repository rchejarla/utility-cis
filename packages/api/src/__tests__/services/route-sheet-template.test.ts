import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { SKIP_REASONS } from "@utility-cis/shared";
import { RouteSheetTemplate } from "../../services/read-route/route-sheet-template.js";
import type { RouteSheet, SheetStop } from "../../services/read-route/route-sheet.js";

/**
 * What the template prints, asserted on the element tree it returns.
 * react-pdf's page content is compressed, so the bytes cannot be searched;
 * the tree can be walked, and a column swap shows here and not otherwise.
 *
 * Imports the template alone. Its only back-import is `import type`, so
 * this loads no Prisma client and constructs no database pool, which
 * importing `route-sheet.js` would.
 */

type El = ReactElement<{ children?: unknown; wrap?: boolean; fixed?: boolean }>;

const kids = (el: El): unknown[] => [el.props.children].flat(Infinity).filter((c) => c != null && c !== false);
const isEl = (x: unknown): x is El => typeof x === "object" && x !== null && "props" in x;

/** Every string under a node, concatenated. */
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isEl(node)) return "";
  return kids(node).map(text).join("");
}

/** Every element in the tree, depth first. */
function all(node: unknown): El[] {
  if (!isEl(node)) return [];
  return [node, ...kids(node).flatMap(all)];
}

function stop(over: Partial<SheetStop> = {}): SheetStop {
  return {
    sequence: 100,
    address: "12 Elm Street, Testville",
    accountNumber: "ACCT-9",
    meterNumber: "MTR-77",
    registerNumber: null,
    lastReading: "1234.5",
    lastReadDate: "2026-01-08",
    ...over,
  };
}

function sheet(over: Partial<RouteSheet> = {}): RouteSheet {
  return {
    routeCode: "R-1",
    routeName: "North side",
    cycleCode: "C-1",
    readsDueOn: "2026-01-15",
    forDate: "2026-01-10",
    stops: [stop()],
    stopsWithNothingToRead: [],
    ...over,
  };
}

/** The printed rows: the only `wrap={false}` views. Each is [seq, address, account, meter, last, write, code]. */
const rows = (s: RouteSheet) =>
  all(RouteSheetTemplate({ sheet: s })).filter((e) => e.props.wrap === false).map((r) => kids(r));
const footer = (s: RouteSheet) =>
  text(all(RouteSheetTemplate({ sheet: s })).filter((e) => e.props.fixed === true).at(-1));
const header = (s: RouteSheet) =>
  text(all(RouteSheetTemplate({ sheet: s })).filter((e) => e.props.fixed === true)[0]);

describe("RouteSheetTemplate cells", () => {
  it("puts the address in the address column and the meter number in the meter column", () => {
    // Breaks if: the meter number is printed in the address cell, or the columns are swapped.
    const [row] = rows(sheet());
    expect(text(row![1])).toBe("12 Elm Street, Testville");
    expect(text(row![2])).toBe("ACCT-9");
    expect(text(row![3])).toBe("MTR-77");
    expect(text(row![1])).not.toContain("MTR-77");
  });

  it("prints a register label in the meter cell, and none for a register-less meter", () => {
    // Breaks if: `registerNumber` is not forwarded to the cell.
    const [two, none] = rows(sheet({ stops: [stop({ registerNumber: "2" }), stop({ registerNumber: null })] }));
    expect(text(two![3])).toContain("reg 2");
    expect(text(none![3])).toBe("MTR-77");
  });

  it("prints 'none' for a meter never read, and the reading and date otherwise", () => {
    // Breaks if: a null reading prints as "null", "0" or blank.
    const [never, read] = rows(sheet({ stops: [stop({ lastReading: null, lastReadDate: null }), stop()] }));
    expect(text(never![4])).toBe("none");
    expect(text(read![4])).toBe("1234.5 (8 Jan 2026)");
  });

  it("prints every skip code in the footer", () => {
    // Breaks if: the legend is hand-listed and a code is missing from it.
    const legend = footer(sheet());
    expect(SKIP_REASONS).toHaveLength(7);
    for (const code of SKIP_REASONS) expect(legend).toContain(code);
  });
});

describe("RouteSheetTemplate header", () => {
  it("counts stops on the route, not only the lines that print", () => {
    // Three lines at one stop plus one stop with nothing to read: 3 lines on 2 stops.
    // Breaks if: stops are counted as lines (3), or the omitted stop is left out (1).
    const h = header(
      sheet({
        stops: [stop({ registerNumber: "1" }), stop({ registerNumber: "2" }), stop({ registerNumber: "3" })],
        stopsWithNothingToRead: [{ sequence: 200, address: "9 Vacant Lot, Testville" }],
      }),
    );
    expect(h).toContain("3 lines on 2 stops");
  });

  it("omits the due date, and still prints, when the cycle has none", () => {
    // Breaks if: the template formats a null date.
    const h = header(sheet({ readsDueOn: null }));
    expect(h).not.toContain("reads due");
    expect(h).toContain("Cycle C-1");
    expect(h).toContain("sheet for 10 Jan 2026");
  });

  it("does not print the omitted stops on the paper", () => {
    // The paper stays the walk. Breaks if: the omitted list is rendered as rows.
    const s = sheet({ stopsWithNothingToRead: [{ sequence: 200, address: "9 Vacant Lot, Testville" }] });
    expect(rows(s)).toHaveLength(1);
    expect(text(RouteSheetTemplate({ sheet: s }))).not.toContain("Vacant Lot");
  });
});
