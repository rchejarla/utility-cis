import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import DelinquencyRulesPage from "../page";

/**
 * Configuring what a delinquency tier charges.
 *
 * The screen's job here is a unit conversion, and it is the one place a
 * mistake is invisible from the API's side. `fee_amount` stores a
 * **rate** under PERCENT_OF_BALANCE — 0.0150 is 1.5% — and the field is
 * labelled "Rate (%)", so an operator types 1.5. Send that through
 * unconverted and the tenant has a 0.015% late fee: the API accepts it,
 * every constraint passes, and the only symptom is fees two orders of
 * magnitude too small months later.
 *
 * The other cases pin the grouping rule the API enforces — feeType,
 * feeAmount and feeReasonId are set and cleared together — because the
 * server rejects a partial update with a 400 and the operator sees only
 * a failed save.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;
const patch = apiClient.patch as unknown as ReturnType<typeof vi.fn>;

const REASON = { id: "reason-late", code: "LATE_FEE", label: "Late payment fee" };

function rule(over: Record<string, unknown> = {}) {
  return {
    id: "rule-1",
    name: "First notice",
    tier: 1,
    daysPastDue: 15,
    minBalance: "10.00",
    actionType: "NOTICE_EMAIL",
    autoApply: true,
    isActive: true,
    feeType: null,
    feeAmount: null,
    maxFee: null,
    feeReasonId: null,
    feeMode: "ACCUMULATE",
    serviceRequestTypeCode: null,
    reconnectRequestTypeCode: null,
    ...over,
  };
}

/** The three calls the page makes: rules, fee reasons, request types. */
function stubLoads(rules: unknown[]) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/delinquency-rules") return Promise.resolve({ data: rules });
    if (path === "/api/v1/ar/reasons") return Promise.resolve({ data: [REASON] });
    if (path === "/api/v1/service-request-types") {
      return Promise.resolve([{ code: "SHUT_OFF", label: "Shut off for non-payment" }]);
    }
    return Promise.resolve({ data: [] });
  });
}

/** Open the editor on the one rule in the table. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  render(
    <ToastProvider>
      <DelinquencyRulesPage />
    </ToastProvider>,
  );
  await user.click(await screen.findByText("First notice"));
  return screen.findByText(/Edit Tier 1/);
}

beforeEach(() => {
  vi.clearAllMocks();
  patch.mockResolvedValue({});
});

describe("the late fee on a delinquency tier", () => {
  it("sends a percentage as the rate the column stores, not the number typed", async () => {
    const user = userEvent.setup();
    stubLoads([rule()]);
    await openEditor(user);

    await user.selectOptions(screen.getByLabelText("Charge"), "PERCENT_OF_BALANCE");
    await user.type(await screen.findByPlaceholderText("e.g. 1.5"), "1.5");
    await user.selectOptions(await screen.findByLabelText("Book it to"), REASON.id);
    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toMatchObject({
      feeType: "PERCENT_OF_BALANCE",
      // 1.5% — not "1.5", which would be 150%.
      feeAmount: "0.0150",
      feeReasonId: REASON.id,
    });
  });

  it("sends a flat amount as money", async () => {
    const user = userEvent.setup();
    stubLoads([rule()]);
    await openEditor(user);

    await user.selectOptions(screen.getByLabelText("Charge"), "FLAT_FEE");
    await user.type(await screen.findByPlaceholderText("e.g. 25.00"), "25");
    await user.selectOptions(await screen.findByLabelText("Book it to"), REASON.id);
    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toMatchObject({
      feeType: "FLAT_FEE",
      feeAmount: "25.00",
      maxFee: null,
    });
  });

  it("shows a stored rate back as a percentage", async () => {
    const user = userEvent.setup();
    stubLoads([rule({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.015", feeReasonId: REASON.id })]);
    await openEditor(user);

    expect(await screen.findByDisplayValue("1.5")).toBeInTheDocument();
  });

  /*
   * The API refuses a partial update of the three fields, so turning a
   * fee off has to send all three as null rather than omitting them.
   */
  it("clears all three fields together when the tier stops charging", async () => {
    const user = userEvent.setup();
    stubLoads([rule({ feeType: "FLAT_FEE", feeAmount: "25.00", feeReasonId: REASON.id })]);
    await openEditor(user);

    await user.selectOptions(screen.getByLabelText("Charge"), "");
    await user.click(screen.getByText("Save"));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    expect(patch.mock.calls[0]![1]).toMatchObject({
      feeType: null,
      feeAmount: null,
      feeReasonId: null,
      maxFee: null,
    });
  });

  it("refuses to save a charge with no reason behind it", async () => {
    const user = userEvent.setup();
    stubLoads([rule()]);
    await openEditor(user);

    await user.selectOptions(screen.getByLabelText("Charge"), "FLAT_FEE");
    await user.type(await screen.findByPlaceholderText("e.g. 25.00"), "25");
    await user.click(screen.getByText("Save"));

    expect(await screen.findByText(/Choose the fee reason/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  /*
   * A cap on a flat amount is meaningless — the amount is its own cap —
   * and the database refuses the combination, so the field has to go
   * away rather than be sent and rejected.
   */
  it("drops the cap when the tier switches to a flat amount", async () => {
    const user = userEvent.setup();
    stubLoads([rule({ feeType: "PERCENT_OF_BALANCE", feeAmount: "0.015", maxFee: "50.00", feeReasonId: REASON.id })]);
    await openEditor(user);

    expect(await screen.findByDisplayValue("50")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Charge"), "FLAT_FEE");

    expect(screen.queryByDisplayValue("50")).not.toBeInTheDocument();
  });

  it("says which permission is missing rather than offering an empty list", async () => {
    const user = userEvent.setup();
    get.mockImplementation((path: string) => {
      if (path === "/api/v1/delinquency-rules") return Promise.resolve({ data: [rule()] });
      return Promise.reject(new Error("403"));
    });
    await openEditor(user);

    await user.selectOptions(screen.getByLabelText("Charge"), "FLAT_FEE");

    expect(await screen.findByText(/AR adjustments view permission/)).toBeInTheDocument();
    // Both work-order pickers say it, so there are two of them.
    expect(await screen.findAllByText(/service requests view permission/)).toHaveLength(2);
  });
});

describe("the rules table", () => {
  it("says what each tier charges", async () => {
    stubLoads([
      rule({ feeType: "FLAT_FEE", feeAmount: "25.00" }),
      rule({ id: "rule-2", tier: 2, name: "Second notice", feeType: "PERCENT_OF_BALANCE", feeAmount: "0.015", maxFee: "50.00", feeMode: "REPLACE_LOWER_TIERS" }),
      rule({ id: "rule-3", tier: 3, name: "Final notice" }),
    ]);
    render(
      <ToastProvider>
        <DelinquencyRulesPage />
      </ToastProvider>,
    );

    await screen.findByText("First notice");
    expect(screen.getByText("$25.00")).toBeInTheDocument();
    expect(screen.getByText("1.5% max $50.00 (replaces)")).toBeInTheDocument();
    // The tier that charges nothing says so rather than showing $0.00.
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
