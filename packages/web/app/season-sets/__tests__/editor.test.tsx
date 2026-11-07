import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import SeasonSetEditorPage from "../[id]/page";

/**
 * The season set editor (spec 26, §1).
 *
 * The case that earns this file is the **divergence warning**: a
 * published TOU calendar keeps the season set it names for ever, while
 * non-TOU charges follow whichever set is in force. So publishing a new
 * set gives one customer two definitions of summer, and nothing else in
 * the system would say so. It has to appear *before* the publish button,
 * because a warning after an irreversible step is a post-mortem.
 */
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "set-1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/season-sets/set-1",
  useSearchParams: () => new URLSearchParams(),
}));

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

const SEASONS = [
  {
    seasonCode: "summer",
    label: "Summer",
    startMonth: 6,
    startDay: 1,
    endMonth: 9,
    endDay: 30,
  },
  {
    seasonCode: "non_summer",
    label: "Non-summer",
    startMonth: 10,
    startDay: 1,
    endMonth: 5,
    endDay: 31,
  },
];

function coverage() {
  const days = [];
  for (let month = 1; month <= 12; month++) {
    const length = new Date(Date.UTC(2028, month, 0)).getUTCDate();
    for (let day = 1; day <= length; day++) {
      days.push({
        month,
        day,
        claimedBy: [month >= 6 && month <= 9 ? "summer" : "non_summer"],
      });
    }
  }
  return days;
}

function seasonSet(over: Record<string, unknown> = {}) {
  return {
    id: "set-1",
    name: "Summer and winter",
    effectiveDate: "2026-01-01",
    publishedAt: null,
    spanRule: "START_DATE",
    seasons: SEASONS,
    coverage: coverage(),
    validation: { ok: true },
    calendarsOnOtherSets: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(seasonSet());
});

const renderPage = () => render(<SeasonSetEditorPage />);

describe("reading a set", () => {
  it("shows its name and when it comes into force", async () => {
    renderPage();
    expect(await screen.findByText("Summer and winter")).toBeInTheDocument();
    expect(screen.getByText(/In force from 2026-01-01/)).toBeInTheDocument();
  });

  it("draws the year bar from the server's coverage", async () => {
    renderPage();
    await screen.findByText("Summer and winter");
    expect(screen.getByTestId("year-strip").children).toHaveLength(366);
  });

  it("says plainly when the year is covered, mentioning the leap day", async () => {
    renderPage();
    const ready = await screen.findByTestId("season-ready");
    expect(ready.textContent).toMatch(/29 February/);
  });

  it("lists the problems by date when it is not", async () => {
    get.mockResolvedValue(
      seasonSet({
        validation: {
          ok: false,
          problems: [
            "29 February belongs to no season.",
            "1 July belongs to both \"summer\" and \"winter\".",
          ],
        },
      }),
    );
    renderPage();
    const problems = await screen.findByTestId("season-problems");
    expect(problems.textContent).toMatch(/2 problems/);
    expect(problems.textContent).toMatch(/29 February/);
    expect(problems.textContent).toMatch(/1 July/);
  });

  it("offers a season that wraps the year end as one row", async () => {
    // 1 October to 31 May is one season. The editor must not force it
    // into two, which is what a from/to pair that refuses to wrap does.
    renderPage();
    await screen.findByText("Summer and winter");
    expect(screen.getByLabelText("non_summer start month")).toHaveValue("10");
    expect(screen.getByLabelText("non_summer end month")).toHaveValue("5");
  });
});

describe("the divergence warning", () => {
  const withDiverging = () =>
    seasonSet({
      calendarsOnOtherSets: [
        {
          id: "cal-1",
          name: "TOD 5-8pm",
          effectiveDate: "2026-01-01",
          seasonSetName: "Old seasons",
        },
      ],
    });

  it("appears before publishing, phrased as what will happen", async () => {
    get.mockResolvedValue(withDiverging());
    renderPage();
    const warning = await screen.findByTestId("diverging-calendars");
    expect(warning.textContent).toMatch(/Once this set is published/);
    expect(warning.textContent).toMatch(/TOD 5-8pm/);
    expect(warning.textContent).toMatch(/Old seasons/);
  });

  it("explains that the split is deliberate, and what to do about it", async () => {
    get.mockResolvedValue(withDiverging());
    renderPage();
    const warning = await screen.findByTestId("diverging-calendars");
    expect(warning.textContent).toMatch(/two different definitions of summer/);
    expect(warning.textContent).toMatch(/publish a new calendar version/);
  });

  it("phrases it in the past once the set is published", async () => {
    get.mockResolvedValue({
      ...withDiverging(),
      publishedAt: "2026-01-02T00:00:00.000Z",
    });
    renderPage();
    const warning = await screen.findByTestId("diverging-calendars");
    expect(warning.textContent).toMatch(/Since this set took effect/);
  });

  it("links to the calendar, because the fix is on that screen", async () => {
    get.mockResolvedValue(withDiverging());
    renderPage();
    await screen.findByTestId("diverging-calendars");
    expect(screen.getByRole("link", { name: "TOD 5-8pm" })).toHaveAttribute(
      "href",
      "/tou-calendars/cal-1",
    );
  });

  it("shows nothing when no calendar diverges", async () => {
    renderPage();
    await screen.findByText("Summer and winter");
    expect(screen.queryByTestId("diverging-calendars")).toBeNull();
  });

  it("confirms after publishing when nothing diverges", async () => {
    post.mockResolvedValue({ calendarsOnOtherSets: [] });
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByTestId("publish-clean")).toBeInTheDocument();
  });
});

