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

/**
 * What has already been paid against this bill, as of the bill date.
 *
 * A bill with no payment line is the one thing every utility bill has
 * that this one did not: a customer who paid is told nothing about it,
 * and the totals box states `Credits $0.00` — which is the credits the
 * rate engine computed for the period, not their money, and reads as a
 * denial that it arrived.
 *
 * Bounded at `bill.billDate` on purpose. The ledger moves after a bill
 * is issued, and a document that reads the ledger at render time stops
 * being a record of what the customer was shown — a reprint of last
 * March would print today's balances, which is exactly the property
 * `sha256` and byte-stable regeneration exist to protect. Payments
 * arriving after the bill date belong on the next bill, which is how
 * balance-forward billing works anyway.
 *
 * `null` when nothing was applied by then, so an ordinary bill prints
 * exactly as it did before.
 */
export interface BillPresentationSettlement {
  applied: Array<{ date: Date; label: string; amount: string }>;
  /** Negative: what the applications take off the charge. */
  appliedTotal: string;
  /** `total` less `appliedTotal` — what this bill is still asking for. */
  amountDue: string;
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
  totals: {
    subtotal: string;
    taxes: string;
    credits: string;
    /**
     * The cent the two rounding orders disagree by, or null when they
     * agree — which is most bills. Printed only when present.
     */
    rounding: string | null;
    total: string;
  };
  settlement: BillPresentationSettlement | null;
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
 * What a credit applied to a bill is called on the bill.
 *
 * The ledger's own vocabulary, in the customer's words. A payment says
 * how it arrived when the tender is recorded, because "Payment (check)"
 * is what somebody holding a cancelled cheque is looking for.
 */
const SETTLEMENT_LABELS: Record<string, string> = {
  PAYMENT: "Payment",
  ADJUSTMENT_CREDIT: "Credit adjustment",
  WRITE_OFF: "Write-off",
  DEPOSIT: "Deposit applied",
  REFUND: "Refund",
  REVERSAL: "Reversal",
};

function settlementLabel(type: string, tender: string | null): string {
  const base = SETTLEMENT_LABELS[type] ?? type.toLowerCase().replace(/_/g, " ");
  if (type !== "PAYMENT" || !tender) return base;
  return `${base} (${tender.toLowerCase().replace(/_/g, " ")})`;
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
          // Ordered, because the bill prints exactly one of these and
          // took whichever the database happened to return first. An
          // account with two addresses therefore printed an arbitrary
          // one, and could print a different one on a regeneration —
          // which also breaks the byte-stability that makes `sha256`
          // meaningful as "has this document changed?".
          //
          // Primary first; failing that the oldest, since an account
          // whose only address is not flagged primary still has to be
          // billable. `id` is the final tiebreak so the answer cannot
          // depend on row order.
          billingAddresses: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
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
    // Say which of the two is missing, and where to fix it. "no name or
    // no address" left an operator to guess which, on an account they
    // then had to go and find.
    const lacks = [
      !recipientName ? "no customer with a name" : null,
      !address ? "no billing address" : null,
    ].filter(Boolean);
    throw new BillPresentationError(
      `Account ${bill.account.accountNumber} has ${lacks.join(" and ")}, so this bill cannot say who it is for. ` +
        `Add ${!recipientName && !address ? "both" : "it"} on the account, then generate the bill again.`,
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
  /*
   * The tenant's own row wins over the global default of the same code.
   *
   * Both can exist — `account_type_def` is unique on (utility_id, code),
   * and a tenant overrides a shipped type by adding its own row with the
   * same code, which is how every type-def list resolves it. Without the
   * ordering this was a `findFirst` over both with no preference, so
   * which one came back was whatever Postgres happened to return. That
   * is harmless while no tenant has overridden anything and wrong the
   * moment one does: a message targeted at the tenant's row would stop
   * printing, on the code path that decides what a customer's bill says.
   *
   * `nulls: "last"` is what expresses the preference — descending alone
   * would put NULL first in Postgres.
   */
  const typeDef = await prisma.accountTypeDef.findFirst({
    where: {
      code: bill.account.accountType,
      OR: [{ utilityId }, { utilityId: null }],
    },
    orderBy: { utilityId: { sort: "desc", nulls: "last" } },
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

  /*
   * The totals box is built from the printed group subtotals, not from
   * the stored 4dp columns.
   *
   * The per-group rule above — sum the already-rounded lines, because the
   * customer can add those up — was applied to the groups and then
   * contradicted here, where `subtotal` rounded `bill.subtotal`. Two
   * lines of 16.1050 print as 16.11 and 16.11 under a group subtotal of
   * 32.22, while `bill.subtotal` of 32.2100 rounds to 32.21: one page
   * stating both, and the customer holding it can see that it does not
   * add up. Every fixture on this branch happens to be exact to cents,
   * so nothing caught it.
   *
   * `total` stays tied to `bill.total`, because that is what the ledger
   * raised as the charge and what the remittance stub asks for; a bill
   * must not ask for a number the account does not owe. When the two
   * rounding orders differ, the cent between them is therefore shown as
   * its own line rather than hidden in a total that does not follow from
   * the lines above it. A bill whose figures visibly reconcile, rounding
   * included, is worth more than one that silently absorbs the
   * difference.
   */
  const printedSubtotal = groups.reduce(
    (acc, group) => acc.plus(new Decimal(group.subtotal)),
    new Decimal(0),
  );
  const taxes = new Decimal(money(bill.taxes));
  const credits = new Decimal(money(bill.credits));
  const total = new Decimal(money(bill.total));
  const rounding = total.minus(printedSubtotal.plus(taxes).minus(credits));

  const totals = {
    subtotal: printedSubtotal.toFixed(2),
    taxes: taxes.toFixed(2),
    credits: credits.toFixed(2),
    rounding: rounding.isZero() ? null : rounding.toFixed(2),
    total: total.toFixed(2),
  };

  // ─── What has been paid against it ─────────────────────────────────
  // Through the applications rather than the charge's own open_amount,
  // because the bill has to say what arrived and when, not just that
  // something did. Ordered by effective date with `id` as the tiebreak,
  // for the same reason the billing address is ordered: two credits on
  // one day must not print in whatever order the database returns, or a
  // regeneration can produce different bytes for an unchanged bill.
  const charge = await prisma.ledgerEntry.findFirst({
    where: { utilityId, billId: bill.id, type: "BILL_CHARGE" },
    select: { id: true },
  });
  const applications = charge
    ? await prisma.ledgerApplication.findMany({
        where: {
          utilityId,
          debitId: charge.id,
          credit: { effectiveDate: { lte: bill.billDate } },
        },
        include: { credit: { select: { type: true, tender: true, effectiveDate: true } } },
        orderBy: [{ credit: { effectiveDate: "asc" } }, { id: "asc" }],
      })
    : [];

  let settlement: BillPresentationSettlement | null = null;
  if (applications.length > 0) {
    const appliedTotal = applications.reduce(
      (acc, app) => acc.plus(new Decimal(money(app.amount))),
      new Decimal(0),
    );
    settlement = {
      // `ledger_application.amount` is positive by check constraint —
      // it is how much of a credit went onto this debit. On the bill it
      // reduces what is owed, so it prints signed.
      applied: applications.map((app) => ({
        date: app.credit.effectiveDate,
        label: settlementLabel(app.credit.type, app.credit.tender),
        amount: `-${money(app.amount)}`,
      })),
      appliedTotal: `-${appliedTotal.toFixed(2)}`,
      amountDue: total.minus(appliedTotal).toFixed(2),
    };
  }

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
    settlement,
    messages: messages.map((m) => ({ label: m.label, body: m.body })),
    branding,
    remittance: {
      payTo: (issuer.utilityLegalName || issuer.utilityName) as string,
      addressLines: issuerAddressLines,
      // The stub asks for what is left, not what was raised — same rule
      // the totals box follows about rounding: a bill must not ask for a
      // number the account does not owe. Paying the printed stub on a
      // part-paid bill would otherwise overpay by exactly the amount
      // already received.
      amountDue: settlement ? settlement.amountDue : totals.total,
      dueDate: bill.dueDate,
    },
  };
}
