import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/** Trailing consumption 28–32, typically 30, so the band is +15 to +60 on 1090. */
const BAND = { low: "1105", high: "1150", typical: "30", typicalLow: "28", typicalHigh: "32" };

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
    isDemand: false,
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

  /*
   * Deleting a staged number is an edit, and the only gesture available
   * for it: there is no blur handler on the reading field, and the
   * obscure workaround (pick a reason, then pick "—") writes and unwrites
   * a skip to get there. Without this, the number stays in `raw_data` and
   * Post writes the reading the operator can see they deleted.
   */
  it("clears the staged number on the server when the field is emptied", async () => {
    serve({ rows: [row({ reading: "1120" }), SECOND] });
    renderPage();

    const [first, second] = await inputs();
    await userEvent.clear(first!);
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: null,
      }),
    );
    expect(second).toHaveFocus();
  });

  /*
   * The other side of it: a coded row's reading field is empty because
   * the row is a code, so Enter passing through must not clear the reason
   * somebody chose. An empty body clears both.
   */
  it("leaves a coded row's reason alone when Enter passes through its empty field", async () => {
    serve({ rows: [row({ skipReason: "DOG" }), SECOND] });
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
    // What it typically uses, which is what the bound is built from, and
    // the observed range either side of it. Naming only the range would
    // leave a hold the range cannot explain — 300 on a meter that has
    // seen 28 and 500 is held, and "it has used between 28 and 500"
    // reads as an argument for letting it through.
    expect(within(held).getByText("30")).toBeInTheDocument();
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

  /*
   * A held row is the one case where Enter does not advance, so it is
   * also the one case where a typist's "number, Enter" rhythm leaves the
   * key down or taps it twice. Key-repeat is never a confirmation: the
   * browser fires repeat keydowns while the key is physically held, and
   * taking one as the answer to "that looks wrong" posts the wild number
   * without anybody reading the question.
   */
  it("does not take a held-down Enter as the confirmation", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");
    await screen.findByText(/that looks wrong/i);

    fireEvent.keyDown(first!, { key: "Enter", repeat: true });

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText(/that looks wrong/i)).toBeInTheDocument();
  });

  /*
   * And a target that is not a keystroke at all, for the hold only. The
   * keyboard stays the whole interface for entry (§5.7) — this is the one
   * place the screen asks a question, and a question deserves something
   * to click.
   */
  it("takes the number as typed when the hold's own button is used", async () => {
    serve();
    renderPage();

    const [first, second] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("9000{Enter}");
    const held = await screen.findByTestId("held-row-1");

    await userEvent.click(within(held).getByRole("button", { name: /as typed/i }));

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
 * A demand register (spec 31, DEM-RD-1) shows the period's peak and is
 * reset when read. A lower month than the last is ordinary, and the band
 * sits around the typical peak — the API sends it as values, not as
 * "last reading plus a month's use".
 */
describe("Read route entry — a demand register", () => {
  /** Peaks of 290–330 kW, typically 310: held below 155 or above 620. */
  const DEMAND = row({
    registerId: "r-2",
    registerNumber: "2",
    isDemand: true,
    lastReading: "310",
    band: { low: "155", high: "620", typical: "310", typicalLow: "290", typicalHigh: "330" },
  });

  it("takes a peak below last month's without asking about a dial going backwards", async () => {
    serve({ rows: [DEMAND] });
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("295{Enter}");

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/b-1/rows", {
        meterId: "m-1",
        registerId: "r-2",
        reading: 295,
      }),
    );
    expect(screen.queryByText(/below the last reading/i)).not.toBeInTheDocument();
  });

  it("holds a wild peak, and says so in terms of peaks rather than use", async () => {
    serve({ rows: [DEMAND] });
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("3100{Enter}");

    const held = await screen.findByTestId("held-row-1");
    expect(held).toHaveTextContent(/usual peak of about 310/i);
    expect(held).not.toHaveTextContent(/of use since/i);
    expect(patch).not.toHaveBeenCalled();
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

  /*
   * A number typed and never committed with Enter posted as "nothing
   * entered", and the result never said which number was lost. Post now
   * waits for it and names the meter; Enter saves it and frees Post.
   */
  it("holds Post while a typed number is unsaved, and names the meter", async () => {
    serve();
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120"); // typed, not Entered

    const post = screen.getByRole("button", { name: /post the route/i });
    expect(post).toBeDisabled();
    expect(screen.getByTestId("unsaved-rows")).toHaveTextContent(/WM-101/);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByRole("button", { name: /post the route/i })).toBeEnabled());
    expect(screen.queryByTestId("unsaved-rows")).toBeNull();
  });

  /*
   * A number the server refused (READ_BILLED at the keyboard) is not a
   * forgotten one: the row says why, Enter cannot save it, and it posts as
   * nothing entered on purpose. Blocking Post on it would leave the sheet
   * unpostable — which is what the e2e journey hit.
   */
  it("does not hold Post for a number the server refused", async () => {
    serve();
    patch.mockRejectedValue(new Error("The meter already has a billed read in this period"));
    renderPage();

    const [first] = await inputs();
    await userEvent.click(first!);
    await userEvent.keyboard("1120{Enter}");

    expect(await screen.findByText(/already has a billed read/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /post the route/i })).toBeEnabled();
    expect(screen.queryByTestId("unsaved-rows")).toBeNull();
  });

  /*
   * A sheet that posted cleanly but left rows out can be reopened for
   * them — the server returns NOT_ENTERED rows to PENDING since
   * 2026-11-27 — so the screen offers it, under a name that says what.
   */
  it("offers to enter the rows left out when nothing was refused", async () => {
    serve({
      rows: [row({ status: "SKIPPED", errorCode: "NOT_ENTERED" })],
      submit: {
        batchId: "b-1",
        status: "COMPLETE",
        importedCount: 0,
        errorCount: 0,
        skipsRecorded: 0,
        notEntered: 1,
        alreadySubmitted: false,
      },
    });
    renderPage();
    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));

    await userEvent.click(await screen.findByRole("button", { name: /enter the rows left out/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/read-routes/rt-1/entry/reopen", {
        readDate: "2026-06-05",
      }),
    );
  });

  /*
   * An empty "nothing to read" list reads as "every stop has something",
   * which is the silent failure §5.1 forbids — so a failure to load it is
   * said, not swallowed.
   */
  it("says so when it cannot check which stops have nothing to read", async () => {
    serve();
    get.mockImplementation(async (url: string) => {
      if (url.includes("/sheet")) throw new Error("Network error");
      return ROUTE;
    });
    renderPage();
    await entryRows();

    expect(await screen.findByText(/could not check which stops/i)).toBeInTheDocument();
  });

  /*
   * The reopen's answer replaces every row and every typed value, so a
   * number typed while it was in flight was wiped when it landed — Enter
   * then saved nothing and the next Post refused the stop again. The e2e
   * journey lost that race. The fields stay shut until the answer is in.
   */
  it("keeps the fields shut while the reopen is in flight, so nothing typed is wiped", async () => {
    const refused = row({ reading: "1120", status: "ERROR", errorCode: "READ_BILLED", errorMessage: "Billed" });
    serve({
      rows: [refused],
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
    let answer!: (v: unknown) => void;
    const base = post.getMockImplementation()!;
    post.mockImplementation(async (url: string, body: unknown) => {
      if (url.endsWith("/entry/reopen")) return new Promise((r) => (answer = r));
      return base(url, body);
    });
    renderPage();
    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));
    await screen.findByText(/1 refused/i);

    await userEvent.click(screen.getByRole("button", { name: /correct the refused/i }));

    const [field] = await inputs();
    await waitFor(() => expect(field).toBeDisabled());
    answer({ batchId: "b-1", rows: [{ ...refused, status: "PENDING", errorCode: null, errorMessage: null }] });
    await waitFor(() => expect(field).toBeEnabled());
  });

  /*
   * The post succeeded; reading the outcomes back did not. Those are two
   * requests, and the first one wrote `meter_read` rows — so telling the
   * operator the post failed is the one answer that is certainly wrong,
   * and it took the result banner and the whole sheet off the screen with
   * it.
   */
  it("keeps the result when reading the outcomes back fails, rather than calling the post a failure", async () => {
    serve();
    let opens = 0;
    post.mockImplementation(async (url: string) => {
      if (url.includes("/submit")) {
        return {
          batchId: "b-1",
          status: "COMPLETE",
          importedCount: 2,
          errorCount: 0,
          skipsRecorded: 0,
          notEntered: 0,
          alreadySubmitted: false,
        };
      }
      if (++opens > 1) throw new Error("Network error");
      return { batchId: "b-1", rows: TWO_ROWS };
    });
    renderPage();

    await entryRows();
    await userEvent.click(screen.getByRole("button", { name: /post the route/i }));

    expect(await screen.findByText(/2 readings posted/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not post this route/i)).not.toBeInTheDocument();
    // The sheet is still there to look at, not replaced by an error page.
    expect(await entryRows()).toHaveLength(2);
  });

  /*
   * After a reopen the batch is PENDING again, but only the rows that
   * were refused are: `processBatch` runs the PENDING rows and nothing
   * else, so a correction typed into a row that already posted is
   * accepted by `saveEntryRow`, never reprocessed, and leaves the staged
   * row disagreeing with the `meter_read` that exists.
   */
  it("does not invite a correction to a row that already posted", async () => {
    serve({
      rows: [
        row({ reading: "1120", status: "PENDING" }),
        row({ rowId: "row-2", rowIndex: 2, meterId: "m-2", reading: "2030", status: "IMPORTED" }),
      ],
    });
    renderPage();

    const [refused, already] = await inputs();
    expect(refused).toBeEnabled();
    expect(already).toBeDisabled();
    expect(within(screen.getByTestId("entry-row-2")).getByText(/posted/i)).toBeInTheDocument();
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
