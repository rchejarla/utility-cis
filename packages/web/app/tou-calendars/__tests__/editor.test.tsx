import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import TouCalendarEditorPage from "../[id]/page";

/**
 * The TOU calendar editor (spec 26, §5).
 *
 * The global `next/navigation` stub does not provide `useParams`, which
 * this page reads for the calendar id, so the mock is restated here with
 * it. Restating the whole module is required: a factory replaces it
 * entirely, so a partial mock would leave `usePathname` undefined for
 * everything else in the tree.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "cal-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/tou-calendars/cal-1",
  useSearchParams: () => new URLSearchParams(),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

const PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "peak", label: "Peak" },
];

const DAY_TYPES = [
  { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [6, 7] },
];

function calendar(over: Record<string, unknown> = {}) {
  return {
    id: "cal-1",
    name: "TOD 5-8pm",
    effectiveDate: "2026-06-01",
    publishedAt: null,
    timeZone: "America/Los_Angeles",
    clockBasis: "prevailing",
    seasonSet: {
      id: "set-1",
      name: "Published seasons",
      publishedAt: "2026-01-01T00:00:00.000Z",
      seasons: [{ seasonCode: "summer", label: "Summer" }],
    },
    touHolidayListId: "list-1",
    periods: PERIODS,
    dayTypes: DAY_TYPES,
    spanGroups: [
      {
        seasonCode: "summer",
        dayTypeCode: "weekday",
        spans: [
          { startMinute: 0, endMinute: 1020, peakCode: "off_peak" },
          { startMinute: 1020, endMinute: 1200, peakCode: "peak" },
          { startMinute: 1200, endMinute: 1440, peakCode: "off_peak" },
        ],
      },
      {
        seasonCode: "summer",
        dayTypeCode: "weekend",
        spans: [{ startMinute: 0, endMinute: 1440, peakCode: "off_peak" }],
      },
    ],
    overrides: [],
    validation: { ok: true },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(calendar());
});

const renderPage = () => render(<TouCalendarEditorPage />);

describe("reading a calendar", () => {
  it("shows its name, when it comes into force and the clock it runs on", async () => {
    renderPage();
    expect(await screen.findByText("TOD 5-8pm")).toBeInTheDocument();
    // The zone is part of what the hours mean, so it belongs on the
    // header and not behind an edit form.
    expect(screen.getByText(/America\/Los_Angeles/)).toBeInTheDocument();
    expect(screen.getByText(/follows daylight saving/)).toBeInTheDocument();
  });

  it("says standard-time calendars keep standard time all year", async () => {
    // A 4–9pm peak on a standard-basis calendar runs 5–10pm by the
    // summer clock, which is not a detail to leave implicit.
    get.mockResolvedValue(calendar({ clockBasis: "standard" }));
    renderPage();
    expect(await screen.findByText(/standard time all year/)).toBeInTheDocument();
  });

  it("renders a strip per season and day type", async () => {
    renderPage();
    await screen.findByText("TOD 5-8pm");
    expect(screen.getAllByTestId("day-strip")).toHaveLength(2);
  });

  it("renders an empty group for a (season, day type) that has no hours", async () => {
    /*
     * The combination with nothing assigned is the most common mistake,
     * and the API sends a group for it rather than omitting the key —
     * an absent group would render nothing and the gap would be
     * invisible.
     */
    get.mockResolvedValue(
      calendar({
        spanGroups: [
          { seasonCode: "summer", dayTypeCode: "weekday", spans: [] },
          { seasonCode: "summer", dayTypeCode: "weekend", spans: [] },
        ],
        validation: { ok: false, problems: ["Summer, weekday: 00:00–24:00 is assigned to no period"] },
      }),
    );
    renderPage();
    expect(await screen.findByTestId("span-editor-summer-weekday")).toBeInTheDocument();
    expect(screen.getAllByText(/every minute of this day is unpriced/)).toHaveLength(2);
  });
});

