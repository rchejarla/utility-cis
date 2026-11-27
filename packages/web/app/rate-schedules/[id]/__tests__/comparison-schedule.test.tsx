import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import RateScheduleDetailPage from "../page";

/**
 * Which schedule a shadow bill compares this one against (spec 26,
 * TOU-BIL-4). Pinned: the picker offers only the opposite kind of tariff,
 * once per code; it saves a code; and a published schedule shows its
 * comparison with no way to move it.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;

const SCHEDULES = [
  { code: "RES-TOU", name: "Residential TOU", commodityId: "c-1", touCalendarId: "cal-1" },
  { code: "RES-STD", name: "Residential standard", commodityId: "c-1", touCalendarId: null },
  { code: "RES-STD", name: "Residential standard", commodityId: "c-1", touCalendarId: null },
  { code: "COM-TOU", name: "Commercial TOU", commodityId: "c-1", touCalendarId: "cal-1" },
];

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "rs-1",
    name: "Residential TOU",
    code: "RES-TOU",
    effectiveDate: "2026-07-01",
    version: 2,
    publishedAt: null,
    supersededById: null,
    commodityId: "c-1",
    commodity: { name: "Electric" },
    touCalendarId: "cal-1",
    touCalendar: { id: "cal-1", name: "TOD 5-8pm", effectiveDate: "2026-06-01", publishedAt: "2026-05-01" },
    comparisonScheduleCode: null,
    chain: [],
    ...over,
  };
}

function mockGets(row: Record<string, unknown>) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/rate-schedules/rs-1") return Promise.resolve(row);
    if (path === "/api/v1/rate-schedules") return Promise.resolve({ data: SCHEDULES });
    return Promise.resolve({ data: [] });
  });
}

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

describe("comparison schedule", () => {
  it("offers a TOU tariff only standard rates, each code once", async () => {
    mockGets(schedule());
    await renderPage();

    const picker = await screen.findByLabelText("Comparison schedule");
    const options = within(picker).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(options).toEqual(["", "RES-STD"]);
  });

  it("saves the code that was picked", async () => {
    mockGets(schedule());
    put.mockResolvedValue({ comparisonScheduleCode: "RES-STD" });
    await renderPage();

    await userEvent.selectOptions(await screen.findByLabelText("Comparison schedule"), "RES-STD");
    await userEvent.click(within(screen.getByTestId("comparison-field")).getByRole("button", { name: "Save" }));

    expect(put).toHaveBeenCalledWith("/api/v1/rate-schedules/rs-1/comparison-schedule", {
      comparisonScheduleCode: "RES-STD",
    });
    expect(screen.getByTestId("comparison-field").textContent).toMatch(/RES-STD/);
  });

  it("shows a published schedule's comparison with no way to change it", async () => {
    mockGets(schedule({ publishedAt: "2026-06-15T00:00:00.000Z", comparisonScheduleCode: "RES-STD" }));
    await renderPage();

    const field = screen.getByTestId("comparison-field");
    expect(field.textContent).toMatch(/RES-STD/);
    expect(screen.queryByLabelText("Comparison schedule")).toBeNull();
    expect(field.textContent).toMatch(/revise the schedule/i);
  });
});
