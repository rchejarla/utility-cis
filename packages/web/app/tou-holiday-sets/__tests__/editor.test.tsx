import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import TouHolidaySetEditorPage from "../[id]/page";

/**
 * The holiday set editor (spec 26, TOU-CAL-4).
 *
 * What is being tested is mostly the things a list of dates cannot say
 * about itself: which weekday each one falls on, that the set has run
 * out, and who it reaches. The dates themselves are a table.
 *
 * `useParams` again: the global `next/navigation` stub does not provide
 * it, and a factory replaces the module whole, so the whole thing is
 * restated.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "hset-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/tou-holiday-sets/hset-1",
  useSearchParams: () => new URLSearchParams(),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

/**
 * Far enough ahead to stay ahead. A fixture dated in a year that has
 * since passed would trip the "ran out" warning and quietly change what
 * half these tests are asserting.
 */
const AHEAD = `${new Date().getUTCFullYear() + 2}`;

function holidaySet(over: Record<string, unknown> = {}) {
  return {
    id: "hset-1",
    name: "Observed holidays",
    effectiveDate: "2026-01-01",
    publishedAt: null,
    holidays: [
      { id: "h-1", holidayDate: `${AHEAD}-01-01T00:00:00.000Z`, name: "New Year's Day" },
      { id: "h-2", holidayDate: `${AHEAD}-07-03T00:00:00.000Z`, name: "Independence Day (observed)" },
      { id: "h-3", holidayDate: `${AHEAD}-12-25T00:00:00.000Z`, name: "Christmas Day" },
      { id: "h-4", holidayDate: `${AHEAD}-11-26T00:00:00.000Z`, name: "Thanksgiving Day" },
    ],
    calendars: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(holidaySet());
});

const renderPage = () => render(<TouHolidaySetEditorPage />);

describe("reading a set", () => {
  it("shows its name, when it comes into force and how many dates are in it", async () => {
    renderPage();
    expect(await screen.findByText("Observed holidays")).toBeInTheDocument();
    expect(screen.getByText(/In force from 2026-01-01/)).toBeInTheDocument();
    expect(screen.getByText(/4 dates/)).toBeInTheDocument();
  });

  it("names the weekday beside each date, which is the whole reason they are typed", async () => {
    /*
     * A holiday moves. "Fri" next to 3 July is what tells somebody the
     * observance has already been applied — and "Sat" is what tells
     * them it has not.
     */
    /*
     * A fixed date, not `AHEAD`: the other fixtures use a year two
     * ahead of the clock so the horizon warnings stay quiet, and a
     * moving year has a moving weekday. 3 July 2026 is the Friday the
     * Saturday 4th is observed on, which is the case worth naming.
     */
    get.mockResolvedValue(
      holidaySet({
        holidays: [
          { id: "h-1", holidayDate: "2026-07-03T00:00:00.000Z", name: "Independence Day (observed)" },
        ],
      }),
    );
    renderPage();
    await screen.findByText("Observed holidays");
    const row = screen.getByDisplayValue("Independence Day (observed)").closest("tr");
    expect(row?.textContent).toMatch(/Friday/);
  });

  it("says a set with no dates cannot be published", async () => {
    get.mockResolvedValue(holidaySet({ holidays: [] }));
    renderPage();
    const empty = await screen.findByTestId("no-dates");
    expect(empty.textContent).toMatch(/appear to observe holidays/);
  });
});

