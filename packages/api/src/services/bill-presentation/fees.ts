import { prisma } from "../../lib/prisma.js";
import type { BillPresentationGroup } from "./document.js";
import { money, sumPrinted } from "./format.js";
import { activityLabel } from "./labels.js";

/**
 * The fees and adjustments charged to the account between this bill and
 * the one before it.
 *
 * A late fee raises the balance and produces no `BillSegmentLine` —
 * lines come entirely from rating, and each carries a
 * `sourceScheduleId` and `sourceComponentId` because a line *is* a rated
 * charge. Without this the customer receives a bill for consumption,
 * owes more than it says, and has nothing explaining the difference.
 *
 * A group, not a block of its own, because a late fee is a charge on
 * this bill and has to read as one. A presentation group costs no schema
 * and prints identically — label, amount, and its own subtotal the
 * customer can add up.
 */

/**
 * The previous bill's date, which is where the window opens.
 *
 * The same account's most recent bill dated before this one, with
 * `billNumber` breaking a tie on the date so two bills issued the same
 * day cannot make the window depend on row order — the determinism that
 * byte-stable regeneration rests on.
 *
 * Null on a first bill, and then the window opens at the account's
 * beginning rather than being empty: a fee raised before the very first
 * bill still has to be explained on it.
 */
async function windowOpensAfter(
  utilityId: string,
  accountId: string,
  billDate: Date,
): Promise<Date | null> {
  const previous = await prisma.bill.findFirst({
    where: { utilityId, accountId, billDate: { lt: billDate } },
    orderBy: [{ billDate: "desc" }, { billNumber: "desc" }],
    select: { billDate: true },
  });
  return previous?.billDate ?? null;
}

export async function loadFeesGroup(
  utilityId: string,
  accountId: string,
  billDate: Date,
  /** Credits already itemised under `settlement`; printing them here would double them. */
  settledCreditIds: string[],
): Promise<BillPresentationGroup | null> {
  const opensAfter = await windowOpensAfter(utilityId, accountId, billDate);

  /*
   * Anything carrying a `bill_id` is excluded, not just `BILL_CHARGE`.
   * A bill's own entry *is* the bill, which the customer has already
   * received, and its effective date is not required to equal the bill
   * date — so excluding only this one could print the previous bill's
   * charge here as though it were new. `postBill` writes a bill that
   * nets negative as an `ADJUSTMENT_CREDIT` with its `bill_id` set, and
   * filtering on the type alone let that one through.
   *
   * `DEPOSIT` is excluded for the reason `recomputeAccountCache`
   * excludes it from the balance: a deposit is money the utility holds,
   * not money the customer owes. Summed in here it told the customer
   * they owed less than they do.
   *
   * The upper bound is not optional: it is the same rule `settlement`
   * follows, for the same reason. A reprint of last March must not
   * acquire a fee raised in April.
   */
  const entries = await prisma.ledgerEntry.findMany({
    where: {
      utilityId,
      accountId,
      billId: null,
      type: { notIn: ["BILL_CHARGE", "DEPOSIT"] },
      effectiveDate: {
        lte: billDate,
        ...(opensAfter ? { gt: opensAfter } : {}),
      },
      ...(settledCreditIds.length > 0 ? { id: { notIn: settledCreditIds } } : {}),
    },
    include: {
      reason: { select: { label: true } },
      // The bill this fee punishes, and — for the credit a replacing
      // tier writes — the fee it cancelled, so a reversal can say what
      // it reversed. `assessedOn` is set only on a FEE
      // (`ledger_entry_assessed_on_only_fee`), and only the delinquency
      // ladder sets it today.
      assessedOn: { select: { bill: { select: { billNumber: true } } } },
      reverses: {
        select: {
          reason: { select: { label: true } },
          assessedOn: { select: { bill: { select: { billNumber: true } } } },
        },
      },
    },
    orderBy: [{ effectiveDate: "asc" }, { id: "asc" }],
  });

  if (entries.length === 0) return null;

  const lines = entries.map((entry) => ({
    label: activityLabel(entry),
    quantity: null,
    amount: money(entry.amount),
  }));
  return {
    heading: "Fees and adjustments",
    lines,
    subtotal: sumPrinted(lines.map((line) => line.amount)),
  };
}