describe("validation", () => {
  it("lists the problems in words, not just on the grid", async () => {
    get.mockResolvedValue(
      calendar({
        validation: {
          ok: false,
          problems: [
            "Summer, weekday: 21:00–22:00 is assigned to no period",
            "Summer, weekend: 08:00–09:00 is assigned to both off_peak and peak",
          ],
        },
      }),
    );
    renderPage();
    const problems = await screen.findByTestId("calendar-problems");
    expect(problems.textContent).toMatch(/2 problems/);
    expect(problems.textContent).toMatch(/21:00–22:00/);
    expect(problems.textContent).toMatch(/both off_peak and peak/);
  });

  it("says so plainly when every hour is priced exactly once", async () => {
    renderPage();
    expect(await screen.findByTestId("calendar-ready")).toBeInTheDocument();
  });

  it("warns about a weekday no day type claims", async () => {
    // Saturday unclaimed: dates falling on it cannot be classified and
    // a bill covering one stops.
    get.mockResolvedValue(
      calendar({
        dayTypes: [
          { dayTypeCode: "weekday", label: "Weekday", isHoliday: false, weekdays: [1, 2, 3, 4, 5] },
          { dayTypeCode: "weekend", label: "Weekend", isHoliday: false, weekdays: [7] },
        ],
      }),
    );
    renderPage();
    const warning = await screen.findByTestId("unclaimed-weekdays");
    expect(warning.textContent).toMatch(/Sat/);
    expect(warning.textContent).toMatch(/cannot be classified/);
  });
});

describe("a published calendar", () => {
  const publishedCalendar = () =>
    calendar({ publishedAt: "2026-05-01T12:00:00.000Z" });

  it("explains why it is read-only, in terms of what it already did", async () => {
    get.mockResolvedValue(publishedCalendar());
    renderPage();
    const notice = await screen.findByTestId("published-notice");
    expect(notice.textContent).toMatch(/priced bills/);
    expect(notice.textContent).toMatch(/new version/);
  });

  it("offers no Publish button and no Save buttons", async () => {
    get.mockResolvedValue(publishedCalendar());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save these hours/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save periods/ })).toBeNull();
  });

  it("offers no delete, because a published calendar is evidence", async () => {
    get.mockResolvedValue(publishedCalendar());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.queryByRole("button", { name: /Delete this draft/ })).toBeNull();
  });

  it("still shows the hours, which is what it is read for", async () => {
    get.mockResolvedValue(publishedCalendar());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.getAllByTestId("day-strip")).toHaveLength(2);
  });
});

