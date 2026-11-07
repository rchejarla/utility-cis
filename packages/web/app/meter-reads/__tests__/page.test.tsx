import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import MeterReadsPage from "../page";

/**
 * The read log.
 *
 * A reading and a consumption are quantities, and a quantity without
 * its unit is not a shorter truth — it is a different claim. The same
 * screen lists water in gallons and electricity in kilowatt hours, and
 * a column of bare numbers cannot be read across those rows at all. It
 * matters more since rating began converting: the tariff bills water in
 * HCF while the meter counts gallons, so "4958" here and "6.63" on the
 * bill are the same month, and only the units say so.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function read(over: Record<string, unknown> = {}) {
  return {
    id: "r-1",
    readDate: "2026-09-15",
    readDatetime: "2026-09-15T00:00:00.000Z",
    reading: "56572.0000",
    priorReading: "51614.0000",
    consumption: "4958.0000",
    readType: "ACTUAL",
    readSource: "AMR",
    exceptionCode: null,
    billedAt: null,
    meter: { meterNumber: "WM-001", commodityId: "c-water" },
    uom: { code: "GAL", name: "Gallons" },
    serviceAgreement: { agreementNumber: "SA-0001" },
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

function renderPage() {
  return render(
    <ToastProvider>
      <MeterReadsPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Meter reads — units", () => {
  it("names the unit the reading and consumption are counted in", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();

    expect(await screen.findByText("WM-001")).toBeInTheDocument();
    expect(screen.getByText("GAL")).toBeInTheDocument();
  });

  it("shows each row's own unit, since one log carries several commodities", async () => {
    get.mockResolvedValue(
      payload([
        read(),
        read({
          id: "r-2",
          meter: { meterNumber: "EM-002", commodityId: "c-electric" },
          uom: { code: "KWH", name: "Kilowatt Hours" },
          consumption: "936.0000",
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("GAL")).toBeInTheDocument();
    expect(screen.getByText("KWH")).toBeInTheDocument();
  });

  /*
   * A read whose unit the API did not send must not print "undefined"
   * into a column an operator reads as fact.
   */
  it("shows a dash rather than nothing when the unit is absent", async () => {
    get.mockResolvedValue(payload([read({ uom: null })]));
    renderPage();

    await screen.findByText("WM-001");
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });
});

/**
 * Finding a meter's reads among a utility's six figures a year.
 *
 * The screen had no search and no way to narrow by route or month —
 * only by *kind* of read, which does not help when a cycle's ten
 * thousand reads arrive in the same three days. Added 2026-11-07.
 */
describe("Meter reads — narrowing the list", () => {
  it("asks the API for the typed meter number", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();
    await screen.findByText("WM-001");

    await userEvent.type(screen.getByPlaceholderText(/meter or agreement/i), "WM-100");

    // The client takes the params as an object, not in the URL.
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/meter-reads",
        expect.objectContaining({ search: "WM-100" }),
      ),
    );
  });

  it("offers the cycles the tenant actually has, not a hard-coded list", async () => {
    get.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/v1/billing-cycles")) {
        return { data: [{ id: "c-1", cycleCode: "R01", name: "Route 1 - North District" }] };
      }
      return payload([read()]);
    });
    renderPage();
    await screen.findByText("WM-001");

    await userEvent.click(screen.getByRole("button", { name: /Cycle/ }));

    expect(await screen.findByText(/R01 — Route 1 - North District/)).toBeInTheDocument();
  });

  it("filters to one month, which is what a cycle reads in", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();
    await screen.findByText("WM-001");

    await userEvent.click(screen.getByRole("button", { name: /Month/ }));
    const months = screen.getAllByText(/^[A-Z][a-z]{2} 20\d\d$/);
    expect(months.length).toBeGreaterThan(1);
    await userEvent.click(months[0]!);

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/meter-reads",
        expect.objectContaining({ readMonth: expect.stringMatching(/^20\d\d-\d\d$/) }),
      ),
    );
  });
});

/**
 * The other three views of this data, behind one control.
 *
 * They were three always-visible buttons in their own row above the
 * filters — a third row of chrome on a screen whose job is the table.
 * Collapsed into a "Show me" menu at the right of the filter row
 * (2026-11-07).
 *
 * The risk the shape carries: everything else in that row filters the
 * table, and these three navigate away from it. So each item is a link
 * that says where it goes, and the menu is not styled as a pill.
 */
