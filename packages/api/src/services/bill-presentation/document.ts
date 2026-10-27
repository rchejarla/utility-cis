/**
 * The shape of a bill once it has been resolved for rendering.
 *
 * Types only, and deliberately: this is what the author of a template
 * writes against, with none of the machinery that fills it in. The PDF
 * renderer, the print-vendor export and the e-bill HTML (spec 09 names
 * those three document types) all read this one form, and resolving once
 * is what makes a bill reproducible — the same presentation renders the
 * same document.
 *
 * It holds no Prisma types and no Decimals. Every amount is a 2dp string
 * because that is what gets printed, and a template that could do
 * arithmetic on a bill would be a second place deciding what is owed.
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
  /**
   * The quantity as printed, unit and all — "6.63 HCF", not "6.63".
   *
   * The engine bills in the unit the tariff is written in, which is not
   * always the meter's: a gallons meter on an HCF tariff bills 6.6279,
   * and a customer holding the paper cannot reconcile that with the
   * meter in their basement unless the bill says which it is.
   */
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

/**
 * Where the account stood when this bill was issued.
 *
 * Read from the snapshot frozen onto the bill at posting, never
 * recomputed — `pastDue` needs allocation state that is current only
 * then, and `reverseEntry` destroys it afterwards. Null on a bill issued
 * before the snapshot existed, and then the layout omits these lines
 * rather than inventing figures that are not recoverable.
 *
 * Every amount is a 2dp string. `previousBalance` may be negative: an
 * account in credit at the last bill carried that credit forward, and
 * clamping it would overstate what is owed.
 */
export interface BillPresentationStatement {
  previousBalance: string;
  /** Positive. The layout subtracts it. */
  paymentsSince: string;
  /** `previousBalance` less `paymentsSince` — what came into this period. */
  balanceForward: string;
  /** Of the total, how much was already due. A part of it, not an addition. */
  pastDue: string;
}

/**
 * One line of the totals box, in the order it prints.
 *
 * **The box is resolved here and rendered verbatim**, because it used to
 * be built twice — in the PDF template and in the staff popup — and
 * every change touched one of them. Fees went into the total and the
 * popup did not show them; the balance carried forward went in and the
 * popup showed a total $523.55 larger than its own lines. They had also
 * drifted unnoticed: the PDF printed Taxes unconditionally and a
 * Rounding row, the popup hid Taxes at zero and had no Rounding row.
 *
 * So a renderer prints this list and decides nothing. Adding a figure to
 * the total means adding a row here, once, and both surfaces carry it.
 *
 * `amount` is signed and already formatted, so a renderer never does
 * arithmetic on a bill.
 */
export interface BillPresentationTotalRow {
  label: string;
  amount: string;
  /**
   * `total` is the grand total and is set off from the rows above it.
   * `note` qualifies the total rather than adding to it — the past-due
   * part. Absent on an ordinary row.
   */
  emphasis?: "total" | "note";
}

export interface BillPresentationTotals {
  subtotal: string;
  taxes: string;
  credits: string;
  /**
   * The cent the two rounding orders disagree by, or null when they
   * agree — which is most bills. Printed only when present.
   */
  rounding: string | null;
  /** The fees group's subtotal, or null when there are none. */
  fees: string | null;
  total: string;
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
  /**
   * The fees-and-adjustments group, or null when the bill carries none.
   *
   * The same object that is also the last entry in `groups` — a template
   * prints it there like any other charge group, and this is for a
   * consumer that wants only the fees. The staff bill popup is one: it
   * renders the rated segments from the `Bill` itself and had no way to
   * show the fees except by matching on the heading string or assuming
   * the group is last, neither of which is a contract anybody wrote
   * down.
   */
  feesGroup: BillPresentationGroup | null;
  /** Where the account stood when this bill was issued, or null. */
  statement: BillPresentationStatement | null;
  /**
   * The totals box as printed, in order. Renderers iterate this.
   *
   * `totals` below keeps the same figures by name, for the remittance
   * stub and for anything that needs one of them rather than the box.
   * Both come from one computation, so they cannot disagree.
   */
  totalRows: BillPresentationTotalRow[];
  totals: BillPresentationTotals;
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
  /**
   * 422 for every code here: the tenant's data cannot make a bill.
   *
   * Carried on the error so a route that does not map these codes
   * itself still answers 422 rather than 500 — the global handler reads
   * `statusCode`. `bill-documents.ts` keeps its own table because it
   * also maps `BillDocumentError` and attaches `missing` to the body;
   * every presentation code in that table is 422, so this agrees with
   * it rather than competing.
   */
  readonly statusCode = 422;

  constructor(
    message: string,
    readonly code: BillPresentationErrorCode,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = "BillPresentationError";
  }
}
