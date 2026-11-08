/**
 * What an operator is told after a move-out.
 *
 * A move-out moves money in two directions at once — a deposit back to
 * the customer, a final bill to them — and "Move-out complete" answers
 * neither. These are the parts they will be rung about, so each one
 * that happened gets a sentence.
 *
 * Its own module because it is all branches and no markup: rendered
 * inside the page it could only be checked by driving the whole form.
 */

export interface MoveOutOutcome {
  depositReturn: { refunded: string; stillOwed: string } | null;
  finalBill: { billId: string | null; total: string | null; error: string | null } | null;
  /** The balance after the final bill, when one was produced. */
  closingBalance: string | null;
}

export function describeOutcome(res: MoveOutOutcome): {
  text: string;
  tone: "success" | "error";
} {
  const { depositReturn: deposit, finalBill: bill } = res;

  /*
   * The balance after the bill where there is one. `stillOwed` is
   * measured where the refund is written, which is before the final
   * bill exists — so quoting it beside a bill just raised understates
   * what the customer owes by exactly that bill.
   */
  const owed = res.closingBalance ?? deposit?.stillOwed ?? null;

  const sentences: string[] = [];
  if (bill?.billId) {
    sentences.push(`Final bill of $${bill.total} issued.`);
  } else if (bill?.error) {
    sentences.push(
      `The final bill could not be produced: ${bill.error} The account is held at Final until it is.`,
    );
  }
  if (deposit) {
    sentences.push(
      parseFloat(deposit.refunded) === 0
        ? "No deposit was held, so nothing was returned."
        : `Deposit of $${deposit.refunded} returned.`,
    );
  }
  if (owed !== null && parseFloat(owed) > 0) {
    sentences.push(`This account still owes $${owed}.`);
  }

  /*
   * "Service stopped" rather than "Move-out complete" when the bill
   * failed: the service really has stopped — that is done and cannot be
   * undone by a rating fault — but the account is not closed and
   * somebody has to come back to it.
   */
  const opening = bill?.error ? "Service stopped." : "Move-out complete.";
  return {
    text: [opening, ...sentences].join(" "),
    tone: bill?.error ? "error" : "success",
  };
}
