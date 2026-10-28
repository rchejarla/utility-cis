import { describe, it, expect, vi, beforeEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  loadBillPresentation,
  BillPresentationError,
} from "../../services/bill-presentation.service.js";
import { prisma } from "../../lib/prisma.js";

vi.mock("../../services/bill-message.service.js", () => ({
  selectBillMessages: vi.fn().mockResolvedValue([]),
}));

// Issuer identity lives in settings.issuer, not in columns (Task 1).
const ISSUER = {
  utilityName: "City of Testville Utilities",
  utilityLegalName: "City of Testville, Montana",
  remittanceAddressLine1: "PO Box 1230",
  remittanceCity: "Testville",
  remittanceState: "MT",
  remittancePostalCode: "59771",
  billingPhone: "406-555-0100",
  billingEmail: "ub@testville.gov",
  websiteUrl: "https://testville.gov",
};

const CONFIG_ROW = {
  utilityId: "util-1",
  settings: { issuer: ISSUER, billDocuments: { storageIntegration: "cis-bills" } },
};

function lines(rows: Array<[string, string, string | null]>) {
  return rows.map(([label, amount, quantity], i) => ({
    label,
    kindCode: "fixed",
    quantity: quantity === null ? null : new Decimal(quantity),
    amount: new Decimal(amount),
    sortOrder: i + 1,
  }));
}

function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bill-1",
    utilityId: "util-1",
    accountId: "acct-1",
    billNumber: "B-1001",
    billDate: new Date("2026-03-01"),
    dueDate: new Date("2026-03-31"),
    periodStart: new Date("2026-02-01"),
    periodEnd: new Date("2026-02-28"),
    subtotal: new Decimal("100.0000"),
    taxes: new Decimal("7.5000"),
    credits: new Decimal("0.0000"),
    total: new Decimal("107.5000"),
    postedAt: new Date("2026-03-01"),
    account: {
      id: "acct-1",
      accountNumber: "A-900",
      accountType: "RESIDENTIAL",
      paperlessBilling: false,
      customer: { firstName: "Jane", lastName: "Smith", organizationName: null },
      billingAddresses: [
        {
          addressLine1: "12 Elm St",
          addressLine2: null,
          city: "Testville",
          state: "MT",
          zip: "59771",
          country: "US",
        },
      ],
    },
    segments: [
      {
        id: "seg-1",
        serviceAgreement: {
          commodity: { id: "c-1", code: "WATER", name: "Water" },
        },
        lines: lines([
          ["Base charge", "20.0000", null],
          ["Usage tier 1", "80.0000", "5.0000"],
        ]),
      },
    ],
    ...overrides,
  };
}

/**
 * One entry in the fees-and-adjustments window, shaped as the service
 * selects it. `assessedOn` is the bill charge a late fee punishes.
 */
function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fee-1",
    type: "FEE",
    amount: new Decimal("10.0000"),
    effectiveDate: new Date("2026-02-10"),
    tender: null,
    reason: { label: "Late payment fee" },
    assessedOn: { bill: { billNumber: "B-1001" } },
    reverses: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue(CONFIG_ROW as never);
  vi.mocked(prisma.utilityTheme.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.accountTypeDef.findFirst).mockResolvedValue({ id: "at-1" } as never);
  // `clearAllMocks` clears calls but keeps implementations, so a test
  // that seeds the fees window would otherwise leave its fees in place
  // for every test after it — including the one asserting `fees: null`.
  vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([] as never);
});

