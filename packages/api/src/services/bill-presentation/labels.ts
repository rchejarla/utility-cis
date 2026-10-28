import { ymd } from "./format.js";

/**
 * What a ledger entry is called on a bill.
 *
 * The ledger's own vocabulary, in the customer's words. Nothing here
 * invents a name for a thing a tenant has already named — a utility
 * that calls its late fee a "Late charge" sees that on the bill — so
 * these are the fallbacks for entries that cite no reason, plus the
 * trimmings a reason alone cannot supply.
 */

const SETTLEMENT_LABELS: Record<string, string> = {
  PAYMENT: "Payment",
  ADJUSTMENT_CREDIT: "Credit adjustment",
  WRITE_OFF: "Write-off",
  DEPOSIT: "Deposit applied",
  REFUND: "Refund",
  REVERSAL: "Reversal",
};

/**
 * What a credit applied to a bill is called.
 *
 * A payment says how it arrived when the tender is recorded, because
 * "Payment (check)" is what somebody holding a cancelled cheque is
 * looking for.
 */
export function settlementLabel(type: string, tender: string | null): string {
  const base = SETTLEMENT_LABELS[type] ?? type.toLowerCase().replace(/_/g, " ");
  if (type !== "PAYMENT" || !tender) return base;
  return `${base} (${tender.toLowerCase().replace(/_/g, " ")})`;
}

/** One row of the fees-and-adjustments window, as the query selects it. */
export interface ActivityEntry {
  type: string;
  tender: string | null;
  effectiveDate: Date;
  reason: { label: string } | null;
  assessedOn: { bill: { billNumber: string } | null } | null;
  reverses: {
    reason: { label: string } | null;
    assessedOn: { bill: { billNumber: string } | null } | null;
  } | null;
}

/**
 * What one fees-and-adjustments line is called.
 *
 * Three parts: the tenant's own wording for the reason, the date it was
 * raised, and the bill it was raised on. The last is what the per-bill
 * ladder made necessary — a tier charges each unpaid bill separately, so
 * one statement can carry three late fees, and reason-and-date alone
 * printed them as three identical lines on a page whose whole claim is
 * that the customer can see what each charge is for.
 *
 * A reversal borrows the entry it cancelled, because "Reversal" names
 * nothing the customer can place, and the credit a REPLACE_LOWER_TIERS
 * tier writes only reads as a superseded fee next to the charge that
 * replaced it — which needs both lines naming the same bill. It borrows
 * only when that entry carries a reason: a reversed bill charge has
 * none, and "Reversal reversed" is worse than "Reversal".
 *
 * The bill is absent whenever none produced the debit: `chargeableDebits`
 * admits an opening-balance ADJUSTMENT_DEBIT, and a fee a CSR raises by
 * hand is assessed on nothing at all. Then the date stands alone, which
 * is what every one of these lines said before.
 *
 * The date and the bill ride in the label because a charge group has no
 * columns for them, and "when" and "what for" are the first two things a
 * customer asks about a fee.
 */
export function activityLabel(entry: ActivityEntry): string {
  const reversed = entry.type === "REVERSAL" ? entry.reverses : null;
  const reversedLabel = reversed?.reason?.label;
  const base = reversedLabel
    ? `${reversedLabel} reversed`
    : (entry.reason?.label ?? settlementLabel(entry.type, entry.tender));
  const billNumber = (reversed ?? entry).assessedOn?.bill?.billNumber ?? null;
  const dated = `${base} ${ymd(entry.effectiveDate)}`;
  return billNumber ? `${dated} — for bill ${billNumber}` : dated;
}
