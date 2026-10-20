import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * The filter, and the one join where it can silently break.
 *
 * Active/Inactive was wrong at both ends: the API read `active` as "has
 * no expiration date", and the string "false" a select box sends parsed
 * as `true`, so both options returned the same rows — a filter that had
 * never worked and looked like it did. What this pins is the parameter
 * name and the values, because that is what the server validates and
 * what nothing else would catch: a mismatch here is a 400 or, worse, an
 * ignored filter.
 */
describe("Rate schedules list filter", () => {
  it("offers the lifecycle states, not Active and Inactive", async () => {
    get.mockResolvedValue(payload([schedule()]));

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );
    await screen.findByText("Draft");

    await userEvent.click(screen.getByRole("button", { name: /^Status/ }));

    // "Draft" also appears as the row's own badge, so count rather
    // than demand a single match.
    for (const label of ["Draft", "Published", "Superseded", "All Status"]) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("button", { name: /^Active/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
  });

  it("asks the API for the state that was chosen, by the name it validates", async () => {
    get.mockResolvedValue(payload([schedule()]));

    render(
      <ToastProvider>
        <RateSchedulesPage />
      </ToastProvider>,
    );
    await screen.findByText("Draft");

    await userEvent.click(screen.getByRole("button", { name: /^Status/ }));
    await userEvent.click(screen.getByText("Published"));

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/rate-schedules",
        expect.objectContaining({ status: "published" }),
      ),
    );
  });
});
