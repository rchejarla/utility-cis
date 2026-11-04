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
  { dayTypeCode: "weekday", label: "Weekday", weekdays: [1, 2, 3, 4, 5] },
  { dayTypeCode: "weekend", label: "Weekend", weekdays: [6, 7] },
];

/**
 * The reserved row, as the server sends it: `isHolidayDayType` is
 * derived from the code and not stored, so a fixture that sets one
 * without the other is describing a calendar the API cannot produce.
 */
const HOLIDAY_DAY_TYPE = {
  dayTypeCode: "holiday",
  label: "Holiday",
  isHolidayDayType: true,
  weekdays: [] as number[],
};

const HOLIDAY_SET = {
  id: "hset-1",
  name: "Observed holidays",
  publishedAt: "2026-01-01T00:00:00.000Z",
  _count: { holidays: 9 },
};

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
    touHolidaySetId: null,
    holidaySet: null,
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

/** The same calendar, naming a holiday set and carrying its day type. */
function withHolidaySet(over: Record<string, unknown> = {}) {
  return calendar({
    touHolidaySetId: HOLIDAY_SET.id,
    holidaySet: HOLIDAY_SET,
    dayTypes: [...DAY_TYPES, HOLIDAY_DAY_TYPE],
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(calendar());
});

const renderPage = () => render(<TouCalendarEditorPage />);

/**
 * Switch tabs the way a person does.
 *
 * The page opens on the first section with nothing in it, and on a
 * complete fixture that is Hours — so a test about the periods or the
 * day types has to go there first. Clicking is deliberate rather than
 * reaching into state: the inactive tabs are rendered and hidden, so a
 * query that found a hidden input would pass while the control was
 * unreachable.
 */
async function openTab(name: "Periods" | "Day Types" | "Hours") {
  // `find`, not `get`: the tabs appear with the calendar, and these
  // tests call this as their first act after rendering.
  const tab = await screen.findByRole("tab", { name: new RegExp(`^${name}`) });
  await userEvent.click(tab);
}

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
          { dayTypeCode: "weekday", label: "Weekday", weekdays: [1, 2, 3, 4, 5] },
          { dayTypeCode: "weekend", label: "Weekend", weekdays: [7] },
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
    await openTab("Day Types");
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

  /*
   * There is no "is this the holiday one?" control any more, and that is
   * the point of the change. Nominating a day type as the holiday type
   * was a setup step asked before anything could say what the holidays
   * were, and it meant nothing to the person being asked. The holiday
   * row now arrives with the holiday set, and its code is the system's.
   */
  it("offers no way to nominate a day type as the holiday one", async () => {
    get.mockResolvedValue(withHolidaySet());
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("leaves the reserved holiday row out of the list entirely", async () => {
    /*
     * Nothing about it is the operator's to decide: the system creates
     * it with the set, the engine finds it by its code and it claims no
     * weekday. Shown as a row, every cell was disabled and the list
     * read as though holidays were configured here.
     */
    get.mockResolvedValue(withHolidaySet());
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    const codes = screen.getAllByLabelText("Day type code") as HTMLInputElement[];
    expect(codes.map((c) => c.value)).toEqual(["weekday", "weekend"]);
    expect(screen.getAllByRole("button", { name: "Remove this day type" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Mon on holiday" })).toBeNull();
  });

  it("says in a line where the holiday hours below come from", async () => {
    // Without it the Hours section grows a "Holiday" block out of
    // nowhere, now that no row in this list mentions one.
    get.mockResolvedValue(withHolidaySet());
    renderPage();
    const note = await screen.findByTestId("holiday-day-type-note");
    expect(note.textContent).toMatch(/Observed holidays/);
    expect(note.textContent).toMatch(/whatever weekday they fall on/);
  });

  it("says nothing about holidays when the calendar names no set", async () => {
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");
    expect(screen.queryByTestId("holiday-day-type-note")).toBeNull();
  });

  it("still prices the holiday hours, which is what the row was for", async () => {
    // Hidden from the vocabulary list, not from the hours: a strip per
    // (season, day type) still includes it.
    get.mockResolvedValue(
      withHolidaySet({
        spanGroups: [
          ...calendar().spanGroups,
          {
            seasonCode: "summer",
            dayTypeCode: "holiday",
            spans: [{ startMinute: 0, endMinute: 1440, peakCode: "off_peak" }],
          },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByTestId("span-editor-summer-holiday")).toBeInTheDocument();
  });

  it("keeps the hidden holiday row in the saved list, which the server requires", async () => {
    /*
     * The save replaces the whole collection, and a list submitted
     * without the reserved row while a set is named is refused — so
     * hiding it from the table must not drop it from the payload.
     */
    put.mockResolvedValue(withHolidaySet());
    get.mockResolvedValue(withHolidaySet());
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Sat on weekday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save day types" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, payload] = put.mock.calls[0];
    const sent = payload as { dayTypes: Array<{ dayTypeCode: string }> };
    expect(sent.dayTypes.map((d) => d.dayTypeCode)).toEqual(["weekday", "weekend", "holiday"]);
  });

  it("numbers an unfilled row by what is on screen, not by its place in the list", async () => {
    // The reserved row sits in the list and not in the table, so a row
    // added after it is the third thing somebody can see, not the
    // fourth thing stored.
    get.mockResolvedValue(withHolidaySet());
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a day type" }));

    expect(screen.getByTestId("day-types-incomplete").textContent).toMatch(/Row 3\b/);
  });

  it("sends no holiday flag when the list is saved", async () => {
    put.mockResolvedValue(calendar());
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Sat on weekday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save day types" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, payload] = put.mock.calls[0];
    expect(url).toBe("/api/v1/tou-calendars/cal-1/day-types");
    const [first] = (payload as { dayTypes: Array<Record<string, unknown>> }).dayTypes;
    expect(Object.keys(first).sort()).toEqual(["dayTypeCode", "label", "weekdays"]);
  });
});

describe("the holiday set", () => {
  it("can be attached while the calendar is a draft", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/v1/tou-holiday-sets"
        ? Promise.resolve({
            data: [
              {
                id: "hset-1",
                name: "Observed holidays",
                publishedAt: "2026-01-01T00:00:00.000Z",
                lastDate: "2027-12-24",
              },
            ],
          })
        : url === "/api/v1/season-sets"
          ? Promise.resolve({ data: [] })
          : Promise.resolve(calendar()),
    );
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue({});

    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Holiday set"), "hset-1");
    // Picking is picking; Apply is the save.
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/tou-calendars/cal-1", {
        touHolidaySetId: "hset-1",
      }),
    );
  });

  it("is detached with null, not with an empty string the server would reject", async () => {
    get.mockResolvedValue(
      calendar({ touHolidaySetId: HOLIDAY_SET.id, holidaySet: HOLIDAY_SET }),
    );
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue({});

    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Holiday set"), "");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/tou-calendars/cal-1", {
        touHolidaySetId: null,
      }),
    );
  });

  it("names it with its date count once published, where nothing can be changed", async () => {
    get.mockResolvedValue(
      calendar({
        publishedAt: "2026-05-01T12:00:00.000Z",
        touHolidaySetId: HOLIDAY_SET.id,
        holidaySet: HOLIDAY_SET,
      }),
    );
    renderPage();
    await screen.findByTestId("published-notice");

    expect(screen.getByTestId("holiday-set").textContent).toMatch(/Observed holidays \(9 dates\)/);
    expect(screen.queryByLabelText("Holiday set")).toBeNull();
  });

  it("says plainly when none is named, rather than leaving the row blank", async () => {
    get.mockResolvedValue(calendar({ publishedAt: "2026-05-01T12:00:00.000Z" }));
    renderPage();
    await screen.findByTestId("published-notice");

    expect(screen.getByTestId("holiday-set").textContent).toMatch(/classified by weekday alone/);
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
    /*
     * The set's name sits in the picker and the warning beside it, so
     * this reads the control's whole label rather than one text node —
     * but asserts both halves, so losing either fails.
     */
    const picker = await screen.findByLabelText("Season set");
    const line = picker.closest("label");
    expect(line?.textContent).toMatch(/Draft seasons/);
    expect(line?.textContent).toMatch(/still a draft/);
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
    await openTab("Periods");
    await screen.findByTestId("periods-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByRole("button", { name: "Save periods" })).toBeDisabled();
    expect(screen.getByTestId("periods-incomplete").textContent).toMatch(/Row 3/);
    expect(put).not.toHaveBeenCalled();
  });

  it("will not save a day type with no code", async () => {
    renderPage();
    await openTab("Day Types");
    await screen.findByTestId("day-types-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a day type" }));

    expect(screen.getByRole("button", { name: "Save day types" })).toBeDisabled();
    expect(screen.getByTestId("day-types-incomplete").textContent).toMatch(/Row 3/);
  });

  it("says the greyed text is an example, because that is the trap", async () => {
    renderPage();
    await openTab("Periods");
    await screen.findByTestId("periods-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByTestId("periods-incomplete").textContent).toMatch(
      /example, not a value/,
    );
  });

  it("lets the save through once the row is filled in", async () => {
    put.mockResolvedValue(calendar());
    renderPage();
    await openTab("Periods");
    await screen.findByTestId("periods-editor");

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));
    const codes = screen.getAllByLabelText("Period code");
    const labels = screen.getAllByLabelText("Period label");
    /*
     * Pasted rather than typed. Twenty-eight characters is twenty-eight
     * events, and with the tab click before them this test was the one
     * that tipped over the five-second default when the whole suite ran
     * at once — it passed on its own, which is the worst way for a test
     * to fail. What it is about is a filled row, not the keystrokes.
     */
    await userEvent.click(codes[codes.length - 1]);
    await userEvent.paste("super_off_peak");
    await userEvent.click(labels[labels.length - 1]);
    await userEvent.paste("Super off-peak");

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
    await openTab("Periods");
    await screen.findByTestId("periods-editor");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    const codes = screen.getAllByLabelText("Period code");
    await userEvent.type(codes[codes.length - 1], "   ");

    expect(screen.getByRole("button", { name: "Save periods" })).toBeDisabled();
  });
});

