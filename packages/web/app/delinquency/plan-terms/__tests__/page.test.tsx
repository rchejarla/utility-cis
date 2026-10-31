import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { DEFAULT_PLAN_TERMS } from "@utility-cis/shared";
import PlanTermsPage from "../page";

/**
 * The tenant's payment-plan terms, under Collections beside the rules.
 *
 * The third test is the one that matters most. `autoPostBills` shipped
 * readable and settable with no control drawn, so manual posting was
 * reachable only by SQL — a setting nobody can edit is an orphan, and
 * this namespace has eleven chances to repeat that. The guard derives
 * what must be on screen from the schema's own defaults, so adding a
 * twelfth term without a control fails here rather than shipping
 * invisible.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const put = apiClient.put as unknown as ReturnType<typeof vi.fn>;

function saved(over: Record<string, unknown> = {}) {
  return { terms: { ...DEFAULT_PLAN_TERMS, ...over } };
}

beforeEach(() => {
  vi.clearAllMocks();
  put.mockResolvedValue({ terms: DEFAULT_PLAN_TERMS });
});

function renderPage() {
  return render(
    <ToastProvider>
      <PlanTermsPage />
    </ToastProvider>,
  );
}

describe("plan terms screen", () => {
  it("renders the tenant's saved values, not the shipped defaults", async () => {
    get.mockResolvedValue(saved({ downPaymentPercent: 15, maxInstallments: 6 }));
    renderPage();

    // 15 and 6 are this tenant's; 25 and 12 are what it would show if
    // the page ignored the response and drew the defaults.
    await waitFor(() => {
      expect(screen.getByLabelText(/down payment/i)).toHaveValue(15);
    });
    expect(screen.getByLabelText(/at most/i)).toHaveValue(6);
  });

  it("sends the whole namespace on save, not only what was touched", async () => {
    // The API replaces `settings.paymentPlans` wholesale, so a partial
    // body would drop every key the operator did not touch back to its
    // default — silently, because both bodies parse.
    get.mockResolvedValue(saved({ graceDays: 3 }));
    renderPage();

    await waitFor(() => expect(screen.getByLabelText(/down payment/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [, body] = put.mock.calls[0];
    expect(Object.keys(body).sort()).toEqual(Object.keys(DEFAULT_PLAN_TERMS).sort());
    expect(body.graceDays).toBe(3);
  });

  it("draws a control for every term the schema defines", async () => {
    get.mockResolvedValue(saved());
    renderPage();

    await waitFor(() => expect(screen.getByLabelText(/down payment/i)).toBeInTheDocument());

    // Derived from the schema, so a new term with no control fails here.
    for (const key of Object.keys(DEFAULT_PLAN_TERMS)) {
      expect(
        screen.getByTestId(`term-${key}`),
        `no control on screen for the "${key}" term — a setting nobody can edit is an orphan`,
      ).toBeInTheDocument();
    }
  });

  it("offers no instalment range that excludes every plan", async () => {
    get.mockResolvedValue(saved({ minInstallments: 3, maxInstallments: 12 }));
    renderPage();

    await waitFor(() => expect(screen.getByLabelText(/at least/i)).toBeInTheDocument());
    const max = screen.getByLabelText(/at most/i);
    /*
     * One change event, not `clear` then `type`.
     *
     * `Num` keeps a draft string and resyncs it from the parent on every
     * `value` change, so a clear-then-type sequence has an intermediate
     * state where the draft is empty and the parent still holds the old
     * number. Under a loaded suite run this test lost that race while
     * passing alone: the click arrived before the parent had 2, so Save
     * saw a valid range and legitimately called the API. Setting the
     * value in a single event removes the intermediate state.
     */
    fireEvent.change(max, { target: { value: "2" } });
    await waitFor(() => expect(max).toHaveValue(2));

    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    // Refused client-side: the API would reject it too, but an operator
    // should not need a round trip to be told.
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText(/at least the minimum/i)).toBeInTheDocument();
  });
});
