import { Decimal } from "decimal.js";
import { REQUIRED_ISSUER_FIELDS, type IssuerSettings } from "@utility-cis/shared";
import { prisma } from "../lib/prisma.js";
import { selectBillMessages } from "./bill-message.service.js";

/**
 * Resolves one `Bill` into render-ready content.
 *
 * The output holds no Prisma types and no Decimals: it is the single
 * resolved form that the PDF renderer, the print-vendor export and the
 * e-bill HTML all read (docs/specs/09-billing.md names those three
 * document types). Resolving once is also what makes a bill
 * reproducible — the same presentation renders the same document.
 */

export interface BillPresentationIssuer {
  name: string;
  legalName: string | null;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  website: string | null;
}

export interface BillPresentationLine {
  label: string;
  quantity: string | null;
  amount: string;
}

export interface BillPresentationGroup {
  heading: string;
  lines: BillPresentationLine[];
  subtotal: string;
}

export interface BillPresentation {
  issuer: BillPresentationIssuer;
  recipient: { name: string; addressLines: string[] };
  account: { number: string; id: string };
  bill: {
    number: string;
    billDate: Date;
    dueDate: Date;
    periodStart: Date;
    periodEnd: Date;
  };
  groups: BillPresentationGroup[];
  totals: { subtotal: string; taxes: string; credits: string; total: string };
  messages: Array<{ label: string; body: string }>;
  branding: { logoUrl: string | null; primaryColor: string; fontFamily: string };
  remittance: { payTo: string; addressLines: string[]; amountDue: string; dueDate: Date };
}

export type BillPresentationErrorCode =
  | "ISSUER_INCOMPLETE"
  | "NO_CHARGES"
  | "RECIPIENT_INCOMPLETE";

export class BillPresentationError extends Error {
  constructor(
    message: string,
    readonly code: BillPresentationErrorCode,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "BillPresentationError";
  }
}

const DEFAULT_BRANDING = {
  logoUrl: null as string | null,
  primaryColor: "#1f2937",
  fontFamily: "Inter",
};

/** 4dp column to 2dp display. One function so every amount rounds alike. */
function money(value: Decimal | string | number): string {
  return new Decimal(value as Decimal.Value).toFixed(2);
}

/** "Testville, MT 59771" from its parts, skipping whatever is absent. */
function cityLine(city?: string | null, state?: string | null, postal?: string | null): string {
  const left = [city, state].filter(Boolean).join(", ");
  return [left, postal].filter(Boolean).join(" ").trim();
}

function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

/**
 * `settings` is untyped Json, so read the namespace defensively rather
 * than casting the whole row — a tenant that has never opened the
 * settings page has no `issuer` key at all.
 */
function issuerOf(settings: unknown): IssuerSettings {
  if (settings && typeof settings === "object" && "issuer" in settings) {
    const issuer = (settings as { issuer?: unknown }).issuer;
    if (issuer && typeof issuer === "object") return issuer as IssuerSettings;
  }
  return {};
}