describe("the season set, while the calendar is a draft", () => {
  it("can be changed", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/v1/season-sets"
        ? Promise.resolve({
            data: [
              { id: "set-1", name: "Published seasons", publishedAt: "2026-01-01T00:00:00.000Z" },
              { id: "set-2", name: "Newer seasons", publishedAt: "2026-02-01T00:00:00.000Z" },
            ],
          })
        : Promise.resolve(calendar()),
    );
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue({});

    renderPage();
    const picker = await screen.findByLabelText("Season set");
    await userEvent.selectOptions(picker, "set-2");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/api/v1/tou-calendars/cal-1", {
        seasonSetId: "set-2",
      }),
    );
  });

  it("is read-only once published", async () => {
    get.mockResolvedValue(calendar({ publishedAt: "2026-05-01T12:00:00.000Z" }));
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.queryByLabelText("Season set")).toBeNull();
    expect(screen.getByText(/Seasons: Published seasons/)).toBeInTheDocument();
  });

  it("shows the server's refusal when hours are keyed on a season the new set lacks", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/v1/season-sets"
        ? Promise.resolve({
            data: [
              { id: "set-1", name: "Published seasons", publishedAt: "2026-01-01T00:00:00.000Z" },
              { id: "set-2", name: "Newer seasons", publishedAt: "2026-02-01T00:00:00.000Z" },
            ],
          })
        : Promise.resolve(calendar()),
    );
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockRejectedValue(
      new Error('This calendar has hours assigned to "summer", which "Newer seasons" does not define.'),
    );

    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByTestId("action-error")).toHaveTextContent(/does not define/);
  });

  it("keeps the refused choice on screen so the reason can be read against it", async () => {
    /*
     * A selection that snapped back to the old value would leave the
     * refusal talking about a set the screen no longer shows.
     */
    get.mockImplementation((url: string) =>
      url === "/api/v1/season-sets"
        ? Promise.resolve({
            data: [
              { id: "set-1", name: "Published seasons", publishedAt: "2026-01-01T00:00:00.000Z" },
              { id: "set-2", name: "Newer seasons", publishedAt: "2026-02-01T00:00:00.000Z" },
            ],
          })
        : Promise.resolve(calendar()),
    );
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockRejectedValue(new Error('"Newer seasons" does not define "summer".'));

    renderPage();
    const picker = (await screen.findByLabelText("Season set")) as HTMLSelectElement;
    await userEvent.selectOptions(picker, "set-2");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByTestId("action-error");

    expect(picker.value).toBe("set-2");
    expect(screen.getByTestId("pending-change")).toBeInTheDocument();
  });
});

