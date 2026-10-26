import { Decimal } from "decimal.js";
import { BillPresentationError, type BillPresentationGroup } from "./document.js";
import { money, sumPrinted } from "./format.js";

/**
 * The rated charges, one group per commodity.
 *
 * Group subtotals sum the ALREADY-ROUNDED lines rather than rounding a
 * stored 4dp subtotal. What the customer can add up has to be what is
 * printed; rounding each line and then rounding a separate total can
 * disagree by cents, and they are the ones holding the paper.
 */

/** A bill segment and its lines, as the presentation query selects them. */
export interface RatedSegment {
  serviceAgreement: { commodity: { id: string; code: string; name: string | null } | null } | null;
  lines: Array<{
    label: string;
    quantity: Decimal | null;
    unit?: string | null;
    amount: Decimal;
  }>;
}

/**
 * Refuses a bill with nothing rated on it (`NO_CHARGES`).
 *
 * A bill that prints a total with no lines behind it is the thing the
 * statement view exists to avoid, and an empty one reaching a customer
 * cannot be explained by anyone who receives the question.
 */
export function chargeGroups(segments: RatedSegment[]): BillPresentationGroup[] {
  const groups: BillPresentationGroup[] = [];
  for (const segment of segments) {
    if (segment.lines.length === 0) continue;
    const commodity = segment.serviceAgreement?.commodity;
    const lines = segment.lines.map((line) => ({
      label: line.label,
      quantity:
        line.quantity === null
          ? null
          : line.unit
            ? `${money(line.quantity)} ${line.unit}`
            : money(line.quantity),
      amount: money(line.amount),
    }));
    groups.push({
      heading: commodity?.name ?? commodity?.code ?? "Charges",
      lines,
      subtotal: sumPrinted(lines.map((line) => line.amount)),
    });
  }

  if (groups.length === 0) {
    throw new BillPresentationError("Bill has no charge lines to render", "NO_CHARGES");
  }
  return groups;
}
