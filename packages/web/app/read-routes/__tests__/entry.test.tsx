import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ReadRouteEntryPage from "../[id]/entry/page";

/**
 * /read-routes/:id/entry — typing the sheet in (spec 30, §5.7).
 *
 * The screen **is** the sheet, so its shape is not a choice: rows in
 * walking order, one number per line, the last reading beside each so
 * the typist can see what they are comparing against. What it adds over
 * paper is three things paper cannot do, and all three are what these
 * tests are about.
 *
 * - **It saves as it goes.** Nothing posts to `meter_read` until the
 *   route is submitted — a half-typed sheet is not a reading event — but
 *   each line is staged server-side the moment it is left, so closing
 *   the tab at stop 40 does not lose 39 numbers.
 * - **It holds a wild number.** The band is the meter's own recent
 *   consumption (§5.7, provisional until Req 93). A held row is a
 *   question, never a refusal: the reading may well be right, and a
 *   confirmed one goes through.
 * - **It never needs the mouse.** `Enter` saves the line and moves down.
 *   A reader dictating forty numbers to a clerk cannot wait for anybody
 *   to find a button.
 *
 * **A line is not a stop.** A meter with two registers is two lines at
 * one address, and two meters at one address are two more — so nothing
 * in a row is unique text and the rows are addressed by
 * `data-testid="entry-row-<rowIndex>"`, the 1-based index `openEntry`
 * returns. That attribute is a contract with the Playwright spec.
 */

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "rt-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/read-routes/rt-1/entry",
  useSearchParams: () => new URLSearchParams("date=2026-06-05"),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

const ROUTE = {
  id: "rt-1",
  code: "W-04",
  name: "North Willson",
  billingCycleId: "cyc-1",
  origin: "LOCAL",
  active: true,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  stopCount: 2,
  cycleCode: "C-01",
};

/** Trailing consumption 28–32, so the band is +14 to +64 on 1090. */
const BAND = { low: "1104", high: "1154", typicalLow: "28", typicalHigh: "32" };

function row(over: Record<string, unknown> = {}) {
  return {
    rowId: "row-1",
    rowIndex: 1,
    sequence: 100,
    premiseId: "p-1",
    address: "412 N Willson Ave, Bozeman",
    meterId: "m-1",
    meterNumber: "WM-101",
    registerId: null,
    registerNumber: null,
    accountNumber: "ACCT-1",
    lastReading: "1090",
    lastReadDate: "2026-04-03",
    band: BAND,
    reading: null,
    skipReason: null,
    notes: null,
    status: "PENDING",
    errorCode: null,
    errorMessage: null,
    ...over,
  };
}

const SECOND = row({
  rowId: "row-2",
  rowIndex: 2,
  sequence: 200,
  premiseId: "p-2",
  address: "508 N Willson Ave, Bozeman",
  meterId: "m-2",
  meterNumber: "WM-102",
  lastReading: "2000",
  band: null,
});

const TWO_ROWS = [row(), SECOND];

const SHEET = {
  routeCode: "W-04",
  routeName: "North Willson",
  cycleCode: "C-01",
  readsDueOn: "2026-06-01",
  forDate: "2026-06-05",
  stops: [],
  stopsWithNothingToRead: [],
};

interface Served {
  rows?: unknown[];
  route?: Record<string, unknown>;
  sheet?: Record<string, unknown>;
  submit?: Record<string, unknown>;
}