describe("the horizon", () => {
  it("says so when every date is behind us", async () => {
    get.mockResolvedValue(
      holidaySet({
        holidays: [{ id: "h-1", holidayDate: "2020-07-03T00:00:00.000Z", name: "Old one" }],
      }),
    );
    renderPage();
    const warning = await screen.findByTestId("set-ran-out");
    expect(warning.textContent).toMatch(/2020-07-03/);
    expect(warning.textContent).toMatch(/no day as a holiday/);
  });

  it("warns while a few are left, which is when a new version can still be made", async () => {
    get.mockResolvedValue(
      holidaySet({
        holidays: [
          { id: "h-1", holidayDate: "2020-01-01T00:00:00.000Z", name: "Long gone" },
          { id: "h-2", holidayDate: `${AHEAD}-12-25T00:00:00.000Z`, name: "Christmas Day" },
        ],
      }),
    );
    renderPage();
    const warning = await screen.findByTestId("set-running-out");
    expect(warning.textContent).toMatch(/1 date is still ahead/);
  });

  it("stays quiet when the set has a real horizon", async () => {
    renderPage();
    await screen.findByText("Observed holidays");
    expect(screen.queryByTestId("set-ran-out")).toBeNull();
    expect(screen.queryByTestId("set-running-out")).toBeNull();
  });
});

describe("editing the dates", () => {
  it("sends the whole list, because a set is one answer to which days are holidays", async () => {
    put.mockResolvedValue(holidaySet());
    renderPage();
    await screen.findByText("Observed holidays");

    await userEvent.click(screen.getAllByRole("button", { name: "Remove this date" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Save dates" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, payload] = put.mock.calls[0];
    expect(url).toBe("/api/v1/tou-holiday-sets/hset-1/holidays");
    expect((payload as { holidays: unknown[] }).holidays).toHaveLength(3);
  });

  it("keeps Save unavailable until something changes", async () => {
    renderPage();
    await screen.findByText("Observed holidays");
    expect(screen.getByRole("button", { name: "Save dates" })).toBeDisabled();
  });

  it("will not save a row with no date or no name", async () => {
    renderPage();
    await screen.findByText("Observed holidays");

    await userEvent.click(screen.getByRole("button", { name: "Add a date" }));

    expect(screen.getByRole("button", { name: "Save dates" })).toBeDisabled();
    expect(screen.getByTestId("dates-incomplete").textContent).toMatch(/Row 5/);
    expect(put).not.toHaveBeenCalled();
  });

  it("holds a date listed twice, rather than spending the save finding out", async () => {
    renderPage();
    await screen.findByText("Observed holidays");

    const dates = screen.getAllByLabelText("Holiday date") as HTMLInputElement[];
    await userEvent.clear(dates[1]);
    await userEvent.type(dates[1], `${AHEAD}-01-01`);

    expect(screen.getByTestId("duplicate-dates").textContent).toMatch(`${AHEAD}-01-01`);
    expect(screen.getByRole("button", { name: "Save dates" })).toBeDisabled();
  });

  it("shows the server's refusal", async () => {
    put.mockRejectedValue(new Error("2026-07-03 is listed twice."));
    renderPage();
    await screen.findByText("Observed holidays");

    await userEvent.click(screen.getAllByRole("button", { name: "Remove this date" })[0]);
    await userEvent.click(screen.getByRole("button", { name: "Save dates" }));

    expect(await screen.findByTestId("action-error")).toHaveTextContent(/listed twice/);
  });
});

describe("a published set", () => {
  const published = () => holidaySet({ publishedAt: "2026-01-02T00:00:00.000Z" });

  it("explains why it is read-only in terms of what it already did", async () => {
    get.mockResolvedValue(published());
    renderPage();
    const notice = await screen.findByTestId("published-notice");
    expect(notice.textContent).toMatch(/priced bills against exactly these days/);
    expect(notice.textContent).toMatch(/new set with a later effective date/);
  });

  it("offers no publish, no save, no delete and no add", async () => {
    get.mockResolvedValue(published());
    renderPage();
    await screen.findByTestId("published-notice");

    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save dates" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a date" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete this draft/ })).toBeNull();
  });

  it("still shows the dates, which is what it is read for", async () => {
    get.mockResolvedValue(published());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.getAllByLabelText("Holiday date")).toHaveLength(4);
  });
});

