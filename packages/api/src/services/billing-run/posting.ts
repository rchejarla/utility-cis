/**
 * Raising a finished run's receivables, and giving each bill its PDF.
 *
 * Separate from execution because it is a second act over a run that is
 * already finished: the review between the two is the point.
 */
import { prisma } from "../../lib/prisma.js";
import { postBill } from "./../ar/posting.service.js";
import { generateBillDocument, BillDocumentError } from "./../bill-document.service.js";
import { BillPresentationError } from "./../bill-presentation.service.js";
import { logger } from "../../lib/logger.js";

/**
 * Whether this run may be posted at all, as distinct from what posting
 * would do.
 *
 * Separate from `postBillingRun` because posting is queued: these
 * refusals are about the run's state and belong to the caller, and
 * raising them inside the job would answer nobody. The route checks
 * first and replies; the job calls this too, since by the time it runs
 * the run may have changed.
 */
export async function assertRunPostable(utilityId: string, runId: string): Promise<void> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  if (run.status === "PENDING" || run.status === "RUNNING") {
    throw Object.assign(
      new Error(`Billing run ${runId} is still ${run.status}; wait for it to finish before posting`),
      { statusCode: 409, code: "RUN_NOT_FINISHED" },
    );
  }
}

/**
 * Post every bill this run produced.
 *
 * The second act. Only bills this run made, and only ones still
 * unposted: a bill somebody posted by hand in between is left alone
 * rather than failing the operation, because the operator's intent and
 * ours agree about the outcome.
 */
