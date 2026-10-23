import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import { BillDetailDialog } from "../bill-detail-dialog";

/**
 * What a bill's charge lines say they are.
 *
 * A quantity without its unit is not a smaller version of the truth,
 * it is a different claim. The rate engine bills in the unit the tariff
 * is written in, which is not always the meter's: Bozeman publishes
 * water per HCF and the meters are gallons, so a 4,958-gallon month
 * reaches this dialog as 4.71. A customer or a CSR reading a bare
 * "4.71" against a meter that counts gallons has nothing to reconcile.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function line(over: Record<string, unknown> = {}) {
  return {
    id: "l-1",
    label: "Water Usage — Single Family",
    kindCode: "consumption",
    amount: "15.5754",
    quantity: "4.7056",
    unit: "HCF",
    sortOrder: 100,
    ...over,
  };
}

function bill(lines: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) {
  return {
    holdReason: null,
    heldByAccount: false,
    id: "b-1",
    billNumber: "BILL-202610-0001000-00",
    periodStart: "2026-08-16",
    periodEnd: "2026-09-15",
    billDate: "2026-09-15",
    dueDate: "2026-10-15",
    postedAt: null,
    subtotal: "37.8854",
    taxes: "0.0000",
    credits: "0.0000",
    total: "37.8854",
    ...over,
    segments: [
      {
        id: "s-1",
        segmentNumber: "SEG-202610-1",
        serviceAgreementId: "sa-1",
        periodStart: "2026-08-16",
        periodEnd: "2026-09-15",
        subtotal: "37.8854",
        total: "37.8854",
        lines,
      },
    ],
  };
}

/** The dialog raises toasts on hold, release and send, so it needs the provider. */
function renderDialog() {
  return render(
    <ToastProvider>
      <BillDetailDialog billId="b-1" onClose={() => {}} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Bill detail — charge lines", () => {
  it("prints the unit the quantity is counted in", async () => {
    get.mockResolvedValue(bill([line()]));
    renderDialog();

    expect(await screen.findByText("4.71 HCF")).toBeInTheDocument();
  });

  it("names a fixed charge's unit too, rather than a bare 1", async () => {
    get.mockResolvedValue(
      bill([
        line({
          id: "l-2",
          label: "Water Service Charge",
          kindCode: "service_charge",
          quantity: "1.0000",
          unit: "MONTH",
          amount: "22.3100",
        }),
      ]),
    );
    renderDialog();

    expect(await screen.findByText("1.00 MONTH")).toBeInTheDocument();
  });

  /*
   * Bills written before the column existed recorded no unit, and a
   * tariff that names none has none to show. Neither may turn into the
   * word "null" on a document a customer holds.
   */
  it("shows the bare quantity when the tariff names no unit", async () => {
    get.mockResolvedValue(bill([line({ unit: null })]));
    renderDialog();

    expect(await screen.findByText("4.71")).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it("shows a dash where there is no quantity at all", async () => {
    get.mockResolvedValue(bill([line({ quantity: null, unit: null })]));
    renderDialog();

    expect(await screen.findByText("—")).toBeInTheDocument();
  });
});

/**
 * Hold and send, where an operator actually meets them.
 *
 * Both were API-only: a bill could be held, released and queued for
 * delivery, and none of it was reachable from the app. The dialog is
 * the one screen that already shows a bill, so it is where both belong.
 *
 * A hold has two possible sources and they are released differently —
 * the bill's own reason, or the account's standing rule — so the banner
 * says which. Releasing the wrong one does nothing, and an operator
 * should not have to guess.
 */
describe("Bill detail — holds", () => {
  it("says a bill is held, and why", async () => {
    get.mockImplementation((path: string) =>
      path.includes("/deliveries")
        ? Promise.resolve([])
        : Promise.resolve(bill([line()], { holdReason: "Read looks wrong — re-reading" })),
    );
    renderDialog();

    expect(await screen.findByText(/on hold/i)).toBeInTheDocument();
    expect(screen.getByText(/Read looks wrong/)).toBeInTheDocument();
  });

  it("names the account's rule when that is what holds it", async () => {
    get.mockImplementation((path: string) =>
      path.includes("/deliveries")
        ? Promise.resolve([])
        : Promise.resolve(
            bill([line()], {
              holdReason: "Move-out pending final read",
              heldByAccount: true,
            }),
          ),
    );
    renderDialog();

    // Releasing this bill would do nothing — the rule is on the account,
    // so the banner has to say which of the two holds it.
    expect(
      await screen.findByText(/the account's billing is held/i),
    ).toBeInTheDocument();
    // And Release is not offered here, because it would clear a reason
    // this bill does not have.
    expect(screen.queryByRole("button", { name: /release/i })).toBeNull();
  });

  it("offers Hold on a bill that is not held", async () => {
    get.mockImplementation((path: string) =>
      path.includes("/deliveries") ? Promise.resolve([]) : Promise.resolve(bill([line()])),
    );
    renderDialog();

    expect(await screen.findByRole("button", { name: /hold/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release/i })).toBeNull();
  });
});

describe("Bill detail — sending", () => {
  it("will not offer Send for a bill nobody owes yet", async () => {
    get.mockImplementation((path: string) =>
      path.includes("/deliveries")
        ? Promise.resolve([])
        : Promise.resolve(bill([line()], { postedAt: null })),
    );
    renderDialog();

    // An unposted bill is a calculation. Posting is the gate before it.
    await screen.findByText("BILL-202610-0001000-00");
    expect(screen.queryByRole("button", { name: /^send/i })).toBeNull();
  });

  it("shows the last attempt and how it went", async () => {
    get.mockImplementation((path: string) =>
      path.includes("/deliveries")
        ? Promise.resolve([
            {
              id: "n-1",
              channel: "EMAIL",
              status: "FAILED",
              recipientEmail: "jane.smith@example.com",
              attempts: 1,
              sentAt: null,
              error: "mailbox unavailable",
              createdAt: "2026-10-23T09:00:00.000Z",
            },
          ])
        : Promise.resolve(bill([line()], { postedAt: "2026-10-01T00:00:00.000Z" })),
    );
    renderDialog();

    // A bounce is the thing worth seeing: the bill looks sent and is not.
    expect(await screen.findByText(/mailbox unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/jane.smith@example.com/)).toBeInTheDocument();
  });
});
