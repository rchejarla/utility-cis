import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillsTab } from "../bills-tab";

/**
 * The account's own Bills tab, which lists the same things the Bills
 * page lists and has to say the same about them.
 *
 * It used to show `Bill # · Period · Due · Total · Created` and a
 * "View →" link: no status, no still-owed, and none of the acts, so the
 * same bill read differently depending on which screen you found it on.
 * These cases pin the row to the shared pieces rather than to a copy of
 * them — the shortcut they rule out is deciding status here from the
 * money columns, which is what made every fractional-cent bill read
 * "Part paid" with nothing paid.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function bill(over: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    billNumber: "B-1001",
    periodStart: "2026-02-01",
    periodEnd: "2026-02-28",
    billDate: "2026-03-01",
    dueDate: "2026-03-31",
    total: "107.50",
    createdAt: "2026-03-01T00:00:00.000Z",
    accountId: "acct-1",
    postedAt: "2026-03-01",
    overdue: false,
    partPaid: false,
    charge: { entryId: "le-1", openAmount: "107.50", reversed: false },
    ...over,
  };
}

function renderTab() {
  return render(
    <ToastProvider>
      <BillsTab accountId="acct-1" canEdit />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((url: string) =>
    url.includes("/bills") ? Promise.resolve([bill()]) : Promise.resolve({ data: [] }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Account Bills tab", () => {
  it("shows what is still owed and the bill's settlement status", async () => {
    renderTab();

    await waitFor(() => expect(screen.getByText("B-1001")).toBeInTheDocument());
    expect(screen.getByText("Still owed")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    // Posted, nothing applied, not yet due.
    expect(screen.getByText("Outstanding")).toBeInTheDocument();
    // Created was dropped for Still owed; the tab is not a history view.
    expect(screen.queryByText("Created")).not.toBeInTheDocument();
  });

  it("reads part paid from the API, not from the two money columns", async () => {
    // The trap: a total carrying a fraction of a cent with nothing
    // applied. A browser comparing openAmount to total calls this part
    // paid; the API says it is not, and the row must believe the API.
    get.mockImplementation((url: string) =>
      url.includes("/bills")
        ? Promise.resolve([
            bill({
              total: "10.0049",
              partPaid: false,
              charge: { entryId: "le-1", openAmount: "10.00", reversed: false },
            }),
          ])
        : Promise.resolve({ data: [] }),
    );

    renderTab();

    await waitFor(() => expect(screen.getByText("B-1001")).toBeInTheDocument());
    expect(screen.getByText("Outstanding")).toBeInTheDocument();
    expect(screen.queryByText("Part paid")).not.toBeInTheDocument();
  });

  /**
   * One control per thing, and only one of them called View.
   *
   * The first version of this row kept a "View →" link beside the new
   * "View bill" button — two controls with nearly the same label, one
   * opening the segments and the other the PDF. The bill number carries
   * the detail now, as it does on the Bills page.
   */
  it("opens the bill from its number, and offers the acts it never had", async () => {
    renderTab();

    const number = await screen.findByRole("button", { name: "B-1001" });
    expect(number).toHaveAttribute("title", "View segments and line items");
    expect(screen.queryByRole("button", { name: /^View →$/ })).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: /view bill/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions for B-1001" }),
    ).toBeInTheDocument();
  });
});
