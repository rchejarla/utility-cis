import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import RateSchedulesPage from "../page";

/**
 * What the rate-schedule list has to say about each row.
 *
 * It said nothing about lifecycle: Draft, Published and Superseded all
 * looked identical, while publishing is the one thing that decides
 * whether a schedule can price a bill — and the setup check-list now
 * sends an admin here to publish one. The detail page has carried the
 * badge all along, so the answer existed and the list simply did not
 * show it.
 *
 * The component count is here for the same reason. `publishRateSchedule`
 * requires no components, so a published schedule with none is both
 * reachable and useless: it prices nothing. "Components (coming soon)"
 * stood in this column while the data was one `_count` away.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "rs-1",
    name: "Residential Water",
    code: "RES-W",
    effectiveDate: "2026-01-01",
    version: 1,
    // The API's own spelling: both come back as plain columns on the row.
    publishedAt: null,
    supersededById: null,
    commodity: { name: "Water" },
    _count: { components: 3 },
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * No `restoreAllMocks`: DataTable's breakpoint hook reads the
 * `window.matchMedia` stub installed once in vitest.setup, and restoring
 * mocks strips its implementation — see the billing-cycles list test.
 */

describe("Rate schedules list", () => {
  it("calls an unpublished schedule a draft", async () => {
    get.mockResolvedValue(payload([schedule()]));

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );

    expect(await screen.findByText("Draft")).toBeInTheDocument();
  });

  it("calls a published one published", async () => {
    get.mockResolvedValue(payload([schedule({ publishedAt: "2026-01-02T00:00:00.000Z" })]));

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );

    expect(await screen.findByText("Published")).toBeInTheDocument();
  });

  it("calls a superseded one superseded, published or not", async () => {
    // Supersession wins: a replaced version is still published, and
    // showing it as current is what sends someone to edit the wrong one.
    get.mockResolvedValue(
      payload([schedule({ publishedAt: "2026-01-02T00:00:00.000Z", supersededById: "rs-2" })]),
    );

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );

    expect(await screen.findByText("Superseded")).toBeInTheDocument();
    expect(screen.queryByText("Published")).not.toBeInTheDocument();
  });

  it("shows how many charges a schedule carries", async () => {
    get.mockResolvedValue(payload([schedule({ _count: { components: 3 } })]));

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );

    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it("says none, loudly, for a published schedule with no charges", async () => {
    // The trap the readiness check now refuses to call ready: published,
    // so it looks finished, and it prices nothing.
    get.mockResolvedValue(
      payload([
        schedule({ publishedAt: "2026-01-02T00:00:00.000Z", _count: { components: 0 } }),
      ]),
    );

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );

    // Worded so it cannot be confused with the Expiration column's
    // "None", which means something entirely different.
    expect(await screen.findByText("No charges")).toBeInTheDocument();
  });
});
