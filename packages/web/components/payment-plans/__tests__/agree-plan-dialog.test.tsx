import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { DEFAULT_PLAN_TERMS } from "@utility-cis/shared";
import { AgreePlanDialog } from "../agree-plan-dialog";

/**
 * Agreeing a plan on a phone call.
 *
 * The screen proposes and the operator adjusts; it does not present nine
 * empty fields and validate afterwards. Nobody does arithmetic, and no
 * refusal waits until Save.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;

/** Today, so the "not yet due" rule can be exercised without a clock. */
const today = new Date().toISOString().slice(0, 10);
function daysOut(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function ledgerRow(over: Record<string, unknown> = {}) {
  return {
    id: "e-1",
    type: "ADJUSTMENT_DEBIT",
    amount: "412.80",
    openAmount: "412.80",
    settled: false,
    dueDate: daysOut(-100),
    reasonLabel: "Opening balance",
    billNumber: null,
    billId: null,
    assessedOnBillNumber: null,
    assessedOnBillId: null,
    ...over,
  };
}

const DEBTS = [
  ledgerRow(),
  ledgerRow({
    id: "e-2",
    type: "BILL_CHARGE",
    amount: "110.75",
    openAmount: "55.37",
    dueDate: daysOut(-44),
    reasonLabel: null,
    billNumber: "BILL-202608-1",
    billId: "b-1",
  }),
  ledgerRow({
    id: "e-3",
    type: "FEE",
    amount: "25.00",
    openAmount: "25.00",
    dueDate: daysOut(5),
    reasonLabel: "Late payment fee",
    assessedOnBillNumber: "BILL-202608-1",
    assessedOnBillId: "b-1",
  }),
  ledgerRow({
    id: "e-4",
    type: "BILL_CHARGE",
    amount: "37.87",
    openAmount: "37.87",
    dueDate: daysOut(12),
    reasonLabel: null,
    billNumber: "BILL-202610-2",
    billId: "b-2",
  }),
];

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <ToastProvider>
      <AgreePlanDialog accountId="acc-1" onClose={() => {}} onAgreed={() => {}} {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation((url: string) =>
    url.includes("plan-terms")
      ? Promise.resolve({ terms: DEFAULT_PLAN_TERMS })
      : Promise.resolve({ data: DEBTS, meta: { total: DEBTS.length } }),
  );
  post.mockResolvedValue({ planId: "plan-1", schedule: [] });
});

describe("agree plan dialog", () => {
  it("proposes the down payment and the schedule from the tenant's terms", async () => {
    renderDialog();

    // Overdue only: 412.80 + 55.37 + 25.00 = 493.17 at 25% = 123.29.
    await waitFor(() => expect(screen.getByLabelText(/down payment/i)).toHaveValue(123.29));
  });

  it("opens a not-yet-due bill charge unticked, and its own late fee ticked", async () => {
    // Design §4b. The proposed total is the past-due balance. A fee left
    // out would climb the ladder while its parent bill was suppressed.
    renderDialog();

    await waitFor(() => expect(screen.getByLabelText(/debt-e-1/i)).toBeChecked());
    expect(screen.getByLabelText(/debt-e-2/i)).toBeChecked();
    // The fee falls due in five days and is still ticked.
    expect(screen.getByLabelText(/debt-e-3/i)).toBeChecked();
    // The bill does not.
    expect(screen.getByLabelText(/debt-e-4/i)).not.toBeChecked();
  });

  it("recomputes the total and the down payment when a debt is unticked", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/debt-e-1/i)).toBeChecked());

    await userEvent.click(screen.getByLabelText(/debt-e-1/i));

    // 493.17 - 412.80 = 80.37, at 25% = 20.09.
    await waitFor(() => expect(screen.getByLabelText(/down payment/i)).toHaveValue(20.09));
  });

  it("offers only instalment counts the terms allow", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByLabelText(/instalments/i)).toBeInTheDocument());
    const options = Array.from(
      screen.getByLabelText(/instalments/i).querySelectorAll("option"),
    ).map((o) => Number(o.value));

    expect(Math.min(...options)).toBe(DEFAULT_PLAN_TERMS.minInstallments);
    expect(Math.max(...options)).toBe(DEFAULT_PLAN_TERMS.maxInstallments);
  });

  it("shows a covered debt with no bill, which an opening balance is", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByText("Opening balance")).toBeInTheDocument());
    expect(screen.getByText("BILL-202608-1")).toBeInTheDocument();
    // The fee names the bill it was raised on.
    expect(screen.getByText(/for BILL-202608-1/i)).toBeInTheDocument();
  });

  it("renders the schedule as dates and amounts, not a count and a frequency", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByLabelText(/down payment/i)).toBeInTheDocument());
    expect(screen.getByText(today)).toBeInTheDocument();
  });

  it("refuses to agree a plan over nothing, at the control", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/debt-e-1/i)).toBeChecked());

    for (const id of ["e-1", "e-2", "e-3"]) {
      await userEvent.click(screen.getByLabelText(new RegExp(`debt-${id}`, "i")));
    }
    await userEvent.click(screen.getByRole("button", { name: /agree/i }));

    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText(/at least one debt/i)).toBeInTheDocument();
  });

  it("sends the ticked debts and the chosen terms", async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByLabelText(/debt-e-1/i)).toBeChecked());

    await userEvent.click(screen.getByRole("button", { name: /agree/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/api/v1/accounts/acc-1/payment-plans");
    expect(body.entryIds.sort()).toEqual(["e-1", "e-2", "e-3"]);
    expect(body.installmentCount).toBe(DEFAULT_PLAN_TERMS.minInstallments);
  });
});
