import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdjustDialog } from "../adjust-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import type { AdjustTarget } from "../adjust-dialog";

/**
 * The thing these cases defend is §3.5: a concession and a bad debt are
 * different facts. The UI enforces that by never offering a reason the
 * API would refuse — so the test that matters most is which reasons each
 * mode asks for and shows.
 */

const mockedGet = vi.mocked(apiClient.get);
const mockedPost = vi.mocked(apiClient.post);

const REASONS = {
  FEE: [
    { id: "r-late", code: "LATE_FEE", label: "Late payment fee", appliesToType: "FEE" },
    { id: "r-tap", code: "TAP_FEE", label: "Tap fee", appliesToType: "FEE" },
  ],
  ADJUSTMENT_CREDIT: [
    {
      id: "r-courtesy",
      code: "COURTESY_WAIVER",
      label: "Courtesy waiver",
      appliesToType: "ADJUSTMENT_CREDIT",
    },
  ],
  WRITE_OFF: [
    { id: "r-bad", code: "BAD_DEBT", label: "Written off — uncollectable", appliesToType: "WRITE_OFF" },
  ],
};

function routeReasons(byType: Partial<Record<string, unknown[]>> = REASONS) {
  mockedGet.mockImplementation((path: string) => {
    const m = /appliesToType=([A-Z_]+)/.exec(path);
    const type = m?.[1] ?? "";
    return Promise.resolve({ data: byType[type] ?? [] } as never);
  });
}

const charge: AdjustTarget = {
  id: "e1",
  amount: "40.00",
  openAmount: "10.00",
  label: "BILL_CHARGE (BILL-202605-1)",
};

function renderDialog(props: Partial<Parameters<typeof AdjustDialog>[0]> = {}) {
  return render(
    <ToastProvider>
      <AdjustDialog
        mode="fee"
        accountId="a1"
        target={null}
        onClose={vi.fn()}
        onDone={vi.fn()}
        {...props}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdjustDialog reason filtering", () => {
  it("asks only for FEE reasons in fee mode", async () => {
    routeReasons();
    renderDialog({ mode: "fee" });
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/ar/reasons?appliesToType=FEE");
  });

  // §3.5: offering a write-off reason on a waiver is a choice the API
  // answers with 422, so it must never be presented.
  it("offers waiver reasons and NOT write-off reasons when waiving", async () => {
    routeReasons();
    renderDialog({ mode: "waive", target: charge });
    const select = await screen.findByRole("combobox");
    expect(within(select).getByRole("option", { name: "Courtesy waiver" })).toBeInTheDocument();
    expect(
      within(select).queryByRole("option", { name: /uncollectable/i }),
    ).not.toBeInTheDocument();
  });

  it("offers write-off reasons and NOT waiver reasons when writing off", async () => {
    routeReasons();
    renderDialog({ mode: "writeOff", target: charge });
    const select = await screen.findByRole("combobox");
    expect(within(select).getByRole("option", { name: /uncollectable/i })).toBeInTheDocument();
    expect(
      within(select).queryByRole("option", { name: "Courtesy waiver" }),
    ).not.toBeInTheDocument();
  });

  // A tenant that never seeded reason codes cannot use any of this, and
  // an empty dropdown with a dead button explains nothing.
  it("explains itself when the tenant has no reason codes", async () => {
    routeReasons({});
    renderDialog({ mode: "fee" });
    expect(await screen.findByText(/no fee reason codes yet/i)).toBeInTheDocument();
    // An operator gets a button, not an instruction to POST to an endpoint.
    expect(
      screen.getByRole("button", { name: /add the default reason codes/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /raise fee/i })).toBeDisabled();
  });

  it("preselects the only reason when there is exactly one", async () => {
    routeReasons();
    renderDialog({ mode: "waive", target: charge });
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("r-courtesy"));
  });
});