describe("Meter reads — the Show me menu", () => {
  it("does not spend a row on three buttons", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();
    await screen.findByText("WM-001");

    // Collapsed: the destinations are not on screen until asked for.
    expect(screen.queryByRole("link", { name: /Exception Queue/ })).not.toBeInTheDocument();
  });

  it("offers the three screens, as links", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();
    await screen.findByText("WM-001");

    await userEvent.click(screen.getByRole("button", { name: /show me/i }));

    expect(screen.getByRole("link", { name: /Exception Queue/ })).toHaveAttribute(
      "href",
      "/meter-reads/exceptions",
    );
    expect(screen.getByRole("link", { name: /Interval Coverage/ })).toHaveAttribute(
      "href",
      "/meter-reads/interval-coverage",
    );
    expect(screen.getByRole("link", { name: /Reading Progress/ })).toHaveAttribute(
      "href",
      "/meter-reads/progress",
    );
  });

  it("closes when the menu is dismissed", async () => {
    get.mockResolvedValue(payload([read()]));
    renderPage();
    await screen.findByText("WM-001");

    const trigger = screen.getByRole("button", { name: /show me/i });
    await userEvent.click(trigger);
    expect(screen.getByRole("link", { name: /Exception Queue/ })).toBeInTheDocument();

    await userEvent.click(trigger);
    expect(screen.queryByRole("link", { name: /Exception Queue/ })).not.toBeInTheDocument();
  });
});

/*
 * The menu is page-level navigation, so it has to survive the state
 * where the filter row does not: a tenant with no reads at all.
 *
 * That is when Reading Progress says the most — every service is
 * outstanding — and none of the three screens is in the sidebar, so
 * losing the menu there would leave them reachable only by URL.
 */
describe("Meter reads — an empty log", () => {
  it("still offers the other views when there are no reads yet", async () => {
    get.mockResolvedValue(payload([]));
    renderPage();

    /*
     * Wait for the empty state to settle before touching the menu.
     * While the list is still loading, the filter row renders — and
     * with it a `ShowMeMenu` that React unmounts when the empty branch
     * replaces it. A click on the loading one lands on a detached node
     * and does nothing, which is what this test caught first.
     */
    await screen.findByText(/No meter reads recorded/);
    await userEvent.click(screen.getByRole("button", { name: /show me/i }));

    expect(screen.getByRole("link", { name: /Reading Progress/ })).toBeInTheDocument();
  });
});

/**
 * The Exception column.
 *
 * It printed the raw enum, and `CONSECUTIVE_ESTIMATE` is twenty
 * characters of upper case with letter-spacing on top — wider than the
 * column, so `DataTable` clipped it with an ellipsis (every cell is
 * `nowrap` unless the column opts into `wrap`). Reported 2026-11-07.
 *
 * Widening the column or wrapping the badge would both be answers to
 * the wrong question: the cell was shouting a database constant at
 * somebody who wants to know what is wrong with the read. A short
 * sentence-case label fits and reads, and the code stays on hover for
 * whoever is grepping for it.
 */
describe("Meter reads — the exception column", () => {
  it("says what is wrong in words, not in an enum", async () => {
    get.mockResolvedValue(payload([read({ exceptionCode: "CONSECUTIVE_ESTIMATE" })]));
    renderPage();

    expect(await screen.findByText("Repeat estimate")).toBeInTheDocument();
    expect(screen.queryByText("CONSECUTIVE_ESTIMATE")).not.toBeInTheDocument();
  });

  it("keeps the code itself on hover, since that is what the API says", async () => {
    get.mockResolvedValue(payload([read({ exceptionCode: "CONSECUTIVE_ESTIMATE" })]));
    renderPage();

    expect(await screen.findByTitle("CONSECUTIVE_ESTIMATE")).toBeInTheDocument();
  });

  it("falls back to the raw value for a code it has no label for", async () => {
    // A code added to the API and not here must still show something
    // true rather than an empty cell.
    get.mockResolvedValue(payload([read({ exceptionCode: "SOMETHING_NEW" })]));
    renderPage();

    expect(await screen.findByText("SOMETHING_NEW")).toBeInTheDocument();
  });
});

/**
 * A TOU bucket has no dial reading.
 *
 * The roll-up writes `reading` and `priorReading` as null for an
 * interval-derived row — it is a *sum*, and inventing a cumulative
 * number would put a figure on the screen that matches nothing on the
 * device. The log declared both as plain `string` in its own
 * hand-written interface, so `Number(null)` printed **0.00**: a reading
 * of zero where there is no reading.
 *
 * Found by deriving the row type from the shared schema (2026-11-07),
 * which is nullable there because the column is.
 */
describe("Meter reads — a read with no dial reading", () => {
  it("shows a dash rather than 0.00", async () => {
    get.mockResolvedValue(
      payload([
        read({
          id: "r-tou",
          reading: null,
          priorReading: null,
          consumption: "140.0000",
          readSource: "AMI",
        }),
      ]),
    );
    renderPage();

    await screen.findByText("WM-001");
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    // The consumption is still a number: that is the figure the row
    // exists to carry, and it is NOT NULL in the database.
    expect(screen.getByText("140.00")).toBeInTheDocument();
  });
});