describe("the calendars naming the set", () => {
  it("lists them, because a new version has to be carried into each one", async () => {
    get.mockResolvedValue(
      holidaySet({
        calendars: [
          {
            id: "cal-1",
            name: "Residential time-of-use",
            effectiveDate: "2026-01-01",
            publishedAt: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "cal-2",
            name: "Commercial time-of-use",
            effectiveDate: "2026-06-01",
            publishedAt: null,
          },
        ],
      }),
    );
    renderPage();
    const panel = await screen.findByTestId("calendars-using-set");
    expect(panel.textContent).toMatch(/2 TOU calendars name this set/);
    expect(panel.textContent).toMatch(/Residential time-of-use/);
    // The draft is marked, since it is the one that can still be changed.
    expect(panel.textContent).toMatch(/Commercial time-of-use \(from 2026-06-01\) — draft/);
  });

  it("says nothing at all when no calendar names it", async () => {
    renderPage();
    await screen.findByText("Observed holidays");
    expect(screen.queryByTestId("calendars-using-set")).toBeNull();
  });
});

describe("publishing", () => {
  it("is not offered while the set has no dates", async () => {
    // The server refuses an empty set, so the button could only fail.
    get.mockResolvedValue(holidaySet({ holidays: [] }));
    renderPage();
    const button = await screen.findByRole("button", { name: "Publish" });

    expect(button).toBeDisabled();
    expect(screen.getByTestId("publish-blocked").textContent).toMatch(/Add at least one date/);
  });

  it("is not offered while dates are unsaved, which publishing would drop", async () => {
    /*
     * The worse of the two: publishing would succeed, freeze the stored
     * set without the unsaved rows, and a published set is immutable —
     * so they could never be added.
     */
    renderPage();
    await screen.findByText("Observed holidays");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();

    await userEvent.click(screen.getAllByRole("button", { name: "Remove this date" })[0]);

    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();
    expect(screen.getByTestId("publish-blocked").textContent).toMatch(/Save the dates first/);
  });

  it("judges that on what is stored, not on the rows on screen", async () => {
    /*
     * Removing every row leaves the screen empty while the server still
     * holds four dates — and it is the stored set that would publish.
     * So the reason has to be "save first", not "add a date".
     */
    renderPage();
    await screen.findByText("Observed holidays");
    for (const remove of screen.getAllByRole("button", { name: "Remove this date" })) {
      await userEvent.click(remove);
    }

    expect(screen.getByTestId("no-dates")).toBeInTheDocument();
    expect(screen.getByTestId("publish-blocked").textContent).toMatch(/Save the dates first/);
  });

  it("is offered once the stored set has dates and nothing is unsaved", async () => {
    renderPage();
    await screen.findByText("Observed holidays");
    expect(screen.getByRole("button", { name: "Publish" })).toBeEnabled();
    expect(screen.queryByTestId("publish-blocked")).toBeNull();
  });

  it("publishes and reloads", async () => {
    post.mockResolvedValue({ id: "hset-1", publishedAt: "2026-01-02T00:00:00.000Z" });
    renderPage();
    await screen.findByText("Observed holidays");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/tou-holiday-sets/hset-1/publish", {}),
    );
  });

  /*
   * There was a test here for the refusal an empty set comes back with.
   * It is gone rather than repaired: the button is now disabled in
   * exactly that case, so the test could only pass by clicking
   * something a person cannot click, and it would have gone on
   * reporting coverage of a path the screen no longer has.
   *
   * The refusal itself still matters and is still tested, server-side,
   * by `tou-holiday-set.integration.test.ts` — "refuses to publish an
   * empty one, naming the consequence". The gate here is tested above.
   * How this page shows a server refusal is covered by the save tests.
   */
});

describe("when the set cannot be loaded", () => {
  it("says so instead of rendering an empty table", async () => {
    get.mockRejectedValue(new Error("There is no holiday set with that id."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no holiday set with that id/);
  });
});
