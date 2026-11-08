import { prisma } from "../lib/prisma.js";
import { createBillSegmentForServiceAgreement } from "./bill-segment.service.js";
import { generateBillForAccount } from "./bill.service.js";

/**
 * The bill that closes an account (Req 134).
 *
 * **Nothing produced one.** Move-out stopped the service, end-dated the
 * agreement and closed the account, and the days between the last
 * regular bill and the final read were billed by nothing. A cycle run
 * could not reach them either — `BILLABLE_ACCOUNT_STATUSES` is
 * `["ACTIVE"]`, so a closed account is never in a run again.
 *
 * **Not a run, deliberately.** Req 134 asks for a final bill "at
 * account closure *independent of billing cycle*", and the billing-run
 * design settled the same way on 2026-10-14: a different trigger, a
 * part-period, a different eligibility rule, and *"it reuses the same
 * two services, not the run"*. Those two services are all this is —
 * `createBillSegmentForServiceAgreement` per agreement, then
 * `generateBillForAccount` once. No run row, no items, no queue.
 *
 * **Every agreement on the account, not only the one just closed.** A
 * closing account may hold several, each with its own unbilled read,
 * and one bill should carry all of them. An agreement with nothing
 * outstanding drops out on `NO_READ_IN_WINDOW`, which is what the run
 * does with the same condition.
 *
 * **Posting is the tenant's call**, through `resolveAutoPostBills`,
 * exactly as for any other bill made one at a time. `bill.service.ts`
 * gives the reason: a run suppresses auto-post because thousands of
 * bills at once is when a bad rate change becomes thousands of wrong
 * receivables, while "the per-account path keeps auto-post as the
 * tenant configured it, because there the operator is looking at the
 * one bill they just made". A move-out is that operator.
 */

export interface FinalBillResult {
  /** The bill, or null when there was nothing left to bill. */
  billId: string | null;
  total: string | null;
  /**
   * Why no bill was produced, when the reason was a fault rather than
   * an empty period — an unpublished tariff, a coverage gap, a rating
   * error. Null when there was simply nothing to bill.
   *
   * Carried rather than thrown, because the caller has already stopped
   * the service: see `moveOut`.
   */
  error: string | null;
}

export async function generateFinalBill(
  utilityId: string,
  actorId: string,
  actorName: string,
  accountId: string,
  opts: { asOf: Date },
): Promise<FinalBillResult> {
  const asOf = opts.asOf;
  const agreements = await prisma.serviceAgreement.findMany({
    where: { utilityId, accountId },
    select: { id: true },
    orderBy: { agreementNumber: "asc" },
  });

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  for (const sa of agreements) {
    try {
      const segment = await createBillSegmentForServiceAgreement(
        utilityId,
        actorId,
        actorName,
        sa.id,
        { asOf },
      );
      if (!periodStart || segment.periodStart < periodStart) periodStart = segment.periodStart;
      if (!periodEnd || segment.periodEnd > periodEnd) periodEnd = segment.periodEnd;
    } catch (err) {
      /*
       * No unbilled read is "nothing to bill for this one", not a
       * fault — the same judgement the run makes. Anything else is a
       * fault and stops the attempt: a bill carrying some of an
       * account's services and silently dropping the rest is worse
       * than no bill, because it looks complete.
       */
      if ((err as { code?: string }).code === "NO_READ_IN_WINDOW") continue;
      throw err;
    }
  }

  if (!periodStart || !periodEnd) return { billId: null, total: null, error: null };

  /*
   * The span of the segments just made, not the account's cycle window.
   *
   * A final bill is a part-period ending the day service stopped, and
   * the cycle window around that date need not contain it — the first
   * run of this reported "nothing to bill" for an account whose segment
   * it had created one line earlier, because the segment ended outside
   * the window its own cycle produced. "Independent of billing cycle"
   * is Req 134's wording and this is what it means in practice.
   */
  const bill = await generateBillForAccount(utilityId, actorId, actorName, accountId, {
    asOfDate: asOf,
    window: { periodStart, periodEnd },
  });
  return { billId: bill.id, total: bill.total, error: null };
}