describe("editing the hours", () => {
  it("sends the whole list for one season and day type", async () => {
    put.mockResolvedValue(calendar());
    renderPage();
    await screen.findByTestId("span-editor-summer-weekend");

    const group = screen.getByTestId("span-editor-summer-weekend");
    const periodSelect = group.querySelectorAll("select")[2] as HTMLSelectElement;
    await userEvent.selectOptions(periodSelect, "peak");
    await userEvent.click(group.querySelector("button[style*='accent']") as HTMLElement);

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, payload] = put.mock.calls[0];
    expect(url).toBe("/api/v1/tou-calendars/cal-1/spans");
    expect(payload).toMatchObject({ seasonCode: "summer", dayTypeCode: "weekend" });
    expect((payload as { spans: unknown[] }).spans).toHaveLength(1);
  });

  it("keeps Save unavailable until something changes", async () => {
    renderPage();
    await screen.findByTestId("span-editor-summer-weekend");
    const save = screen
      .getAllByRole("button", { name: /Save these hours/ })
      .at(0) as HTMLButtonElement;
    expect(save).toBeDisabled();
  });

  it("shows the server's refusal against the group that caused it", async () => {
    put.mockRejectedValue(new Error("Two spans overlap: 00:00–18:00 and 17:00–20:00."));
    renderPage();
    await screen.findByTestId("span-editor-summer-weekend");

    const group = screen.getByTestId("span-editor-summer-weekend");
    await userEvent.selectOptions(group.querySelectorAll("select")[2] as HTMLSelectElement, "peak");
    await userEvent.click(group.querySelector("button[style*='accent']") as HTMLElement);

    expect(await screen.findByText(/Two spans overlap/)).toBeInTheDocument();
  });

  it("copies another group's hours into this one without saving them", async () => {
    /*
     * TOU-UI-1b. Copying is the start of editing — winter is often
     * summer with a shorter peak — so it fills the rows and leaves them
     * dirty rather than writing them.
     */
    renderPage();
    await screen.findByTestId("span-editor-summer-weekend");

    const group = screen.getByTestId("span-editor-summer-weekend");
    expect(group.querySelectorAll("tbody tr")).toHaveLength(1);

    await userEvent.selectOptions(
      group.querySelector("select[aria-label='Copy hours from']") as HTMLSelectElement,
      "summer|weekday",
    );

    expect(group.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("day types", () => {
  it("moves a weekday off whichever day type had it", async () => {
    /*
     * `tou_day_type_weekday_once_per_calendar` makes a weekday one day
     * type's property. Enforcing it in the form means the operator
     * never composes a list the server will refuse.
     */
    renderPage();
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Fri on weekend" }));

    expect(screen.getByRole("button", { name: "Fri on weekend" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Fri on weekday" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("allows only one holiday day type", async () => {
    get.mockResolvedValue(
      calendar({
        dayTypes: [
          ...DAY_TYPES,
          { dayTypeCode: "holiday", label: "Holiday", isHoliday: true, weekdays: [] },
        ],
      }),
    );
    renderPage();
    await screen.findByTestId("day-types-editor");

    await userEvent.click(
      screen.getByRole("checkbox", { name: /weekend is the holiday type/ }),
    );

    expect(screen.getByRole("checkbox", { name: /weekend is the holiday type/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /holiday is the holiday type/ })).not.toBeChecked();
  });
});

describe("the spot check", () => {
  it("asks the server and shows the sentence saying why", async () => {
    renderPage();
    await screen.findByTestId("spot-check");

    get.mockResolvedValue({
      date: "2026-07-03",
      time: "17:15",
      ok: true,
      peakCode: "off_peak",
      periodLabel: "Off-peak",
      seasonLabel: "Summer",
      dayTypeLabel: "Holiday",
      why: "2026-07-03 is observed as Independence Day — the holiday falls on 2026-07-04 and is observed on this day instead, so \"Holiday\" applies rather than its Friday day type.",
    });

    await userEvent.type(screen.getByLabelText("Date"), "2026-07-03");
    await userEvent.click(screen.getByRole("button", { name: "Check this time" }));

    const answer = await screen.findByTestId("spot-check-answer");
    expect(answer.textContent).toMatch(/Off-peak/);
    expect(answer.textContent).toMatch(/Independence Day/);
    expect(answer.textContent).toMatch(/2026-07-04/);
  });

  it("shows the problem when an hour cannot be classified", async () => {
    renderPage();
    await screen.findByTestId("spot-check");

    get.mockResolvedValue({
      date: "2026-07-02",
      time: "17:15",
      ok: false,
      problem: "No period covers 17:15 on a summer weekday.",
    });

    await userEvent.type(screen.getByLabelText("Date"), "2026-07-02");
    await userEvent.click(screen.getByRole("button", { name: "Check this time" }));

    expect(await screen.findByText(/No period covers 17:15/)).toBeInTheDocument();
  });

  it("asks for a date before calling anything", async () => {
    renderPage();
    await screen.findByTestId("spot-check");
    get.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Check this time" }));

    expect(await screen.findByText("Pick a date first.")).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it("lays out a whole day, which is how an observance rule is checked", async () => {
    renderPage();
    await screen.findByTestId("spot-check");

    get.mockResolvedValue({
      date: "2026-07-03",
      ok: true,
      dayTypeLabel: "Holiday",
      seasonLabel: "Summer",
      why: "2026-07-03 is observed as Independence Day",
      spans: [{ startMinute: 0, endMinute: 1440, periodLabel: "Off-peak" }],
    });

    await userEvent.type(screen.getByLabelText("Date"), "2026-07-03");
    await userEvent.click(screen.getByRole("button", { name: "Show the whole day" }));

    const preview = await screen.findByTestId("day-preview");
    expect(preview.textContent).toMatch(/00:00–24:00 Off-peak/);
  });
});

describe("publishing", () => {
  it("publishes and reloads", async () => {
    post.mockResolvedValue({ id: "cal-1", publishedAt: "2026-05-01T12:00:00.000Z" });
    renderPage();
    await screen.findByText("TOD 5-8pm");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/tou-calendars/cal-1/publish", {}),
    );
  });

  it("shows the refusal, keeping its line breaks so the problems stay a list", async () => {
    post.mockRejectedValue(
      new Error(
        '"TOD 5-8pm" does not yet price every hour exactly once, so publishing it would leave usage either uncharged or charged twice:\n  • Summer, weekday: 21:00–22:00 is assigned to no period',
      ),
    );
    renderPage();
    await screen.findByText("TOD 5-8pm");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    const error = await screen.findByTestId("action-error");
    expect(error.textContent).toMatch(/uncharged or charged twice/);
    expect(error.textContent).toMatch(/21:00–22:00/);
    expect(error).toHaveStyle({ whiteSpace: "pre-wrap" });
  });

  it("says when the season set is still a draft, which publishing will refuse", async () => {
    get.mockResolvedValue(
      calendar({
        seasonSet: {
          id: "set-1",
          name: "Draft seasons",
          publishedAt: null,
          seasons: [{ seasonCode: "summer", label: "Summer" }],
        },
      }),
    );
    renderPage();
    expect(await screen.findByText(/Draft seasons \(still a draft\)/)).toBeInTheDocument();
  });
});

describe("when the calendar cannot be loaded", () => {
  it("says so instead of rendering an empty editor", async () => {
    get.mockRejectedValue(new Error("There is no TOU calendar with that id."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no TOU calendar with that id/);
  });
});

describe("rows nobody has filled in", () => {
  /*
   * The bug this closes: "Add a period" creates a row whose
   * placeholders — `peak`, `Peak` — look exactly like values, so the
   * obvious next click is Save. That sent an empty code to a schema
   * demanding at least one character and came back "API error 400:
   * Validation failed", naming neither the field nor the row.
   */
  it("will not save a period with no code", async () => {
    renderPage();
    await screen.findByTestId("periods-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByRole("button", { name: "Save periods" })).toBeDisabled();
    expect(screen.getByTestId("periods-incomplete").textContent).toMatch(/Row 3/);
    expect(put).not.toHaveBeenCalled();
  });

  it("will not save a day type with no code", async () => {
    renderPage();
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a day type" }));

    expect(screen.getByRole("button", { name: "Save day types" })).toBeDisabled();
    expect(screen.getByTestId("day-types-incomplete").textContent).toMatch(/Row 3/);
  });

  it("says the greyed text is an example, because that is the trap", async () => {
    renderPage();
    await screen.findByTestId("periods-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByTestId("periods-incomplete").textContent).toMatch(
      /example, not a value/,
    );
  });

  it("lets the save through once the row is filled in", async () => {
    put.mockResolvedValue(calendar());
    renderPage();
    await screen.findByTestId("periods-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));
    const codes = screen.getAllByLabelText("Period code");
    const labels = screen.getAllByLabelText("Period label");
    await userEvent.type(codes[codes.length - 1], "super_off_peak");
    await userEvent.type(labels[labels.length - 1], "Super off-peak");

    expect(screen.queryByTestId("periods-incomplete")).toBeNull();
    const save = screen.getByRole("button", { name: "Save periods" });
    expect(save).toBeEnabled();

    await userEvent.click(save);
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, payload] = put.mock.calls[0];
    expect((payload as { periods: Array<{ peakCode: string }> }).periods).toHaveLength(3);
  });

  it("treats whitespace as empty, so a space is not a code", async () => {
    renderPage();
    await screen.findByTestId("periods-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    const codes = screen.getAllByLabelText("Period code");
    await userEvent.type(codes[codes.length - 1], "   ");

    expect(screen.getByRole("button", { name: "Save periods" })).toBeDisabled();
  });
});
