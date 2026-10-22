import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillsList } from "../bills-list";

/**
 * The portal's Bills screen.
 *
 * Bills hang off an Account, and a portal customer can hold more than
 * one, so this reads `/portal/api/accounts` and then each account's
 * bills rather than asking for a customer-wide list that the data model
 * does not have.
 *
 * Until 2026-10-22 all of this was `lib/mock-billing`: invented invoice
 * numbers, a fabricated on-time-rate, and a balance owed that no
 * customer owed.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function account(over: Record<string, unknown> = {}) {
  return { id: "acc-1", accountNumber: "A-100", ...over };
}

/**
 * The shape the API returns, including the settlement fields the status
 * pill reads. `charge.openAmount` is what is still owed — deliberately
 * not derived here from total minus something, which is the bug the
 * shared pill exists to prevent.
 */
function bill(over: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    billNumber: "B-1001",
    periodStart: "2026-02-01T00:00:00.000Z",
    periodEnd: "2026-02-28T00:00:00.000Z",
    billDate: "2026-03-01T00:00:00.000Z",
    dueDate: "2026-03-31T00:00:00.000Z",
    total: "90.0000",
    postedAt: "2026-03-01T00:00:00.000Z",
    overdue: false,
    partPaid: false,
    charge: { entryId: "le-1", openAmount: "90.0000", reversed: false },
    ...over,
  };
}

function route(accounts: unknown[], billsByAccount: Record<string, unknown[]>) {
  get.mockImplementation((url: string) => {
    if (url === "/portal/api/accounts") return Promise.resolve({ data: accounts });
    const m = url.match(/^\/portal\/api\/accounts\/([^/]+)\/bills$/);
    if (m) return Promise.resolve({ data: billsByAccount[m[1]] ?? [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderList() {
  return render(
    <ToastProvider>
      <BillsList />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Portal bills list", () => {
  it("lists the customer's bills across their accounts", async () => {
    route([account()], { "acc-1": [bill()] });

    renderList();

    await waitFor(() => {
      expect(screen.getByText("B-1001")).toBeInTheDocument();
    });
    expect(get).toHaveBeenCalledWith("/portal/api/accounts");
    expect(get).toHaveBeenCalledWith("/portal/api/accounts/acc-1/bills");
  });

  it("owes the open amount, not the sum of the totals", async () => {
    // A settled bill and an open one. Adding the totals would say $140
    // is due when only $90 is.
    route([account()], {
      "acc-1": [
        bill(),
        bill({
          id: "bill-2",
          billNumber: "B-0999",
          total: "50.0000",
          charge: { entryId: "le-2", openAmount: "0.0000", reversed: false },
        }),
      ],
    });

    renderList();

    await waitFor(() => {
      expect(screen.getByText("B-0999")).toBeInTheDocument();
    });
    const due = screen.getByTestId("portal-amount-due");
    expect(due).toHaveTextContent("$90.00");
  });

  it("names the account on each row when there is more than one", async () => {
    route([account(), account({ id: "acc-2", accountNumber: "A-200" })], {
      "acc-1": [bill()],
      "acc-2": [bill({ id: "bill-9", billNumber: "B-2001" })],
    });

    renderList();

    await waitFor(() => {
      expect(screen.getByText("B-2001")).toBeInTheDocument();
    });
    const table = screen.getByRole("table");
    expect(within(table).getByText("A-100")).toBeInTheDocument();
    expect(within(table).getByText("A-200")).toBeInTheDocument();
  });

  it("leaves the account column out when there is only one", async () => {
    route([account()], { "acc-1": [bill()] });

    renderList();

    await waitFor(() => {
      expect(screen.getByText("B-1001")).toBeInTheDocument();
    });
    // One account is the common case; a column repeating the same number
    // on every row is noise on a phone-width screen.
    expect(screen.queryByRole("columnheader", { name: /account/i })).toBeNull();
  });

  it("says there are no bills yet rather than showing an empty table", async () => {
    route([account()], { "acc-1": [] });

    renderList();

    await waitFor(() => {
      expect(screen.getByText(/no bills yet/i)).toBeInTheDocument();
    });
  });

  it("shows settlement state from the API's own fields", async () => {
    route([account()], {
      "acc-1": [bill({ charge: { entryId: "le-1", openAmount: "0.0000", reversed: false } })],
    });

    renderList();

    await waitFor(() => {
      expect(screen.getByText("Paid")).toBeInTheDocument();
    });
  });
});
