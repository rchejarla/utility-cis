import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

function bill(lines: Array<Record<string, unknown>>) {
  return {
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Bill detail — charge lines", () => {
  it("prints the unit the quantity is counted in", async () => {
    get.mockResolvedValue(bill([line()]));
    render(<BillDetailDialog billId="b-1" onClose={() => {}} />);

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
    render(<BillDetailDialog billId="b-1" onClose={() => {}} />);

    expect(await screen.findByText("1.00 MONTH")).toBeInTheDocument();
  });

  /*
   * Bills written before the column existed recorded no unit, and a
   * tariff that names none has none to show. Neither may turn into the
   * word "null" on a document a customer holds.
   */
  it("shows the bare quantity when the tariff names no unit", async () => {
    get.mockResolvedValue(bill([line({ unit: null })]));
    render(<BillDetailDialog billId="b-1" onClose={() => {}} />);

    expect(await screen.findByText("4.71")).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it("shows a dash where there is no quantity at all", async () => {
    get.mockResolvedValue(bill([line({ quantity: null, unit: null })]));
    render(<BillDetailDialog billId="b-1" onClose={() => {}} />);

    expect(await screen.findByText("—")).toBeInTheDocument();
  });
});