/**
 * These two were the only controls on the page that applied the moment
 * they were touched, while everything else was a list with a Save. The
 * confusion ran the dangerous way: somebody who had just used the
 * Periods tab looked for a Save, found none, and left assuming their
 * choice had been discarded.
 */
describe("changing a set the calendar names", () => {
  const twoSeasonSets = () =>
    get.mockImplementation((url: string) =>
      url === "/api/v1/season-sets"
        ? Promise.resolve({
            data: [
              { id: "set-1", name: "Published seasons", publishedAt: "2026-01-01T00:00:00.000Z" },
              { id: "set-2", name: "Newer seasons", publishedAt: "2026-02-01T00:00:00.000Z" },
            ],
          })
        : Promise.resolve(calendar()),
    );

  it("writes nothing until Apply", async () => {
    twoSeasonSets();
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue({});

    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2");

    expect(screen.getByTestId("pending-change")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("says what attaching a holiday set will do, before it does it", async () => {
    get.mockImplementation((url: string) =>
      url === "/api/v1/tou-holiday-sets"
        ? Promise.resolve({
            data: [{ id: "hset-1", name: "Observed holidays", publishedAt: "x", lastDate: null }],
          })
        : url === "/api/v1/season-sets"
          ? Promise.resolve({ data: [] })
          : Promise.resolve(calendar()),
    );
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Holiday set"), "hset-1");

    const row = screen.getByTestId("pending-change");
    expect(row.textContent).toMatch(/Adds a Holiday day type/);
    expect(row.textContent).toMatch(/Observed holidays/);
  });

  it("says detaching removes the day type, rather than refusing afterwards", async () => {
    get.mockResolvedValue(calendar({ touHolidaySetId: HOLIDAY_SET.id, holidaySet: HOLIDAY_SET }));
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Holiday set"), "");

    const row = screen.getByTestId("pending-change");
    expect(row.textContent).toMatch(/Removes the Holiday day type/);
    expect(row.textContent).toMatch(/Refused if you have given it hours/);
  });

  it("says a season-set change is refused rather than dropping hours", async () => {
    twoSeasonSets();
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2");

    expect(screen.getByTestId("pending-change").textContent).toMatch(
      /refused rather than deleting them/,
    );
  });

  it("puts the choice back when cancelled, and writes nothing", async () => {
    twoSeasonSets();
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

    renderPage();
    const picker = (await screen.findByLabelText("Season set")) as HTMLSelectElement;
    await userEvent.selectOptions(picker, "set-2");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(picker.value).toBe("set-1");
    expect(screen.queryByTestId("pending-change")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it("treats picking what is already chosen as no change at all", async () => {
    twoSeasonSets();
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-1");
    expect(screen.queryByTestId("pending-change")).toBeNull();
  });

  it("says it saved, because nothing else would", async () => {
    /*
     * Switching between two holiday sets with the same day types
     * changes nothing visible, so without this the page looked exactly
     * as it had and the only way to know was to reload.
     */
    twoSeasonSets();
    const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
    patch.mockResolvedValue({});

    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByTestId("change-applied")).toHaveTextContent(
      /Season set changed to "Newer seasons"/,
    );
    expect(screen.queryByTestId("pending-change")).toBeNull();
  });

  it("locks the other picker while a change is waiting, so two cannot race", async () => {
    // Applying one reloads the whole calendar, which would land on top
    // of the other's pending selection.
    twoSeasonSets();
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText("Season set"), "set-2");

    expect(screen.getByLabelText("Holiday set")).toBeDisabled();
    expect(screen.getByLabelText("Season set")).toBeEnabled();
  });
});

describe("the spot check", () => {
  it("is not offered before there are any hours to check", async () => {
    /*
     * It answers "what period would a bill use, and why". On a calendar
     * with no hours it answers nothing, and at the top of the page it
     * read as a step somebody was meant to complete first.
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
    await screen.findByTestId("span-editor-summer-weekday");
    expect(screen.queryByTestId("spot-check")).toBeNull();
  });

  it("appears once some hours exist", async () => {
    renderPage();
    expect(await screen.findByTestId("spot-check")).toBeInTheDocument();
  });
});

/**
 * Three tabs and one season at a time, because the whole calendar at
 * once is a wall: two seasons and three day types is six span editors,
 * each a strip and a table, under two more cards.
 */
describe("the tabs", () => {
  /** A calendar with nothing in it, which is what a new one looks like. */
  const empty = () =>
    calendar({
      periods: [],
      dayTypes: [],
      spanGroups: [],
      validation: { ok: false, problems: ["This calendar has no periods."] },
    });

  it("opens on the first section with nothing in it", async () => {
    // What a wizard's first step would have been. No wizard: the tab
    // the page opens on does the same job for a new calendar, and an
    // old one is reachable in one click.
    get.mockResolvedValue(empty());
    renderPage();
    expect(await screen.findByTestId("tab-periods")).toHaveAttribute("aria-selected", "true");
  });

  it("opens on the hours when every section has something", async () => {
    // Somebody coming back to a finished calendar came for the hours.
    renderPage();
    expect(await screen.findByTestId("tab-hours")).toHaveAttribute("aria-selected", "true");
  });

  it("marks a section that has nothing in it", async () => {
    get.mockResolvedValue(empty());
    renderPage();
    await screen.findByTestId("tab-periods");
    expect(screen.getByTestId("tab-day-types-incomplete")).toBeInTheDocument();
    expect(screen.getByTestId("tab-hours-incomplete")).toBeInTheDocument();
  });

  it("marks a section holding edits nobody has saved", async () => {
    renderPage();
    await openTab("Periods");
    await screen.findByTestId("periods-editor");
    expect(screen.queryByTestId("tab-periods-unsaved")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByTestId("tab-periods-unsaved")).toBeInTheDocument();
  });

  it("keeps an unsaved edit when you look at another tab", async () => {
    /*
     * The one thing tabs add that a single page could not get wrong.
     * Each tab stays mounted and hidden, so switching away is looking
     * elsewhere rather than discarding.
     */
    renderPage();
    await openTab("Periods");
    await screen.findByTestId("periods-editor");

    const codes = screen.getAllByLabelText("Period code");
    await userEvent.type(codes[0], "_edited");

    await openTab("Hours");
    await openTab("Periods");

    expect((screen.getAllByLabelText("Period code")[0] as HTMLInputElement).value).toBe(
      "off_peak_edited",
    );
  });

  it("does not discard one tab's edit when another tab saves", async () => {
    /*
     * Every save returns the whole calendar, and the sections used to
     * share one remount counter — so saving the day types threw away a
     * half-typed period on the tab next door.
     */
    put.mockResolvedValue(calendar());
    renderPage();
    await openTab("Periods");
    await screen.findByTestId("periods-editor");
    await userEvent.type(screen.getAllByLabelText("Period code")[0], "_edited");

    await openTab("Day Types");
    await userEvent.click(screen.getByRole("button", { name: "Sat on weekday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save day types" }));
    await waitFor(() => expect(put).toHaveBeenCalled());

    await openTab("Periods");
    expect((screen.getAllByLabelText("Period code")[0] as HTMLInputElement).value).toBe(
      "off_peak_edited",
    );
  });

  it("offers the next section rather than leaving somebody to find the tab", async () => {
    get.mockResolvedValue(empty());
    renderPage();
    await screen.findByTestId("tab-periods");

    await userEvent.click(screen.getByTestId("next-to-day-types"));

    expect(screen.getByTestId("tab-day-types")).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the verdict and Publish above the tabs, where no tab can hide them", async () => {
    // A tab that hid "2 problems to fix" would let somebody believe the
    // hours were finished.
    get.mockResolvedValue(
      calendar({
        validation: { ok: false, problems: ["Summer, weekday: 21:00–22:00 is assigned to no period"] },
      }),
    );
    renderPage();
    await screen.findByTestId("tab-hours");

    expect(screen.getByTestId("calendar-problems")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();

    await openTab("Periods");

    expect(screen.getByTestId("calendar-problems")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
  });
});

describe("the season chips on the Hours tab", () => {
  const twoSeasons = (over: Record<string, unknown> = {}) =>
    calendar({
      seasonSet: {
        id: "set-1",
        name: "Published seasons",
        publishedAt: "2026-01-01T00:00:00.000Z",
        seasons: [
          {
            seasonCode: "summer",
            label: "Summer",
            startMonth: 5,
            startDay: 1,
            endMonth: 10,
            endDay: 31,
          },
          {
            seasonCode: "winter",
            label: "Winter",
            startMonth: 11,
            startDay: 1,
            endMonth: 4,
            endDay: 30,
          },
        ],
      },
      ...over,
    });

  it("shows one season's hours at a time", async () => {
    get.mockResolvedValue(
      twoSeasons({
        spanGroups: [
          ...calendar().spanGroups,
          { seasonCode: "winter", dayTypeCode: "weekday", spans: [] },
          { seasonCode: "winter", dayTypeCode: "weekend", spans: [] },
        ],
      }),
    );
    renderPage();
    await screen.findByTestId("season-chip-summer");

    // Both are rendered so an unsaved edit survives a chip click; only
    // the chosen one is shown.
    expect(screen.getByTestId("season-hours-winter")).toHaveStyle({ display: "flex" });
    expect(screen.getByTestId("season-hours-summer")).toHaveStyle({ display: "none" });
  });

  it("opens on a season that is missing hours, not just the first one", async () => {
    // Summer is complete, winter is not: winter is the work left.
    get.mockResolvedValue(
      twoSeasons({
        spanGroups: [
          ...calendar().spanGroups,
          { seasonCode: "winter", dayTypeCode: "weekday", spans: [] },
          { seasonCode: "winter", dayTypeCode: "weekend", spans: [] },
        ],
      }),
    );
    renderPage();
    expect(await screen.findByTestId("season-chip-winter")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("marks which seasons still need hours, without being opened", async () => {
    /*
     * The reason these are chips and not a dropdown. Publishing needs
     * every (season, day type) covered, and a dropdown can only say
     * which season is empty once somebody has opened it.
     */
    get.mockResolvedValue(
      twoSeasons({
        spanGroups: [
          ...calendar().spanGroups,
          { seasonCode: "winter", dayTypeCode: "weekday", spans: [] },
          { seasonCode: "winter", dayTypeCode: "weekend", spans: [] },
        ],
      }),
    );
    renderPage();
    await screen.findByTestId("season-chip-summer");

    expect(screen.getByTestId("season-chip-summer-complete")).toBeInTheDocument();
    expect(screen.getByTestId("season-chip-winter-incomplete")).toBeInTheDocument();
  });

  it("prints the months a season covers beside its name", async () => {
    // A season code is the tenant's word and says nothing about when it
    // runs — least of all when it wraps the year end, as winter does
    // here.
    get.mockResolvedValue(twoSeasons());
    renderPage();
    await screen.findByTestId("season-chip-winter");

    await userEvent.click(screen.getByTestId("season-chip-winter"));

    expect(screen.getByTestId("season-hours-winter").textContent).toMatch(
      /Winter · 1 Nov – 30 Apr/,
    );
  });

  it("keeps unsaved hours when another season is looked at", async () => {
    get.mockResolvedValue(twoSeasons());
    renderPage();
    const group = await screen.findByTestId("span-editor-summer-weekend");
    await userEvent.selectOptions(group.querySelectorAll("select")[2] as HTMLSelectElement, "peak");

    await userEvent.click(screen.getByTestId("season-chip-winter"));
    await userEvent.click(screen.getByTestId("season-chip-summer"));

    const after = screen.getByTestId("span-editor-summer-weekend");
    const periodSelect = after.querySelectorAll("select")[2] as HTMLSelectElement;
    expect(periodSelect.value).toBe("peak");
    expect(screen.getByTestId("season-chip-summer-unsaved")).toBeInTheDocument();
  });
});
