import { Decimal } from "decimal.js";
import { prisma } from "../../lib/prisma.js";
import type { BillPresentationSettlement } from "./document.js";
import { money } from "./format.js";
import { settlementLabel } from "./labels.js";

/**
 * What has already been paid against this bill.
 *
 * Read through the applications rather than the charge's own
 * `open_amount`, because the bill has to say what arrived and when, not
 * just that something did. Ordered by effective date with `id` as the
 * tiebreak: two credits on one day must not print in whatever order the
 * database returns, or a regeneration produces different bytes for an
 * unchanged bill.
 *
 * Bounded at the bill date, which is the rule the whole document
 * follows — see `BillPresentationSettlement`.
 */

export interface AppliedCredit {
  /** The credit's id, so the fees window can avoid printing it twice. */
  creditId: string;
  date: Date;
  label: string;
  /** Positive, as `ledger_application.amount` is stored. */
  amount: string;
}

export async function loadAppliedCredits(
  utilityId: string,
  billId: string,
  billDate: Date,
): Promise<AppliedCredit[]> {
  const charge = await prisma.ledgerEntry.findFirst({
    where: { utilityId, billId, type: "BILL_CHARGE" },
    select: { id: true },
  });
  if (!charge) return [];

  const applications = await prisma.ledgerApplication.findMany({
    where: {
      utilityId,
      debitId: charge.id,
      credit: { effectiveDate: { lte: billDate } },
    },
    include: { credit: { select: { type: true, tender: true, effectiveDate: true } } },
    orderBy: [{ credit: { effectiveDate: "asc" } }, { id: "asc" }],
  });

  return applications.map((app) => ({
    creditId: app.creditId,
    date: app.credit.effectiveDate,
    label: settlementLabel(app.credit.type, app.credit.tender),
    amount: money(app.amount),
  }));
}

/**
 * The settlement block, or null when nothing had been applied by the
 * bill date — then an ordinary bill prints exactly as it did before.
 *
 * `total` is the printed total, so `amountDue` is what this bill is
 * still asking for.
 */
export function settlementOf(
  applied: AppliedCredit[],
  total: Decimal,
): BillPresentationSettlement | null {
  if (applied.length === 0) return null;

  const appliedTotal = applied.reduce(
    (acc, credit) => acc.plus(new Decimal(credit.amount)),
    new Decimal(0),
  );
  return {
    // `ledger_application.amount` is positive by check constraint — it
    // is how much of a credit went onto this debit. On the bill it
    // reduces what is owed, so it prints signed.
    applied: applied.map((credit) => ({
      date: credit.date,
      label: credit.label,
      amount: `-${credit.amount}`,
    })),
    appliedTotal: `-${appliedTotal.toFixed(2)}`,
    amountDue: total.minus(appliedTotal).toFixed(2),
  };
}