function serve({ rows = TWO_ROWS, route = ROUTE, sheet = SHEET, submit }: Served = {}) {
  get.mockImplementation(async (url: string) => {
    if (url.includes("/sheet")) return sheet;
    return route;
  });
  post.mockImplementation(async (url: string) => {
    if (url.includes("/submit")) {
      return (
        submit ?? {
          batchId: "b-1",
          status: "COMPLETE",
          importedCount: rows.length,
          errorCount: 0,
          skipsRecorded: 0,
          notEntered: 0,
          alreadySubmitted: false,
        }
      );
    }
    return { batchId: "b-1", rows };
  });
  patch.mockImplementation(async (_url: string, body: Record<string, unknown>) => {
    const base = String(body.meterId) === "m-1" ? row() : SECOND;
    return {
      ...base,
      reading: body.reading === undefined ? null : String(body.reading),
      skipReason: (body.skipReason as string) ?? null,
      notes: (body.notes as string) ?? null,
    };
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <ReadRouteEntryPage />
    </ToastProvider>,
  );
}

/** Every reading field, in walking order. The only spinbuttons on the page. */
const inputs = () => screen.findAllByRole("spinbutton");
const entryRows = () => screen.findAllByTestId(/^entry-row-\d+$/);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Read route entry — the sheet on screen", () => {
  it("lists the stops in sequence with the last reading beside each", async () => {
    serve();
    renderPage();

    const rows = await entryRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/412 N Willson Ave/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/1,090/)).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/2026-04-03/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/508 N Willson Ave/)).toBeInTheDocument();
  });

  it("addresses each row by the index openEntry gave it", async () => {
    serve();
    renderPage();

    await entryRows();
    expect(screen.getByTestId("entry-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("entry-row-2")).toBeInTheDocument();
  });

  it("opens one batch for the route and the day in the URL", async () => {
    serve();
    renderPage();

    await entryRows();
    expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry", {
      readDate: "2026-06-05",
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("names the register on a multi-register meter, so two rows do not read alike", async () => {
    serve({
      rows: [
        row({ registerId: "r-1", registerNumber: "1" }),
        row({ rowId: "row-2", rowIndex: 2, registerId: "r-2", registerNumber: "2", band: null }),
      ],
    });
    renderPage();

    const rows = await entryRows();
    expect(within(rows[0]!).getByText(/reg 1/i)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/reg 2/i)).toBeInTheDocument();
  });

  it("says a meter has never been read rather than leaving the column blank", async () => {
    serve({ rows: [row({ lastReading: null, lastReadDate: null, band: null })] });
    renderPage();

    const rows = await entryRows();
    expect(within(rows[0]!).getByText(/never read/i)).toBeInTheDocument();
  });

  /*
   * A stop whose premise has no readable meter produces no line, and a
   * sheet with 8 lines for 9 stops is the silent failure §5.1 forbids.
   * `buildRouteSheet` returns those stops separately; the screen says so
   * rather than letting the typist wonder.
   */
  it("names the stops that produced no line at all", async () => {
    serve({
      sheet: {
        ...SHEET,
        stopsWithNothingToRead: [{ sequence: 400, address: "22 Closed Service Rd, Bozeman" }],
      },
    });
    renderPage();

    await entryRows();
    expect(await screen.findByText(/22 Closed Service Rd/)).toBeInTheDocument();
    expect(screen.getByText(/nothing to read/i)).toBeInTheDocument();
  });
});

describe("Read route entry — the keyboard", () => {
  it("moves to the next row on Enter and saves the one left behind", async () => {
    serve();
    renderPage();

    const [first, second] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
        reading: 1120,
      }),
    );
    expect(second).toHaveFocus();
  });

  it("saves nothing for a row left blank, and still moves on", async () => {
    serve();
    renderPage();

    const [first, second] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("{Enter}");

    expect(second).toHaveFocus();
    expect(patch).not.toHaveBeenCalled();
  });

  it("stays on the last row rather than wrapping to the top", async () => {
    serve();
    renderPage();

    const all = await inputs();
    await userEvent.click(all[1]!);
    await userEvent.keyboard("2030{Enter}");

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(all[1]!).toHaveFocus();
  });
});

/**
 * §5.7's provisional band. A hold is a **question**, not a refusal: a
 * filled pool and a burst pipe both produce a true number well outside
 * what the meter has done before, and a rule this provisional must not
 * be able to stop one reaching the bill.
 */
