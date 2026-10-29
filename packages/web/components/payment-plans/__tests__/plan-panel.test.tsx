import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { PlanPanel } from "../plan-panel";

/**
 * What a CSR reads about a plan while the customer is on the phone.
 *
 * Four questions in call order, and the first is the one the status
 * column cannot answer: `ACTIVE` says nothing about whether the customer
 * is keeping to it, and "are they keeping to it" is what the caller
 * actually wants to know.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function plan(over: Record<string, unknown> = {}) {
  return {
    id: "plan-1",
    accountId: "acc-1",
    status: "ACTIVE",
    totalBalance: "468.17",
    downPayment: "117.04",
    installmentAmount: "58.52",
    installmentCount: 6,
    installmentFrequency: "MONTHLY",
    startDate: "2026-10-28",
    notes: null,
    approvedBy: "user-1",
    statusChangedAt: "2026-10-28T00:00:00.000Z",
    createdAt: "2026-10-28T00:00:00.000Z",
    paidToDate: "117.04",
    progress: {
      due: 1,
      late: 0,
      missed: 0,
      onTrack: true,
      remaining: "351.13",
      broken: false,
      installmentsBehind: 0,
    },
    schedule: [
      { dueDate: "2026-10-28", amount: "117.04" },
      { dueDate: "2026-11-28", amount: "58.53" },
      { dueDate: "2026-12-28", amount: "58.52" },
    ],
    covers: [
      {
        entryId: "e-1",
        type: "ADJUSTMENT_DEBIT",
        amount: "412.80",
        openAmount: "412.80",
        dueDate: "2026-07-15",
        reasonLabel: "Opening balance",
        billNumber: null,
        billId: null,
        assessedOnBillNumber: null,
        assessedOnBillId: null,
      },
      {
        entryId: "e-2",
        type: "BILL_CHARGE",
        amount: "110.75",
        openAmount: "55.37",
        dueDate: "2026-09-14",
        reasonLabel: null,
        billNumber: "BILL-202608-1",
        billId: "b-1",
        assessedOnBillNumber: null,
        assessedOnBillId: null,
      },
    ],
    ...over,
  };
}

function renderPanel(props: Record<string, unknown> = {}) {
  return render(
    <ToastProvider>
      <PlanPanel accountId="acc-1" {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("plan panel", () => {
  it("says the customer is behind, which the status alone does not", async () => {
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(
            plan({
              progress: {
                due: 2,
                late: 1,
                missed: 0,
                onTrack: false,
                remaining: "351.13",
                broken: false,
                installmentsBehind: 1,
              },
            }),
          )
        : Promise.resolve({ data: [{ id: "plan-1", status: "ACTIVE" }] }),
    );

    renderPanel();

    // Not just "ACTIVE".
    await waitFor(() => expect(screen.getByText(/1 payment behind/i)).toBeInTheDocument());
  });

  it("says on track when nothing due is unpaid", async () => {
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(plan())
        : Promise.resolve({ data: [{ id: "plan-1", status: "ACTIVE" }] }),
    );

    renderPanel();

    await waitFor(() => expect(screen.getByText(/on track/i)).toBeInTheDocument());
  });

  it("shows a covered debt with no bill, which an opening balance is", async () => {
    // Two of the five real debits on a converted account have no bill
    // number. A panel built against bill charges alone renders a blank.
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(plan())
        : Promise.resolve({ data: [{ id: "plan-1", status: "ACTIVE" }] }),
    );

    renderPanel();

    await waitFor(() => expect(screen.getByText("Opening balance")).toBeInTheDocument());
    expect(screen.getByText("BILL-202608-1")).toBeInTheDocument();
  });

  it("shows what is left and what is next, not only the total", async () => {
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(plan())
        : Promise.resolve({ data: [{ id: "plan-1", status: "ACTIVE" }] }),
    );

    renderPanel();

    await waitFor(() => expect(screen.getByText(/\$351\.13/)).toBeInTheDocument());
    expect(screen.getByText(/\$468\.17/)).toBeInTheDocument();
  });

  it("warns when an unpaid new bill puts the plan at risk", async () => {
    // The failure a customer most easily trips while paying every
    // instalment faithfully, and it is only knowable by reading two
    // screens unless the panel says it.
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(plan({ currentBillCounts: true }))
        : Promise.resolve({ data: [{ id: "plan-1", status: "ACTIVE" }] }),
    );

    renderPanel({ uncoveredPastDue: { billNumber: "BILL-202610-2", amount: "37.87" } });

    await waitFor(() =>
      expect(screen.getByText(/plan breaks if it is not paid/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/BILL-202610-2/)).toBeInTheDocument();
  });

  it("offers to agree one when the account has no live plan", async () => {
    get.mockResolvedValue({ data: [] });

    renderPanel();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /agree a plan/i })).toBeInTheDocument(),
    );
  });

  it("shows a defaulted plan with the date it broke", async () => {
    get.mockImplementation((url: string) =>
      url.includes("/payment-plans/")
        ? Promise.resolve(
            plan({ status: "DEFAULTED", statusChangedAt: "2026-12-20T00:00:00.000Z" }),
          )
        : Promise.resolve({ data: [{ id: "plan-1", status: "DEFAULTED" }] }),
    );

    renderPanel();

    await waitFor(() => expect(screen.getByText(/DEFAULTED/i)).toBeInTheDocument());
    expect(screen.getByText(/2026-12-20/)).toBeInTheDocument();
  });
});