export async function loadBillPresentation(
  utilityId: string,
  billId: string,
): Promise<BillPresentation> {
  const bill = await prisma.bill.findFirst({
    where: { id: billId, utilityId },
    include: {
      account: {
        include: {
          customer: true,
          billingAddresses: true,
        },
      },
      segments: {
        include: {
          serviceAgreement: { include: { commodity: true } },
          lines: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  if (!bill) {
    throw new BillPresentationError(`Bill ${billId} not found`, "NO_CHARGES");
  }

  // ─── Issuer ────────────────────────────────────────────────────────
  const config = await prisma.tenantConfig.findUnique({ where: { utilityId } });
  const issuer = issuerOf(config?.settings);
  const missing = REQUIRED_ISSUER_FIELDS.filter(
    (field) => !present(issuer[field as keyof IssuerSettings]),
  );
  if (missing.length > 0) {
    throw new BillPresentationError(
      `Issuer identity is incomplete: ${missing.join(", ")}. Set it under Settings before producing bills.`,
      "ISSUER_INCOMPLETE",
      [...missing],
    );
  }

  // ─── Recipient ─────────────────────────────────────────────────────
  const customer = bill.account.customer;
  const recipientName =
    customer?.organizationName?.trim() ||
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim();
  const address = bill.account.billingAddresses[0];
  if (!recipientName || !address) {
    throw new BillPresentationError(
      "Bill has no recipient name or no billing address",
      "RECIPIENT_INCOMPLETE",
      [!recipientName ? "recipientName" : "", !address ? "billingAddress" : ""].filter(Boolean),
    );
  }

  // ─── Charges ───────────────────────────────────────────────────────
  // Group subtotals sum the ALREADY-ROUNDED lines rather than rounding
  // a stored 4dp subtotal. What the customer can add up has to be what
  // is printed; rounding each line and then rounding a separate total
  // can disagree by cents, and they are the ones holding the paper.
  const groups: BillPresentationGroup[] = [];
  for (const segment of bill.segments) {
    if (segment.lines.length === 0) continue;
    const commodity = segment.serviceAgreement?.commodity;
    const lines = segment.lines.map((line) => ({
      label: line.label,
      quantity: line.quantity === null ? null : money(line.quantity),
      amount: money(line.amount),
    }));
    const subtotal = lines
      .reduce((acc, line) => acc.plus(new Decimal(line.amount)), new Decimal(0))
      .toFixed(2);
    groups.push({ heading: commodity?.name ?? commodity?.code ?? "Charges", lines, subtotal });
  }

  if (groups.length === 0) {
    throw new BillPresentationError(
      "Bill has no charge lines to render",
      "NO_CHARGES",
    );
  }

  // ─── Messages ──────────────────────────────────────────────────────
  // Account.accountType holds an AccountTypeDef *code*, not its id, so
  // resolve it. A code matching no definition targets nothing rather
  // than failing the render: an unmatched type is a configuration gap,
  // not a reason to withhold a bill.
  const typeDef = await prisma.accountTypeDef.findFirst({
    where: {
      code: bill.account.accountType,
      OR: [{ utilityId }, { utilityId: null }],
    },
    select: { id: true },
  });
  const commodityIds = [
    ...new Set(
      bill.segments
        .map((segment) => segment.serviceAgreement?.commodity?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const messages = await selectBillMessages(utilityId, {
    accountTypeDefId: typeDef?.id ?? null,
    commodityIds,
    onDate: bill.billDate,
  });

  // ─── Branding ──────────────────────────────────────────────────────
  const theme = await prisma.tenantTheme.findUnique({ where: { utilityId } });
  const colors = (theme?.colors ?? {}) as Record<string, unknown>;
  const typography = (theme?.typography ?? {}) as Record<string, unknown>;
  const branding = {
    logoUrl: theme?.logoUrl ?? DEFAULT_BRANDING.logoUrl,
    primaryColor:
      typeof colors.primary === "string" ? colors.primary : DEFAULT_BRANDING.primaryColor,
    fontFamily:
      typeof typography.fontFamily === "string"
        ? typography.fontFamily
        : DEFAULT_BRANDING.fontFamily,
  };

  const issuerAddressLines = [
    issuer.remittanceAddressLine1,
    issuer.remittanceAddressLine2,
    cityLine(issuer.remittanceCity, issuer.remittanceState, issuer.remittancePostalCode),
  ]
    .filter((line): line is string => present(line))
    .map((line) => line.trim());

  const totals = {
    subtotal: money(bill.subtotal),
    taxes: money(bill.taxes),
    credits: money(bill.credits),
    total: money(bill.total),
  };

  return {
    issuer: {
      name: issuer.utilityName as string,
      legalName: issuer.utilityLegalName || null,
      addressLines: issuerAddressLines,
      phone: issuer.billingPhone || null,
      email: issuer.billingEmail || null,
      website: issuer.websiteUrl || null,
    },
    recipient: {
      name: recipientName,
      addressLines: [
        address.addressLine1,
        address.addressLine2,
        cityLine(address.city, address.state, address.zip),
      ]
        .filter((line): line is string => present(line))
        .map((line) => line.trim()),
    },
    account: { number: bill.account.accountNumber, id: bill.account.id },
    bill: {
      number: bill.billNumber,
      billDate: bill.billDate,
      dueDate: bill.dueDate,
      periodStart: bill.periodStart,
      periodEnd: bill.periodEnd,
    },
    groups,
    totals,
    messages: messages.map((m) => ({ label: m.label, body: m.body })),
    branding,
    remittance: {
      payTo: (issuer.utilityLegalName || issuer.utilityName) as string,
      addressLines: issuerAddressLines,
      amountDue: totals.total,
      dueDate: bill.dueDate,
    },
  };
}