describe("AdjustDialog behaviour", () => {
  it("defaults the amount to what the target charge still owes", async () => {
    routeReasons();
    renderDialog({ mode: "waive", target: charge });
    // 10.00 still owed of 40.00 charged — not the charged figure.
    expect(await screen.findByDisplayValue("10.00")).toBeInTheDocument();
    expect(screen.getByText(/10\.00 still owed of \$40\.00/i)).toBeInTheDocument();
  });

  it("will not submit without a reason", async () => {
    routeReasons({ FEE: REASONS.FEE });
    renderDialog({ mode: "fee" });
    await screen.findByRole("combobox");
    await userEvent.type(screen.getByPlaceholderText("0.00"), "25.00");
    // Two FEE reasons, so nothing is preselected.
    expect(screen.getByRole("button", { name: /raise fee/i })).toBeDisabled();
  });

  it("posts a waiver with the target charge and reports a refund due", async () => {
    routeReasons();
    const onDone = vi.fn();
    mockedPost.mockResolvedValue({ balance: "30.00", unapplied: "20.00" } as never);
    renderDialog({ mode: "waive", target: charge, onDone });

    const amount = await screen.findByPlaceholderText("0.00");
    await userEvent.clear(amount);
    await userEvent.type(amount, "30.00");
    await userEvent.click(screen.getByRole("button", { name: /^waive$/i }));

    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith("/api/v1/accounts/a1/waivers", {
        amount: "30.00",
        reasonId: "r-courtesy",
        debitId: "e1",
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("keeps the dialog open and shows why when the API refuses", async () => {
    routeReasons();
    mockedPost.mockRejectedValue(new Error("API error 422: REASON_TYPE_MISMATCH"));
    renderDialog({ mode: "writeOff", target: charge });

    await screen.findByRole("combobox");
    await userEvent.click(screen.getByRole("button", { name: /^write off$/i }));

    expect(await screen.findByText(/REASON_TYPE_MISMATCH/)).toBeInTheDocument();
    // Still open: the operator can correct it rather than retype everything.
    expect(screen.getByRole("button", { name: /^write off$/i })).toBeInTheDocument();
  });

  it("offers a due date only for a fee", async () => {
    routeReasons();
    const { unmount } = renderDialog({ mode: "fee" });
    expect(await screen.findByText(/defaults to 30 days/i)).toBeInTheDocument();
    unmount();

    routeReasons();
    renderDialog({ mode: "waive", target: charge });
    await screen.findByRole("combobox");
    // A credit has nothing to fall due.
    expect(screen.queryByText(/defaults to 30 days/i)).not.toBeInTheDocument();
  });

  it("says plainly that a write-off is bad debt, not a concession", async () => {
    routeReasons();
    renderDialog({ mode: "writeOff", target: charge });
    expect(await screen.findByText(/never be collected/i)).toBeInTheDocument();
    expect(screen.getByText(/waive it instead/i)).toBeInTheDocument();
  });
});

/**
 * A failed reason lookup and a tenant with no reason codes are different
 * facts, and the old code reported both as the second one. That sent
 * anyone diagnosing an empty dropdown looking for missing data when the
 * request had actually failed.
 */
describe("AdjustDialog — why the reason list is empty", () => {
  it("says the lookup failed, and does NOT claim the utility has no codes", async () => {
    mockedGet.mockRejectedValue(new Error("403 MODULE_DISABLED"));
    renderDialog({ mode: "waive", target: charge });

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/403 MODULE_DISABLED/)).toBeInTheDocument();
    expect(screen.queryByText(/has no adjustment credit reason codes/i)).toBeNull();
    // Seeding defaults would not fix a failed request, so it is not offered.
    expect(screen.queryByRole("button", { name: /add the default reason codes/i })).toBeNull();
  });

  it("retries the lookup on demand", async () => {
    mockedGet.mockRejectedValueOnce(new Error("boom"));
    renderDialog({ mode: "waive", target: charge });
    await screen.findByText(/could not be loaded/i);

    routeReasons();
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    const select = await screen.findByRole("combobox");
    expect(within(select).getByRole("option", { name: "Courtesy waiver" })).toBeInTheDocument();
  });

  it("offers to seed the defaults when the utility genuinely has none", async () => {
    routeReasons({});
    renderDialog({ mode: "waive", target: charge });

    expect(await screen.findByText(/has no adjustment credit reason codes/i)).toBeInTheDocument();
    const seed = screen.getByRole("button", { name: /add the default reason codes/i });

    mockedPost.mockResolvedValue({ created: 12 } as never);
    routeReasons();
    await userEvent.click(seed);

    await waitFor(() =>
      expect(mockedPost).toHaveBeenCalledWith("/api/v1/ar/reasons/seed-defaults", {}),
    );
    // Reloaded, so the operator can carry on without reopening.
    const select = await screen.findByRole("combobox");
    expect(within(select).getByRole("option", { name: "Courtesy waiver" })).toBeInTheDocument();
  });
});

describe("AdjustDialog — a pending lookup is not an empty one", () => {
  it("says it is loading rather than showing a bare placeholder", async () => {
    // A request that never settles. Before this, the dropdown held only
    // "Choose a reason…", which reads as "this utility has no reasons" —
    // the exact confusion that sent someone hunting for missing data.
    mockedGet.mockReturnValue(new Promise(() => {}) as never);
    renderDialog({ mode: "waive", target: charge });

    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: /loading reason codes/i })).toBeInTheDocument();
    expect(select).toBeDisabled();
    // And it must not assert the tenant has none, which is not yet known.
    expect(screen.queryByText(/has no adjustment credit reason codes/i)).toBeNull();
  });

  it("enables the select once the reasons arrive", async () => {
    routeReasons();
    renderDialog({ mode: "waive", target: charge });
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(within(select).getByRole("option", { name: "Courtesy waiver" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /loading/i })).toBeNull();
  });
});