describe("editing the seasons", () => {
  it("sends the whole list", async () => {
    put.mockResolvedValue(seasonSet());
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.selectOptions(screen.getByLabelText("summer start month"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save seasons" }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, payload] = put.mock.calls[0];
    expect(url).toBe("/api/v1/season-sets/set-1/seasons");
    expect((payload as { seasons: unknown[] }).seasons).toHaveLength(2);
    expect((payload as { seasons: Array<{ startMonth: number }> }).seasons[0].startMonth).toBe(5);
  });

  it("keeps Save unavailable until something changes", async () => {
    renderPage();
    await screen.findByText("Summer and winter");
    expect(screen.getByRole("button", { name: "Save seasons" })).toBeDisabled();
  });

  it("says the bar is of the saved seasons while edits are pending", async () => {
    /*
     * The bar comes from the server's coverage, which is the same
     * computation that decides publishability. Redrawing it from the
     * unsaved rows would mean a second implementation of the wrap
     * arithmetic in the browser — so instead the screen admits the bar
     * is behind.
     */
    renderPage();
    await screen.findByText("Summer and winter");
    expect(screen.queryByTestId("bar-is-stale")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("summer start month"), "5");

    expect(await screen.findByTestId("bar-is-stale")).toBeInTheDocument();
  });

  it("offers day 1–31 whatever the month, leaving 30 February to the validator", async () => {
    // A silently shortened day list would change a tenant's choice of
    // the 31st under them when they switch month; the validator's
    // sentence names the season and the date instead.
    renderPage();
    await screen.findByText("Summer and winter");
    const days = screen.getByLabelText("summer end day") as HTMLSelectElement;
    expect(days.options).toHaveLength(31);
  });

  it("shows the server's refusal", async () => {
    put.mockRejectedValue(
      new Error('"summer" is used by hours in "TOD 5-8pm". Clear those hours first.'),
    );
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.selectOptions(screen.getByLabelText("summer start month"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save seasons" }));

    expect(await screen.findByTestId("action-error")).toHaveTextContent(/used by hours/);
  });
});

describe("a published set", () => {
  const publishedSet = () => seasonSet({ publishedAt: "2026-01-02T00:00:00.000Z" });

  it("explains why it is read-only in terms of what depends on it", async () => {
    get.mockResolvedValue(publishedSet());
    renderPage();
    const notice = await screen.findByTestId("published-notice");
    expect(notice.textContent).toMatch(/TOU calendars and rate components are keyed on/);
    expect(notice.textContent).toMatch(/later effective date/);
  });

  it("offers no Publish, no Save and no delete", async () => {
    get.mockResolvedValue(publishedSet());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save seasons" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete this draft/ })).toBeNull();
  });

  it("still shows the year bar, which is what it is read for", async () => {
    get.mockResolvedValue(publishedSet());
    renderPage();
    await screen.findByTestId("published-notice");
    expect(screen.getByTestId("year-strip")).toBeInTheDocument();
  });
});

describe("publishing", () => {
  it("shows the refusal with its problems kept as a list", async () => {
    post.mockRejectedValue(
      new Error(
        '"Summer and winter" does not yet cover every day of the year exactly once, so a bill could fall in no season or in two:\n  • 29 February belongs to no season.',
      ),
    );
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    const error = await screen.findByTestId("action-error");
    expect(error.textContent).toMatch(/no season or in two/);
    expect(error.textContent).toMatch(/29 February/);
    expect(error).toHaveStyle({ whiteSpace: "pre-wrap" });
  });
});

describe("when the set cannot be loaded", () => {
  it("says so rather than rendering an empty editor", async () => {
    get.mockRejectedValue(new Error("There is no season set with that id."));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no season set with that id/);
  });
});

describe("rows nobody has filled in", () => {
  it("will not save a season with no code", async () => {
    /*
     * The same trap as the TOU editors: "Add a season" creates a row
     * whose placeholders look like values, and saving it came back
     * "Validation failed" naming neither the field nor the row.
     */
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.click(screen.getByRole("button", { name: "Add a season" }));

    expect(screen.getByRole("button", { name: "Save seasons" })).toBeDisabled();
    expect(screen.getByTestId("seasons-incomplete").textContent).toMatch(/Row 3/);
    expect(put).not.toHaveBeenCalled();
  });

  it("lets it through once the row is filled in", async () => {
    put.mockResolvedValue(seasonSet());
    renderPage();
    await screen.findByText("Summer and winter");

    await userEvent.click(screen.getByRole("button", { name: "Add a season" }));
    const codes = screen.getAllByLabelText("Season code");
    const labels = screen.getAllByLabelText("Season label");
    await userEvent.type(codes[codes.length - 1], "shoulder");
    await userEvent.type(labels[labels.length - 1], "Shoulder");

    expect(screen.queryByTestId("seasons-incomplete")).toBeNull();
    expect(screen.getByRole("button", { name: "Save seasons" })).toBeEnabled();
  });
});
