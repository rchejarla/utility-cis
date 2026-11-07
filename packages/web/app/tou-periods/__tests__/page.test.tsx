import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import TouPeriodsPage from "../page";

/**
 * The tenant's TOU periods (spec 26, TOU-CAL-1).
 *
 * One screen for the whole utility. What is worth testing is the two
 * things a person cannot work out from the rows: that a code can never
 * be changed once it exists, and that a period hours are charged at
 * cannot be removed.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;
const del = apiClient.delete as unknown as ReturnType<typeof vi.fn>;

const PERIODS = [
  { id: "p-1", peakCode: "off_peak", label: "Off-peak", sortOrder: 0, spanCount: 15, calendarCount: 2 },
  { id: "p-2", peakCode: "mid_peak", label: "Mid-peak", sortOrder: 1, spanCount: 0, calendarCount: 0 },
  { id: "p-3", peakCode: "peak", label: "On-peak", sortOrder: 2, spanCount: 3, calendarCount: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: PERIODS });
});

const renderPage = () => render(<TouPeriodsPage />);

/**
 * The row a code sits in.
 *
 * The rows are `DataTable`'s, so the test id is on the code cell rather
 * than the `<tr>` — a shared table does not take a per-row attribute,
 * and it should not grow one for a test. The row is its ancestor, which
 * is what the label and the counts are asserted against.
 */
const rowFor = async (code: string) =>
  (await screen.findByTestId(`period-${code}`)).closest("tr") as HTMLElement;

describe("reading the list", () => {
  it("shows every period with its code and label", async () => {
    renderPage();
    expect((await rowFor("mid_peak")).textContent).toMatch(/Mid-peak/);
    expect((await rowFor("peak")).textContent).toMatch(/On-peak/);
  });

  it("says how much is charged at each, which is what makes one removable", async () => {
    renderPage();

    expect((await rowFor("off_peak")).textContent).toMatch(/15 spans in 2 calendars/);
    expect((await rowFor("mid_peak")).textContent).toMatch(/nothing yet/);
  });

  it("counts the tiers in the subtitle, not the calendars", async () => {
    renderPage();
    expect(await screen.findByText(/3 price tiers/)).toBeInTheDocument();
  });
});

describe("the code", () => {
  it("cannot be edited, because it has been copied everywhere", async () => {
    /*
     * The code travels: into every calendar's hours, into a rate
     * component's `quantitySource.peak_code`, and onto meter
     * registers. Renaming it would leave all of them pricing a code
     * that no longer exists, and the database refuses it too.
     */
    renderPage();
    await screen.findByTestId("period-off_peak");

    await userEvent.click(screen.getByRole("button", { name: "Rename off_peak" }));

    expect(screen.getByLabelText("Period label")).toBeInTheDocument();
    expect(screen.queryByLabelText("Period code")).toBeNull();
  });

  it("is typed once, when the period is added", async () => {
    renderPage();
    await screen.findByTestId("period-off_peak");

    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByLabelText("New period code")).toBeInTheDocument();
    expect(screen.getByTestId("new-period").textContent).toMatch(/cannot be changed later/);
  });
});

describe("editing a label", () => {
  it("sends the label and the order, and nothing else", async () => {
    patch.mockResolvedValue({});
    renderPage();
    await screen.findByTestId("period-peak");

    await userEvent.click(screen.getByRole("button", { name: "Rename peak" }));
    const label = screen.getByLabelText("Period label");
    await userEvent.clear(label);
    await userEvent.paste("Peak hours");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const [url, payload] = patch.mock.calls[0];
    expect(url).toBe("/api/v1/tou-periods/p-3");
    expect(Object.keys(payload as object).sort()).toEqual(["label", "sortOrder"]);
  });

  it("will not save an empty label", async () => {
    renderPage();
    await screen.findByTestId("period-peak");

    await userEvent.click(screen.getByRole("button", { name: "Rename peak" }));
    await userEvent.clear(screen.getByLabelText("Period label"));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("puts the row back on Cancel, having written nothing", async () => {
    renderPage();
    await screen.findByTestId("period-peak");

    await userEvent.click(screen.getByRole("button", { name: "Rename peak" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Period label")).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("adding one", () => {
  it("holds Add until both the code and the label are filled", async () => {
    /*
     * The same trap the calendar's old Periods tab had: a blank row
     * whose placeholders look like values, so the obvious next click
     * sends an empty code to a schema demanding one.
     */
    renderPage();
    await screen.findByTestId("period-off_peak");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    await userEvent.click(screen.getByLabelText("New period code"));
    await userEvent.paste("super_off_peak");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    await userEvent.click(screen.getByLabelText("New period label"));
    await userEvent.paste("Super off-peak");
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("treats whitespace as empty, so a space is not a code", async () => {
    renderPage();
    await screen.findByTestId("period-off_peak");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    await userEvent.type(screen.getByLabelText("New period code"), "   ");
    await userEvent.click(screen.getByLabelText("New period label"));
    await userEvent.paste("Spaces");

    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("posts the trimmed code and label", async () => {
    post.mockResolvedValue({});
    renderPage();
    await screen.findByTestId("period-off_peak");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    await userEvent.click(screen.getByLabelText("New period code"));
    await userEvent.paste("super_off_peak");
    await userEvent.click(screen.getByLabelText("New period label"));
    await userEvent.paste("Super off-peak");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/api/v1/tou-periods", {
      peakCode: "super_off_peak",
      label: "Super off-peak",
    });
  });

  it("shows the server's refusal of a duplicate code", async () => {
    post.mockRejectedValue(
      new Error('"peak" is already a period of this utility, called "On-peak".'),
    );
    renderPage();
    await screen.findByTestId("period-off_peak");
    await userEvent.click(screen.getByRole("button", { name: "Add a period" }));

    await userEvent.click(screen.getByLabelText("New period code"));
    await userEvent.paste("peak");
    await userEvent.click(screen.getByLabelText("New period label"));
    await userEvent.paste("Peak");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByTestId("action-error")).toHaveTextContent(/already a period/);
  });
});

describe("removing one", () => {
  it("is offered for a period nothing is charged at", async () => {
    del.mockResolvedValue({});
    renderPage();
    await screen.findByTestId("period-mid_peak");

    const remove = screen.getByRole("button", { name: "Remove mid_peak" });
    expect(remove).toBeEnabled();

    await userEvent.click(remove);
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/tou-periods/p-2"));
  });

  it("is refused for one that hours are charged at, and says why", async () => {
    /*
     * The database says the same through `tou_slot_peak_code_fkey`, but
     * a disabled button with the reason in its tooltip is the same
     * answer given before somebody clicks — and a published calendar's
     * hours can never be reassigned, so some codes are permanent.
     */
    renderPage();
    await screen.findByTestId("period-off_peak");

    const remove = screen.getByRole("button", { name: "Remove off_peak" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", expect.stringMatching(/Reassign them first/));
    expect(del).not.toHaveBeenCalled();
  });
});

describe("when the list cannot be loaded", () => {
  it("says so instead of rendering an empty table", async () => {
    get.mockRejectedValue(new Error("Boom"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Boom/);
  });
});
