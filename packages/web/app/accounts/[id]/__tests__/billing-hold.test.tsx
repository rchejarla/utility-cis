import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import * as permModule from "@/lib/use-permission";
import AccountDetailPage from "../page";

/**
 * The account's standing billing hold.
 *
 * A hold on the account is the half that reaches bills which do not
 * exist yet — a move-out pending a final read, a bankruptcy, a legal
 * hold. It is also invisible by nature: it changes what happens to
 * every future bill and leaves no mark on any of them, because nothing
 * is stamped. An invisible rule is a trap, so the account has to say it
 * out loud, and the only place to lift it is here.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function account(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    accountNumber: "0001000-00",
    accountType: "RESIDENTIAL",
    status: "ACTIVE",
    billingHoldReason: null,
    customer: {
      id: "cust-1",
      customerType: "INDIVIDUAL",
      firstName: "Jane",
      lastName: "Smith",
    },
    serviceAgreements: [],
    contacts: [],
    billingAddresses: [],
    ...over,
  };
}

/**
 * Render inside an awaited `act`.
 *
 * The route's params are a promise, so the component suspends on its
 * first render; rendering outside an awaited `act` leaves that suspense
 * unflushed and the first case in a file asserts against an empty
 * document while later ones pass. The run-detail suite documents the
 * same trap.
 */
async function renderPage() {
  await act(async () => {
    render(
      <ToastProvider>
        <AccountDetailPage params={Promise.resolve({ id: "acc-1" })} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(permModule, "usePermission").mockReturnValue({
    canView: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
  });
  get.mockImplementation((path: string) =>
    path === "/api/v1/accounts/acc-1"
      ? Promise.resolve(account())
      : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 25, pages: 1 } }),
  );
});

describe("Account — billing hold", () => {
  it("offers a hold on an account that is not held", async () => {
    await renderPage();

    expect(
      await screen.findByRole("button", { name: /hold billing/i }),
    ).toBeInTheDocument();
  });

  it("says when billing is held, and why", async () => {
    get.mockImplementation((path: string) =>
      path === "/api/v1/accounts/acc-1"
        ? Promise.resolve(
            account({ billingHoldReason: "Move-out pending final read" }),
          )
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 25, pages: 1 } }),
    );

    await renderPage();

    expect(await screen.findByText(/billing is held/i)).toBeInTheDocument();
    expect(screen.getByText(/Move-out pending final read/)).toBeInTheDocument();
    // And the way out is here, not on each bill.
    expect(
      screen.getByRole("button", { name: /release billing/i }),
    ).toBeInTheDocument();
  });

  it("says what the hold does, since it leaves no mark on the bills", async () => {
    get.mockImplementation((path: string) =>
      path === "/api/v1/accounts/acc-1"
        ? Promise.resolve(account({ billingHoldReason: "Bankruptcy" }))
        : Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 25, pages: 1 } }),
    );

    await renderPage();

    // Billing still happens — not billing would push the period into the
    // next one — so the banner has to distinguish "still calculated"
    // from "cannot post or be sent".
    expect(await screen.findByText(/still billed/i)).toBeInTheDocument();
  });

  /*
   * In the app, not in `window.prompt`: the native box blocks the page,
   * cannot be styled, is suppressed by some browsers, and reads as
   * though the site is broken. The reason is the part of a hold that has
   * to be good — it is what the next person acts on.
   */
  it("asks for the reason in a dialog rather than a browser prompt", async () => {
    const prompt = vi.fn();
    vi.stubGlobal("prompt", prompt);
    const post = apiClient.post as unknown as ReturnType<typeof vi.fn>;
    post.mockResolvedValue({});
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /hold billing/i }));

    const reason = await screen.findByLabelText(/reason/i);
    expect(prompt).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /hold this account/i })).toBeDisabled();

    await userEvent.type(reason, "Bankruptcy — legal hold");
    await userEvent.click(screen.getByRole("button", { name: /hold this account/i }));

    expect(post).toHaveBeenCalledWith("/api/v1/accounts/acc-1/billing-hold", {
      reason: "Bankruptcy — legal hold",
    });
  });
});
