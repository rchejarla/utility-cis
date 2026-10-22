import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillSegmentsTab } from "../bill-segments-tab";

/**
 * A service agreement's bill segments — one per billed period.
 *
 * This is the only tab that lists them. A second one existed for a few
 * hours on 2026-10-22, when the agreement's mock "Billing" tab was
 * rewritten against these same two endpoints without noticing this tab
 * already consumed them; it was deleted and the two things it had that
 * this did not were folded in here.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function segment(over: Record<string, unknown> = {}) {
  return {
    id: "seg-1",
    segmentNumber: "7",
    periodStart: "2026-02-01T00:00:00.000Z",
    periodEnd: "2026-02-28T00:00:00.000Z",
    total: "90.0000",
    minimumFloorApplied: false,
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  };
}

function renderTab(segments: unknown[]) {
  get.mockImplementation((url: string) => {
    if (url.includes("/bill-segments")) return Promise.resolve(segments);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  return render(
    <ToastProvider>
      <BillSegmentsTab saId="sa-1" canEdit />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Agreement bill segments", () => {
  it("sums what the agreement has been charged", async () => {
    renderTab([segment(), segment({ id: "seg-2", segmentNumber: "6", total: "10.5000" })]);

    // Two segments, $100.50 between them. Without a total, answering
    // "what has this agreement cost" means adding the column up by hand.
    const summary = await screen.findByTestId("segment-summary");
    expect(summary).toHaveTextContent("2");
    expect(summary).toHaveTextContent("$100.50");
  });

  it("marks a segment priced at the tariff minimum rather than on usage", async () => {
    renderTab([segment({ minimumFloorApplied: true })]);

    // The figure alone looks like ordinary usage, so without this the
    // screen cannot answer "why is my bill the same every month".
    const table = await screen.findByRole("table");
    expect(within(table).getByText(/minimum/i)).toBeInTheDocument();
  });

  it("does not mark a segment priced on metered usage", async () => {
    renderTab([segment({ minimumFloorApplied: false })]);

    const table = await screen.findByRole("table");
    expect(within(table).queryByText(/minimum/i)).toBeNull();
  });
});
