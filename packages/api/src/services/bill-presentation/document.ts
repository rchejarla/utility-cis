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