describe("loadBillPresentation", () => {
  it("resolves issuer, recipient, charge groups and money at two decimals", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.issuer.name).toBe("City of Testville Utilities");
    expect(p.issuer.addressLines).toEqual(["PO Box 1230", "Testville, MT 59771"]);
    expect(p.recipient.name).toBe("Jane Smith");
    expect(p.recipient.addressLines).toEqual(["12 Elm St", "Testville, MT 59771"]);
    expect(p.account.number).toBe("A-900");
    expect(p.groups[0].heading).toBe("Water");
    expect(p.groups[0].lines[0]).toEqual({ label: "Base charge", quantity: null, amount: "20.00" });
    expect(p.groups[0].lines[1].quantity).toBe("5.00");
    expect(p.totals).toEqual({
      subtotal: "100.00",
      taxes: "7.50",
      credits: "0.00",
      // Exact to cents, so summing the rounded lines and rounding the
      // stored total agree and there is nothing to disclose.
      rounding: null,
      // No fee reached this account between bills, so the group is
      // absent and the printed total is the rated one.
      fees: null,
      total: "107.50",
    });
    expect(p.remittance.amountDue).toBe("107.50");
    expect(p.remittance.payTo).toBe("City of Testville, Montana");
  });

  it("prefers an organization name over a person's name for the recipient", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        account: {
          ...billRow().account,
          customer: { firstName: "Jane", lastName: "Smith", organizationName: "Acme Co" },
        },
      }) as never,
    );

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.recipient.name).toBe("Acme Co");
  });

  // Review Focus 1 — the one a customer notices.
  it("keeps rounded line amounts summing to the group subtotal", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        subtotal: new Decimal("0.0300"),
        taxes: new Decimal("0.0000"),
        credits: new Decimal("0.0000"),
        total: new Decimal("0.0300"),
        segments: [
          {
            id: "seg-1",
            serviceAgreement: { commodity: { id: "c-1", code: "WATER", name: "Water" } },
            lines: lines([
              ["A", "0.0100", null],
              ["B", "0.0100", null],
              ["C", "0.0100", null],
            ]),
          },
        ],
      }) as never,
    );

    const p = await loadBillPresentation("util-1", "bill-1");
    const summed = p.groups[0].lines.reduce(
      (acc, l) => acc.plus(new Decimal(l.amount)),
      new Decimal(0),
    );

    expect(summed.toFixed(2)).toBe(p.groups[0].subtotal);
  });

  // Review Focus 2
  it("refuses a bill with no charge lines", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow({ segments: [] }) as never);

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({
      code: "NO_CHARGES",
    });
  });

  it("refuses a bill whose segments carry no lines", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        segments: [
          {
            id: "seg-1",
            serviceAgreement: { commodity: { id: "c-1", code: "WATER", name: "Water" } },
            lines: [],
          },
        ],
      }) as never,
    );

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({
      code: "NO_CHARGES",
    });
  });

  // Review Focus 3
  it("refuses a bill whose recipient has no name", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        account: {
          ...billRow().account,
          customer: { firstName: null, lastName: null, organizationName: null },
        },
      }) as never,
    );

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({
      code: "RECIPIENT_INCOMPLETE",
    });
  });

  it("refuses a bill whose recipient has no billing address", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({ account: { ...billRow().account, billingAddresses: [] } }) as never,
    );

    await expect(loadBillPresentation("util-1", "bill-1")).rejects.toMatchObject({
      code: "RECIPIENT_INCOMPLETE",
    });
  });

  it("refuses when issuer identity is incomplete, naming what is missing", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    const { utilityName: _n, remittanceAddressLine1: _a, ...rest } = ISSUER;
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({
      utilityId: "util-1",
      settings: { issuer: rest },
    } as never);

    const err = await loadBillPresentation("util-1", "bill-1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BillPresentationError);
    expect((err as BillPresentationError).code).toBe("ISSUER_INCOMPLETE");
    /*
     * And a status, so a route that does not map these codes itself
     * still answers 422 rather than 500. `bill-documents.ts` keeps its
     * own table because it also maps `BillDocumentError` and attaches
     * `missing`; every presentation code in that table is 422, so this
     * is the same answer rather than a second opinion.
     */
    expect((err as BillPresentationError).statusCode).toBe(422);
    expect((err as BillPresentationError).missing).toEqual(
      expect.arrayContaining(["utilityName", "remittanceAddressLine1"]),
    );
  });

  it("treats an empty-string issuer field as missing, since that is how settings clear one", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue({
      utilityId: "util-1",
      settings: { issuer: { ...ISSUER, remittanceCity: "" } },
    } as never);

    const err = await loadBillPresentation("util-1", "bill-1").catch((e: unknown) => e);

    expect((err as BillPresentationError).missing).toEqual(["remittanceCity"]);
  });

  it("falls back to default branding when the tenant has no theme", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.branding).toEqual({ logoUrl: null, primaryColor: "#1f2937", fontFamily: "Inter" });
  });

  it("takes branding from the tenant theme when it has one", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.utilityTheme.findUnique).mockResolvedValue({
      logoUrl: "https://cdn.example.com/logo.png",
      colors: { primary: "#0055aa" },
      typography: { fontFamily: "Source Sans" },
    } as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.branding).toEqual({
      logoUrl: "https://cdn.example.com/logo.png",
      primaryColor: "#0055aa",
      fontFamily: "Source Sans",
    });
  });

  it("selects messages at the bill date, not today, for the account's type and services", async () => {
    const { selectBillMessages } = await import("../../services/bill-message.service.js");
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    await loadBillPresentation("util-1", "bill-1");

    expect(vi.mocked(selectBillMessages)).toHaveBeenCalledWith("util-1", {
      accountTypeDefId: "at-1",
      commodityIds: ["c-1"],
      onDate: new Date("2026-03-01"),
    });
  });

  /**
   * A tenant's own type definition outranks the global default sharing
   * its code.
   *
   * Both can exist — the table is unique on (utility_id, code), and
   * overriding a shipped type means adding a row with the same code,
   * which is how every type-def list resolves it. This lookup had no
   * ordering, so whichever row Postgres returned first won, and a
   * message targeted at the tenant's row could silently stop printing.
   * Asserting the ordering rather than the result, because with one
   * mocked row the result cannot tell the two apart.
   */
  it("prefers the tenant's account type over the global default", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    await loadBillPresentation("util-1", "bill-1");

    const args = vi.mocked(prisma.accountTypeDef.findFirst).mock.calls[0][0] as {
      orderBy?: unknown;
      where?: unknown;
    };
    expect(args.orderBy).toEqual({ utilityId: { sort: "desc", nulls: "last" } });
    // Still reads both sets: the global default is what most tenants use.
    expect(args.where).toMatchObject({
      OR: [{ utilityId: "util-1" }, { utilityId: null }],
    });
  });

  /**
   * Two late fees on one statement.
   *
   * The ladder charges per overdue bill since 2026-10-25, so one sweep
   * can raise several fees on one account and a tier can raise one on
   * each of three unpaid bills. Labelled by reason and date alone, they
   * print as identical lines on a page whose whole claim is that the
   * customer can see what each charge is for.
   */
  it("names the bill a late fee was raised on", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([
      activityRow({ id: "fee-1", assessedOn: { bill: { billNumber: "B-1001" } } }),
      activityRow({
        id: "fee-2",
        amount: new Decimal("25.0000"),
        assessedOn: { bill: { billNumber: "B-0998" } },
      }),
    ] as never);

    const p = await loadBillPresentation("util-1", "bill-1");
    const fees = p.groups.find((g) => g.heading === "Fees and adjustments")!;

    expect(fees.lines.map((l) => l.label)).toEqual([
      "Late payment fee 2026-02-10 — for bill B-1001",
      "Late payment fee 2026-02-10 — for bill B-0998",
    ]);
    expect(fees.subtotal).toBe("35.00");
  });

  /**
   * `chargeableDebits` admits any non-deposit, non-penalty debit, so a
   * tier can charge an opening-balance ADJUSTMENT_DEBIT that no bill
   * produced — and a CSR can raise a fee citing nothing at all.
   */
  it("falls back to the date alone when no bill produced the debit a fee was raised on", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([
      activityRow({ id: "fee-1", assessedOn: { bill: null } }),
      activityRow({ id: "fee-2", assessedOn: null }),
    ] as never);

    const p = await loadBillPresentation("util-1", "bill-1");
    const fees = p.groups.find((g) => g.heading === "Fees and adjustments")!;

    expect(fees.lines.map((l) => l.label)).toEqual([
      "Late payment fee 2026-02-10",
      "Late payment fee 2026-02-10",
    ]);
  });

  /**
   * A REPLACE_LOWER_TIERS tier reverses the fee below it and charges its
   * own, so the next statement carries a credit the customer did not
   * ask for. "Reversal" alone does not say what was reversed, and the
   * two lines are a tier-one fee being superseded — which only reads
   * that way if the credit names the same bill as the charge.
   */
  it("says which fee a reversal reversed, and on which bill", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([
      activityRow({
        id: "rev-1",
        type: "REVERSAL",
        amount: new Decimal("-10.0000"),
        reason: null,
        assessedOn: null,
        reverses: {
          reason: { label: "Late payment fee" },
          assessedOn: { bill: { billNumber: "B-1001" } },
        },
      }),
      activityRow({ id: "fee-2", amount: new Decimal("25.0000") }),
    ] as never);

    const p = await loadBillPresentation("util-1", "bill-1");
    const fees = p.groups.find((g) => g.heading === "Fees and adjustments")!;

    expect(fees.lines.map((l) => l.label)).toEqual([
      "Late payment fee reversed 2026-02-10 — for bill B-1001",
      "Late payment fee 2026-02-10 — for bill B-1001",
    ]);
    expect(fees.subtotal).toBe("15.00");
  });

  /**
   * The fees group, reachable without guessing where it is.
   *
   * It is appended to `groups` after the rated ones so a template can
   * print it like any other charge group, and that leaves a consumer
   * wanting only the fees — the staff bill popup — matching on the
   * heading string or assuming it is last. Both are contracts nobody
   * wrote down. `feesGroup` is the same object, named.
   */
  it("offers the fees group by name as well as at the end of the groups", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([activityRow()] as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.feesGroup).not.toBeNull();
    expect(p.feesGroup!.heading).toBe("Fees and adjustments");
    // The same object, not a copy that can drift from it.
    expect(p.feesGroup).toBe(p.groups[p.groups.length - 1]);
    expect(p.totals.fees).toBe(p.feesGroup!.subtotal);
  });

  it("has no fees group on a bill that carries none", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.feesGroup).toBeNull();
    expect(p.totals.fees).toBeNull();
  });

  /**
   * Asserting the query rather than only the labels: the rows above are
   * mocked, so they prove the label is built from `assessedOn` but not
   * that the service ever asks the database for it.
   */
  it("reads the assessed-on bill and the reversed entry in the fees query", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    await loadBillPresentation("util-1", "bill-1");

    const args = vi.mocked(prisma.ledgerEntry.findMany).mock.calls[0][0] as {
      include?: Record<string, unknown>;
      where?: { type?: { notIn?: string[] } };
    };
    /*
     * `PAYMENT` is excluded as well as the two it always excluded.
     * Payments in this window are reported by the statement block's
     * `paymentsSince`, which the layout subtracts; itemising them here
     * too would subtract them twice. The two partition the window's
     * credits rather than overlapping — everything else with a reason a
     * customer can read stays here.
     */
    expect(args.where?.type?.notIn).toEqual(
      expect.arrayContaining(["BILL_CHARGE", "DEPOSIT", "PAYMENT"]),
    );
    expect(args.include).toMatchObject({
      reason: { select: { label: true } },
      assessedOn: { select: { bill: { select: { billNumber: true } } } },
      reverses: {
        select: {
          reason: { select: { label: true } },
          assessedOn: { select: { bill: { select: { billNumber: true } } } },
        },
      },
    });
  });

  /**
   * The bill asks for what the account owes.
   *
   * Its total was rated charges plus whichever non-bill entries fell in
   * a date window — a quantity answering no question, and short by the
   * balance carried forward, because entries holding a `bill_id` are
   * filtered out of that window and nothing put the previous bill's
   * unpaid remainder back. The standard rule is current charges **plus
   * past due**.
   */
  it("adds the balance carried forward into the total", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        previousBalance: new Decimal("110.75"),
        paymentsSince: new Decimal("30.00"),
        pastDueAmount: new Decimal("80.75"),
      }) as never,
    );
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([
      activityRow({ amount: new Decimal("25.0000") }),
    ] as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.statement).toEqual({
      previousBalance: "110.75",
      paymentsSince: "30.00",
      balanceForward: "80.75",
      pastDue: "80.75",
    });
    // 110.75 carried − 30.00 paid + 25.00 fees + 107.50 rated = 213.25.
    expect(p.totals.total).toBe("213.25");
    expect(p.remittance.amountDue).toBe("213.25");
  });

  /**
   * A bill issued before the snapshot existed carries none of it, and
   * prints exactly as it did — the figures are not recoverable, so
   * inventing them is the one thing this must not do.
   */
  it("omits the statement and keeps the old total on a bill with no snapshot", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.statement).toBeNull();
    expect(p.totals.total).toBe("107.50");
  });

  /**
   * The totals box, resolved once.
   *
   * It was built twice — in the PDF template and in the staff popup —
   * and every change touched one of them. Fees went into the total and
   * the popup did not show them; the balance carried forward went in and
   * the popup showed a total $523.55 larger than its own lines. They had
   * also drifted in ways nobody reported: the PDF prints Taxes
   * unconditionally and a Rounding row, the popup hid Taxes at zero and
   * had no Rounding row at all.
   *
   * One ordered list, computed here, rendered by both. A figure added to
   * the total now appears in both surfaces by construction rather than
   * by remembering.
   */
  it("resolves the totals box as one ordered list", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(
      billRow({
        previousBalance: new Decimal("110.75"),
        paymentsSince: new Decimal("30.00"),
        pastDueAmount: new Decimal("80.75"),
      }) as never,
    );
    vi.mocked(prisma.ledgerEntry.findMany).mockResolvedValue([
      activityRow({ amount: new Decimal("25.0000") }),
    ] as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    expect(p.totalRows).toEqual([
      { label: "Previous balance", amount: "110.75" },
      { label: "Payments received", amount: "-30.00" },
      { label: "Balance forward", amount: "80.75" },
      { label: "Charges this period", amount: "100.00" },
      { label: "Taxes", amount: "7.50" },
      { label: "Fees and adjustments", amount: "25.00" },
      { label: "Total due", amount: "213.25", emphasis: "total" },
      { label: "of which past due — payable now", amount: "80.75", emphasis: "note" },
    ]);
  });

  it("drops the statement rows and renames the first on a bill with no snapshot", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);

    const p = await loadBillPresentation("util-1", "bill-1");

    // "Subtotal" rather than "Charges this period": there is no balance
    // above it to tell it apart from.
    expect(p.totalRows).toEqual([
      { label: "Subtotal", amount: "100.00" },
      { label: "Taxes", amount: "7.50" },
      { label: "Total due", amount: "107.50", emphasis: "total" },
    ]);
  });

  it("still renders when the account type matches no type definition", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.accountTypeDef.findFirst).mockResolvedValue(null as never);

    const { selectBillMessages } = await import("../../services/bill-message.service.js");
    await loadBillPresentation("util-1", "bill-1");

    expect(vi.mocked(selectBillMessages).mock.calls[0][1].accountTypeDefId).toBeNull();
  });
});
