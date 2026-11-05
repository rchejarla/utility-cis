import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import RateScheduleDetailPage from "../page";

/**
 * Which hours a tariff is priced against (spec 26, TOU-UI-3).
 *
 * The column and the publish gate have existed since 2026-11-03 with
 * nothing able to set the column, so a TOU tariff could not be
 * published at all. What is worth testing here is the part a person
 * cannot work out from the field itself: that it can be changed only
 * while the schedule is a draft, because a published schedule's hours
 * are part of what was approved.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;

const CALENDARS = [
  { id: "cal-1", name: "TOD 5-8pm", effectiveDate: "2026-06-01", publishedAt: "2026-05-01" },
  { id: "cal-2", name: "TOD 4-9pm", effectiveDate: "2027-06-01", publishedAt: null },
];

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "rs-1",
    name: "Residential TOU",
    code: "RES-TOU",
    effectiveDate: "2026-07-01",
    version: 1,
    publishedAt: null,
    supersededById: null,
    commodity: { name: "Electric" },
    touCalendarId: null,
    touCalendar: null,
    chain: [],
    ...over,
  };
}

function mockGets(row: Record<string, unknown>) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/rate-schedules/rs-1") return Promise.resolve(row);
    if (path === "/api/v1/tou-calendars") return Promise.resolve({ data: CALENDARS });
    return Promise.resolve({ data: [] });
  });
}

/** The route's params are a promise, so the first render suspends. */
async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <RateScheduleDetailPage params={Promise.resolve({ id: "rs-1" })} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a draft schedule", () => {
  it("says it is not time-of-use when it names no calendar", async () => {
    mockGets(schedule());
    await renderPage();

    expect(screen.getByTestId("tou-calendar-field").textContent).toMatch(/not time-of-use/);
  });

  it("holds Save until a calendar is picked", async () => {
    // Otherwise the obvious first click writes back what is already
    // stored, which audits a change nobody made.
    mockGets(schedule());
    await renderPage();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves the calendar that was picked", async () => {
    mockGets(schedule());
    put.mockResolvedValue({});
    await renderPage();

    await userEvent.selectOptions(screen.getByLabelText("TOU calendar"), "cal-1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(put).toHaveBeenCalledWith("/api/v1/rate-schedules/rs-1/tou-calendar", {
      touCalendarId: "cal-1",
    });
  });

  it("offers a draft calendar, and says which one it is", async () => {
    /*
     * Calendar and tariff are usually authored together, so a draft
     * has to be pickable — TOU-CAL-5 binds the published schedule, and
     * Publish is where it refuses. An author who cannot tell the two
     * apart here meets that refusal with no idea which calendar was
     * the problem.
     */
    mockGets(schedule());
    await renderPage();

    const picker = screen.getByLabelText("TOU calendar");
    expect(picker.textContent).toMatch(/TOD 4-9pm — from 2027-06-01 \(draft\)/);
  });

  it("clears it back to not-time-of-use", async () => {
    mockGets(schedule({ touCalendarId: "cal-1", touCalendar: CALENDARS[0] }));
    put.mockResolvedValue({});
    await renderPage();

    await userEvent.selectOptions(screen.getByLabelText("TOU calendar"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(put).toHaveBeenCalledWith("/api/v1/rate-schedules/rs-1/tou-calendar", {
      touCalendarId: null,
    });
  });
});

describe("a published schedule", () => {
  it("names its calendar but offers no way to move it", async () => {
    mockGets(
      schedule({
        publishedAt: "2026-06-15T00:00:00.000Z",
        touCalendarId: "cal-1",
        touCalendar: CALENDARS[0],
      }),
    );
    await renderPage();

    const field = screen.getByTestId("tou-calendar-field");
    expect(field.textContent).toMatch(/TOD 5-8pm/);
    expect(screen.queryByLabelText("TOU calendar")).toBeNull();
    expect(field.textContent).toMatch(/revise the schedule/i);
  });
});