export async function postBillingRun(
  utilityId: string,
  actorId: string,
  actorName: string,
  runId: string,
): Promise<{
  posted: number;
  alreadyPosted: number;
  failed: number;
  held: number;
  /** Bills left posted that now have a stored PDF. */
  documented: number;
  /**
   * Bills posted whose PDF could not be stored. Never a posting
   * failure: the bill is owed either way, and the PDF button still
   * generates on demand.
   */
  documentsFailed: number;
  /**
   * Why no documents were attempted, when a tenant-level fact stopped
   * them — a missing storage integration, not a per-bill fault. Null
   * when documents were attempted.
   */
  documentsSkipped: string | null;
}> {
  await assertRunPostable(utilityId, runId);

  /*
   * Mark the pass before doing any of it, so a replica that dies
   * holding this run leaves evidence. `postedAt` is stamped after the
   * loop and so cannot say "a pass is under way"; this is posting's
   * equivalent of generation's `status = RUNNING`, and
   * `reclaimZombieBillingRuns` re-enqueues on exactly this pair.
   *
   * There is deliberately no guard against a pass already being in
   * flight. It would refuse the reclaim, which arrives in precisely
   * that state — and it would be guarding nothing: `postBill` claims
   * atomically with UPDATE ... WHERE posted_at IS NULL, so a duplicated
   * or concurrent pass cannot double-charge. It reports the bills as
   * `alreadyPosted`, which is the same tolerance this loop already
   * extends to a bill somebody posted by hand.
   */
  await prisma.billingRun.update({
    where: { id: runId },
    data: { postingStartedAt: new Date() },
  });

  const items = await prisma.billingRunItem.findMany({
    where: { billingRunId: runId, status: "BILLED", billId: { not: null } },
    select: { billId: true },
  });

  let posted = 0;
  let alreadyPosted = 0;
  let failed = 0;
  let held = 0;
  let documented = 0;
  let documentsFailed = 0;
  /** The one reason documents were not attempted, once it is known. */
  let documentsSkipped: string | null = null;
  for (const item of items) {
    const billId = item.billId as string;
    const bill = await prisma.bill.findFirst({
      where: { id: billId, utilityId },
      select: {
        postedAt: true,
        holdReason: true,
        account: { select: { billingHoldReason: true } },
      },
    });
    if (!bill) continue;

    /*
     * Posting and documenting are decided separately for this bill, and
     * that is the point rather than a tidiness.
     *
     * The loop used to `continue` on an already-posted bill. Rendering
     * after `postBill` inside that shape would skip exactly the bills a
     * *resumed* pass exists to finish — posted by the dead pass, never
     * documented, stepped over forever. The recovery path would have
     * manufactured the state it was meant to clear.
     */
    if (bill.postedAt) {
      alreadyPosted += 1;
    } else if (bill.holdReason ?? bill.account.billingHoldReason) {
      /*
       * Counted apart from `failed`, for the reason this run's whole
       * design rests on: a held bill is a decision somebody made, not
       * work to investigate. Reporting "3 could not post" against three
       * bills an operator deliberately stopped would send them looking
       * for a fault that is not there.
       *
       * Nothing to document either — a document is of a posted bill.
       */
      held += 1;
      continue;
    } else {
      try {
        await postBill(utilityId, actorId, actorName, billId);
        posted += 1;
      } catch (err) {
        failed += 1;
        logger.error(
          { err, component: "billing-run", runId, billId },
          "Posting a run's bill failed",
        );
        // Not posted, so there is nothing to render.
        continue;
      }
    }

    /*
     * The bill is posted — by this pass or an earlier one — so it should
     * have a PDF. Until now `generateBillDocument` had a single caller,
     * the staff button, so after a run no bill had one: bulk send mostly
     * reported NO_BILL_DOCUMENT, and a portal customer could not
     * download their own bill at all, since generating is accounts:EDIT
     * and no portal token holds it.
     *
     * Outside `postBill`'s transaction, and deliberately. Rendering ends
     * in an HTTP call to apptor-connect's files plane; inside the
     * transaction that would hold a per-account lock across a vendor
     * round trip, and a storage failure would roll the posting back —
     * making what a customer owes contingent on whether a letter
     * rendered. It is also already a multi-transaction design (claim,
     * upload, complete) so that a crash cannot leave a claim that looks
     * like a document.
     *
     * A failure here is counted apart and never raised: the bill is
     * posted and owed either way, the PDF button still generates on
     * demand, and calling this a posting failure would send an operator
     * to the ledger to fix a render.
     */
    if (documentsSkipped === null) {
      try {
        await generateBillDocument(utilityId, billId, actorId, actorName, {});
        documented += 1;
      } catch (err) {
        /*
         * A tenant with no storage integration configured is one fact
         * about the tenant, not twelve thousand failures — the same
         * reason bulk send refuses an unposted run outright rather than
         * per bill. Stop trying, say it once, and carry the sentence
         * out so the operator reads a cause rather than a count of
         * zero.
         */
        const tenantWide = tenantWideDocumentFault(err);
        if (tenantWide) {
          documentsSkipped = tenantWide.message;
          logger.warn(
            { component: "billing-run", runId, code: tenantWide.code, missing: tenantWide.missing },
            "A tenant-level setting stops this run producing documents; posting it without them",
          );
        } else {
          documentsFailed += 1;
          logger.error(
            { err, component: "billing-run", runId, billId },
            "Generating a run's bill document failed; the bill is posted regardless",
          );
        }
      }
    }
  }

  await prisma.billingRun.update({
    where: { id: runId },
    data: { postedAt: new Date(), postedBy: actorId },
  });

  return { posted, alreadyPosted, failed, held, documented, documentsFailed, documentsSkipped };
}

/**
 * Whether a document failure is about the tenant rather than this bill.
 *
 * Two of them are, and they are the ones that would otherwise be logged
 * once per bill: nowhere to store a PDF, and no issuer identity to put
 * on one. Twelve thousand copies of a single misconfiguration is the
 * failure mode bulk send already refuses outright rather than reporting
 * per bill, and the operator's job is the same either way — one setting.
 *
 * `RECIPIENT_INCOMPLETE` and `NO_CHARGES` are deliberately not here:
 * those are facts about one customer or one bill, and the next bill may
 * well be fine.
 */
function tenantWideDocumentFault(
  err: unknown,
): { code: string; message: string; missing: string[] } | null {
  const tenantWide =
    (err instanceof BillDocumentError && err.code === "STORAGE_NOT_CONFIGURED") ||
    (err instanceof BillPresentationError && err.code === "ISSUER_INCOMPLETE");
  if (!tenantWide) return null;
  const e = err as BillDocumentError | BillPresentationError;
  return { code: e.code, message: e.message, missing: e.missing };
}