describe("Read route entry — a number that looks wrong", () => {
  it("holds the row when the reading is outside the meter's own history", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");

    expect(await screen.findByText(/that looks wrong/i)).toBeInTheDocument();
    // Nothing staged, and the focus has not moved on.
    expect(patch).not.toHaveBeenCalled();
    expect(first).toHaveFocus();
  });

  it("says what the meter usually does, which is the whole point of holding it", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");

    const held = await screen.findByTestId("held-row-1");
    // The consumption this number implies, against the range the meter
    // has actually used.
    expect(within(held).getByText(/7,910/)).toBeInTheDocument();
    expect(within(held).getByText(/28/)).toBeInTheDocument();
    expect(within(held).getByText(/32/)).toBeInTheDocument();
  });

  it("lets a confirmed outlier through", async () => {
    serve();
    renderPage();

    const [first, second] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");
    await screen.findByText(/that looks wrong/i);

    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
        reading: 9000,
      }),
    );
    expect(second).toHaveFocus();
  });

  it("holds a reading below the last one, which is a dial that has gone backwards", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("900{Enter}");

    expect(await screen.findByText(/below the last reading/i)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("re-holds a changed number rather than taking the previous confirmation for it", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");
    await screen.findByText(/that looks wrong/i);

    // Corrected to a different wild number: the confirmation was for
    // 9000, not for whatever is typed next.
    await userEvent.clear(first!);
    await userEvent.keyboard("8000{Enter}");

    expect(patch).not.toHaveBeenCalled();
    expect(await screen.findByText(/that looks wrong/i)).toBeInTheDocument();
  });

  it("does not hold a row on a meter with too little history to judge one", async () => {
    serve();
    renderPage();

    const all = await inputs();
    await userEvent.click(all[1]!);
    await userEvent.keyboard("9999{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-2",
        registerId: null,
        reading: 9999,
      }),
    );
    expect(screen.queryByText(/that looks wrong/i)).not.toBeInTheDocument();
  });
});

/*
 * `saveEntryRow` refuses a reading behind a posted bill with 400
 * `READ_BILLED` — at the keyboard, not at submit, because that is where
 * it can still be corrected. The refusal has to land in the row it is
 * about: a toast names no row on a sheet of forty.
 */
describe("Read route entry — a refusal from the server", () => {
  it("shows the refusal in the row it is about", async () => {
    serve();
    patch.mockRejectedValue(
      new Error(
        "API error 400: Meter m-1 already has a billed read in this period; a new read cannot be entered behind a posted bill",
      ),
    );
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");

    const refused = await screen.findByTestId("entry-row-1");
    expect(within(refused).getByText(/already has a billed read/i)).toBeInTheDocument();
  });

  it("clears the refusal once the row saves", async () => {
    serve();
    patch.mockRejectedValueOnce(new Error("API error 400: already has a billed read"));
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");
    await screen.findByText(/already has a billed read/i);

    await userEvent.click(first!);
    await userEvent.keyboard("{Enter}");
    await userEvent.click(first!);
    await userEvent.clear(first!);
    await userEvent.keyboard("1121{Enter}");

    await waitFor(() =>
      expect(screen.queryByText(/already has a billed read/i)).not.toBeInTheDocument(),
    );
  });
});

describe("Read route entry — a stop that produced no number", () => {
  it("moves past a stop with a skip reason and no number", async () => {
    serve();
    renderPage();

    const rows = await entryRows();
    await userEvent.selectOptions(
      within(rows[0]!).getByRole("combobox", { name: /why/i }),
      "LOCKED_GATE",
    );

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
        skipReason: "LOCKED_GATE",
      }),
    );
    const [, second] = await inputs();
    expect(second).toHaveFocus();
  });

  it("offers the seven reasons in words, not as database constants", async () => {
    serve();
    renderPage();

    const rows = await entryRows();
    const picker = within(rows[0]!).getByRole("combobox", { name: /why/i });

    expect(within(picker).getByRole("option", { name: "Locked gate" })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Appears vacant" })).toBeInTheDocument();
    // Seven reasons plus the empty choice.
    expect(within(picker).getAllByRole("option")).toHaveLength(8);
  });

  /*
   * The note is offered only once a reason is chosen. A sheet of forty
   * rows each carrying an always-visible note field is forty controls
   * nobody uses, and the reading field has to stay the only number on
   * the row.
   */
  it("takes a note beside the reason, which is where the detail goes", async () => {
    serve({ rows: [row({ skipReason: "DOG" }), SECOND] });
    renderPage();

    const rows = await entryRows();
    const note = within(rows[0]!).getByPlaceholderText(/note/i);
    await userEvent.type(note, "Loose in the yard{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
        skipReason: "DOG",
        notes: "Loose in the yard",
      }),
    );
  });

  it("offers no note on a row with no reason on it", async () => {
    serve();
    renderPage();

    const rows = await entryRows();
    expect(within(rows[0]!).queryByPlaceholderText(/note/i)).not.toBeInTheDocument();
  });

  it("clears a reason when a reading is typed over it, since a row is one or the other", async () => {
    serve({ rows: [row({ skipReason: "DOG" }), SECOND] });
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
        reading: 1120,
      }),
    );
  });
});

