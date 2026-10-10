import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataTable, type Column } from "../data-table";

/**
 * `hideBelow` and the breakpoint it is read at.
 *
 * The behaviour worth pinning is that ONE derived list feeds the header,
 * the body, the skeleton and the empty row's colSpan. The approach this
 * replaces put a class on each cell by hand, where hiding a `<th>` and
 * forgetting its `<td>` slid every later cell under the wrong heading.
 * A single source cannot produce that, and these cases prove the single
 * source is actually used in all four places.
 */

/** Drive `useBreakpoint`, which reads window.matchMedia. */
function atWidth(kind: "phone" | "tablet" | "desktop") {
  const matchesFor = (q: string) => {
    if (q.includes("max-width: 767px")) return kind === "phone";
    if (q.includes("min-width: 768px")) return kind === "tablet";
    if (q.includes("min-width: 1200px")) return kind === "desktop";
    return false;
  };
  (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (query: string) => ({
      matches: matchesFor(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

interface Bill extends Record<string, unknown> {
  billNumber: string;
  account: string;
  period: string;
  total: string;
  stillOwed: string;
}

const COLUMNS: Column<Bill>[] = [
  { key: "billNumber", header: "Bill #" },
  { key: "account", header: "Account", hideBelow: "tablet" },
  { key: "period", header: "Period", hideBelow: "desktop" },
  { key: "total", header: "Total", hideBelow: "tablet" },
  { key: "stillOwed", header: "Still owed" },
];

const ROW: Bill = {
  billNumber: "BILL-0001",
  account: "0001000-00",
  period: "Jun 2026",
  total: "$64.20",
  stillOwed: "$15.00",
};

const headers = () => screen.queryAllByRole("columnheader").map((h) => h.textContent?.trim());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DataTable — hideBelow", () => {
  it("shows every column on desktop", () => {
    atWidth("desktop");
    render(<DataTable columns={COLUMNS} data={[ROW]} />);
    expect(headers()).toEqual(["Bill #", "Account", "Period", "Total", "Still owed"]);
  });

  it("drops desktop-only columns on a tablet", () => {
    atWidth("tablet");
    render(<DataTable columns={COLUMNS} data={[ROW]} />);
    // Period is hideBelow desktop; the two hideBelow tablet columns stay.
    expect(headers()).toEqual(["Bill #", "Account", "Total", "Still owed"]);
  });

  it("keeps header and body in step, so no cell reads under the wrong heading", () => {
    atWidth("tablet");
    const { container } = render(<DataTable columns={COLUMNS} data={[ROW]} />);
    const heads = container.querySelectorAll("thead th").length;
    const cells = container.querySelectorAll("tbody tr:first-child td").length;
    expect(cells).toBe(heads);
    // And the hidden column's value is genuinely gone, not merely unstyled.
    expect(screen.queryByText("Jun 2026")).toBeNull();
    expect(screen.getByText("$64.20")).toBeInTheDocument();
  });

  it("gives the empty row a colSpan matching the visible columns", () => {
    atWidth("tablet");
    const { container } = render(<DataTable columns={COLUMNS} data={[]} />);
    const cell = container.querySelector("tbody td[colspan]");
    expect(cell?.getAttribute("colspan")).toBe("4");
  });

  it("sizes the loading skeleton to the visible columns", () => {
    atWidth("tablet");
    const { container } = render(<DataTable columns={COLUMNS} data={[]} loading />);
    const firstRowCells = container.querySelectorAll("tbody tr:first-child td").length;
    expect(firstRowCells).toBe(4);
  });
});

describe("DataTable — the phone card", () => {
  it("shows the columns the author kept, not the first four", () => {
    atWidth("phone");
    render(<DataTable columns={COLUMNS} data={[ROW]} />);

    // Declared: Bill # and Still owed survive a phone.
    expect(screen.getByText("Bill #")).toBeInTheDocument();
    expect(screen.getByText("Still owed")).toBeInTheDocument();
    expect(screen.getByText("$15.00")).toBeInTheDocument();

    // Position alone would have kept Account, Period and Total -- and
    // dropped Still owed, which is the one figure the card exists for.
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.queryByText("Period")).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("falls back to the first four columns when no column declares anything", () => {
    // Every existing caller is in this state, so none of them may move.
    atWidth("phone");
    const plain: Column<Bill>[] = COLUMNS.map(({ hideBelow: _drop, ...c }) => c);
    render(<DataTable columns={plain} data={[ROW]} />);

    expect(screen.getByText("Bill #")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Period")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    // The fifth is cut by the old slice(0, 4), which is the prior behaviour.
    expect(screen.queryByText("Still owed")).toBeNull();
  });

  it("renders every column on a phone when a table hides nothing below tablet", () => {
    atWidth("phone");
    const narrow: Column<Bill>[] = [
      { key: "billNumber", header: "Bill #" },
      { key: "stillOwed", header: "Still owed" },
      { key: "period", header: "Period", hideBelow: "desktop" },
    ];
    render(<DataTable columns={narrow} data={[ROW]} />);
    expect(screen.getByText("Bill #")).toBeInTheDocument();
    expect(screen.getByText("Still owed")).toBeInTheDocument();
    // Declared desktop-only, so it is absent from a phone as well.
    expect(screen.queryByText("Period")).toBeNull();
  });
});
