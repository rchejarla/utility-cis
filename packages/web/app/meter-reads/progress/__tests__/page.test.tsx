import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import ReadingProgressPage from "../page";

/**
 * Reading progress for a cycle.
 *
 * The question the read log cannot answer, because the rows it wants
 * are the ones that do not exist. Until this screen the only way to
 * find out which meters were still unread was to start a billing run
 * and read the skips — one `NO_READ_IN_WINDOW` per account, after the
 * run had been created and the window had closed behind it.
 *
 * So the screen leads with the count, not the table: "612 of 10,000
 * still to read" is the answer, and the list is what you do about it.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function progress(over: Record<string, unknown> = {}) {
  return {
    billingCycleId: "c-1",
    cycleCode: "R01",
    windowStart: "2026-01-11T00:00:00.000Z",
    windowEnd: "2026-02-10T00:00:00.000Z",
    expected: 4,
    read: 3,
    outstanding: 1,
    data: [
      {
        meterId: "m-9",
        meterNumber: "WM-009",
        agreementNumber: "SA-0009",
        accountNumber: "0001009-00",
        premise: "9 Evergreen Terrace, Springfield",
        lastReadDate: "2025-11-08T00:00:00.000Z",
      },
    ],
    meta: { total: 1, page: 1, limit: 50, pages: 1 },
    ...over,
  };
}

const CYCLES = {
  data: [
    { id: "c-1", cycleCode: "R01", name: "Route 1 - North District" },
    { id: "c-2", cycleCode: "R02", name: "Route 2 - South District" },
  ],
};

function answers(body: Record<string, unknown>) {
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/billing-cycles")) return CYCLES;
    return body;
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <ReadingProgressPage />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reading progress", () => {
  it("picks the tenant's first cycle and asks about it", async () => {
    answers(progress());
    renderPage();

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/meter-reads/progress?billingCycleId=c-1"),
      ),
    );
  });

  it("leads with how much is left, not with the table", async () => {
    answers(progress({ expected: 10000, read: 9388, outstanding: 612 }));
    renderPage();

    expect(await screen.findByText("612")).toBeInTheDocument();
    expect(screen.getByText(/9,388/)).toBeInTheDocument();
    /*
     * The proportion, because 612 of 10,000 and 612 of 700 are
     * different mornings. Floored: 9,388 of 10,000 is 93.88%, and a
     * screen that rounded it to 94 would be claiming progress nobody
     * has made.
     */
    expect(screen.getByText("93%")).toBeInTheDocument();
  });

  it("names the window it is measuring, so it cannot be read as 'ever'", async () => {
    answers(progress());
    renderPage();

    expect(await screen.findByText(/11 Jan 2026|Jan 11, 2026/)).toBeInTheDocument();
  });

  it("lists what is outstanding, with where it is and when it was last read", async () => {
    answers(progress());
    renderPage();

    expect(await screen.findByText("WM-009")).toBeInTheDocument();
    expect(screen.getByText(/9 Evergreen Terrace/)).toBeInTheDocument();
    expect(screen.getByText("0001009-00")).toBeInTheDocument();
    expect(screen.getByText(/Nov 0?8,? 2025|0?8 Nov 2025/)).toBeInTheDocument();
  });

  it("says so when a meter has never been read, rather than printing nothing", async () => {
    answers(
      progress({
        data: [{ ...progress().data[0], lastReadDate: null }],
      }),
    );
    renderPage();

    await screen.findByText("WM-009");
    expect(screen.getByText(/never/i)).toBeInTheDocument();
  });

  it("congratulates nobody when the reading is done", async () => {
    answers(progress({ expected: 4, read: 4, outstanding: 0, data: [], meta: { total: 0, page: 1, limit: 50, pages: 0 } }));
    renderPage();

    // A plain statement of fact: the useful signal is that the number
    // is zero, not a celebration of it.
    expect(await screen.findByText(/all 4 .*read/i)).toBeInTheDocument();
  });

  it("asks again when another cycle is chosen", async () => {
    answers(progress());
    renderPage();
    await screen.findByText("WM-009");

    await userEvent.selectOptions(screen.getByLabelText(/cycle/i), "c-2");

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("billingCycleId=c-2")),
    );
  });
});
