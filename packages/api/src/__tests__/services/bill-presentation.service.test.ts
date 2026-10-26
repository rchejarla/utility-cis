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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.utilityConfig.findUnique).mockResolvedValue(CONFIG_ROW as never);
  vi.mocked(prisma.utilityTheme.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.accountTypeDef.findFirst).mockResolvedValue({ id: "at-1" } as never);
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

  it("still renders when the account type matches no type definition", async () => {
    vi.mocked(prisma.bill.findFirst).mockResolvedValue(billRow() as never);
    vi.mocked(prisma.accountTypeDef.findFirst).mockResolvedValue(null as never);

    const { selectBillMessages } = await import("../../services/bill-message.service.js");
    await loadBillPresentation("util-1", "bill-1");

    expect(vi.mocked(selectBillMessages).mock.calls[0][1].accountTypeDefId).toBeNull();
  });
});