describe("Read route entry — posting the route", () => {
  it("shows progress as entered-of-total", async () => {
    serve();
    renderPage();

    await entryRows();
    expect(screen.getByText(/0 of 2/)).toBeInTheDocument();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");

    expect(await screen.findByText(/1 of 2/)).toBeInTheDocument();
  });

  it("warns that the rows nobody typed anything for will be left out", async () => {
    serve();
    renderPage();

    await entryRows();
    expect(screen.getByText(/2 rows have nothing entered/i)).toBeInTheDocument();
  });

  it("submits once and reports what posted", async () => {
    serve();
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/submit", {}),
    );
    expect(await screen.findByText(/2 readings posted/i)).toBeInTheDocument();
    // Posted once: the button is gone rather than inviting a second.
    expect(screen.queryByRole("button", { name: /post the route/i })).not.toBeInTheDocument();
  });

  it("reports the rows the post refused, and what each one said", async () => {
    serve({
      rows: [
        row({
          reading: "1120",
          status: "ERROR",
          errorCode: "METER_ALREADY_READ",
          errorMessage: "The meter already has a read in this window",
        }),
        row({ rowId: "row-2", rowIndex: 2, meterId: "m-2", reading: "2030", status: "IMPORTED" }),
      ],
      submit: {
        batchId: "b-1",
        status: "PARTIAL",
        importedCount: 1,
        errorCount: 1,
        skipsRecorded: 0,
        notEntered: 0,
        alreadySubmitted: false,
      },
    });
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));

    expect(await screen.findByText(/1 refused/i)).toBeInTheDocument();
    const refused = screen.getByTestId("entry-row-1");
    expect(within(refused).getByText(/already has a read/i)).toBeInTheDocument();
  });

  it("reports the skips it recorded as well as the readings", async () => {
    serve({
      submit: {
        batchId: "b-1",
        status: "COMPLETE",
        importedCount: 1,
        errorCount: 0,
        skipsRecorded: 1,
        notEntered: 0,
        alreadySubmitted: false,
      },
    });
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));

    expect(await screen.findByText(/1 skip recorded/i)).toBeInTheDocument();
  });

  /*
   * One rejected row on a 48-stop route must not mean retyping the
   * route. `reopenEntryForCorrections` takes the ERROR rows back to
   * PENDING and leaves the posted ones exactly as they are, which is
   * also what stops the second submit re-posting them.
   */
  it("offers to correct the refused rows rather than retype the route", async () => {
    serve({
      rows: [
        row({ reading: "1120", status: "ERROR", errorCode: "READ_BILLED", errorMessage: "Billed" }),
      ],
      submit: {
        batchId: "b-1",
        status: "PARTIAL",
        importedCount: 0,
        errorCount: 1,
        skipsRecorded: 0,
        notEntered: 0,
        alreadySubmitted: false,
      },
    });
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));
    await screen.findByText(/1 refused/i);

    await userEvent.click(screen.getByRole("button", { name: /correct the refused/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/reopen", {
        readDate: "2026-06-05",
      }),
    );
  });

  it("offers no correction when the sheet posted cleanly, which the server refuses anyway", async () => {
    serve();
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));
    await screen.findByText(/2 readings posted/i);

    expect(screen.queryByRole("button", { name: /correct the refused/i })).not.toBeInTheDocument();
  });
});

/**
 * An EXTERNAL route has nothing to type in: `openEntry` refuses one
 * outright (400 `ROUTE_IS_EXTERNAL`), so the page says so itself rather
 * than showing an operator a server error for a route behaving exactly
 * as designed.
 */
describe("Read route entry — a route a vendor owns", () => {
  it("says there is nothing to enter instead of opening a batch", async () => {
    serve({ rows: [], route: { ...ROUTE, origin: "EXTERNAL", code: "VEN-7", name: "VEN-7" } });
    renderPage();

    expect(await screen.findByText(/nothing to enter/i)).toBeInTheDocument();
    const asked = post.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(asked.some((url) => url.includes("/entry"))).toBe(false);
  });
});
