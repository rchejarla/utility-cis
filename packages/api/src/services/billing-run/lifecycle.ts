/** Stopping a run, and putting its unfinished accounts back. */
import { prisma } from "../../lib/prisma.js";
import { RUN_CYCLE_SELECT, toSummary, type BillingRunSummary } from "./summary.js";
import { auditUpdate } from "../../lib/audit-wrap.js";
import { EVENT_TYPES } from "@utility-cis/shared";

/** Ask a run to stop; it finishes the account it is on. */
export async function cancelBillingRun(
  utilityId: string,
  runId: string,
): Promise<BillingRunSummary> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }
  const updated = await prisma.billingRun.update({
    where: { id: runId },
    data: { cancelRequested: true },
    include: { cycle: RUN_CYCLE_SELECT },
  });
  return toSummary(updated);
}

/**
 * The states a run can be resumed from.
 *
 * `CANCELLED` is in the list because one run per window is a database
 * constraint (`@@unique([utilityId, billingCycleId, windowEnd])`), so a
 * cancelled run cannot be superseded by a new one — without resume,
 * cancelling would close the period permanently. `COMPLETE` has nothing
 * unbilled; `PENDING` and `RUNNING` are already being worked.
 */
const RESUMABLE_STATUSES = ["FAILED", "PARTIAL", "CANCELLED"] as const;

/**
 * Put a run's unbilled accounts back in the queue.
 *
 * `FAILED` is not a different state from `PARTIAL` — the status rule in
 * `finaliseRun` reads "nothing billed and nothing pending" — so both
 * mean the same thing: some accounts are not billed. A run is a
 * worklist, open until every item resolves, and the ordinary operating
 * loop is run → fix the cause an exception names → resume. Before this
 * existed, the only way past a failed run was to edit rows by hand, and
 * `resolveRunPlan`'s guard would not let a new run near the window
 * either.
 *
 * Resume is deliberately the retry mechanism rather than BullMQ's:
 * `billing-run-worker` sets `attempts: 1` precisely so an automatic
 * retry cannot restart a run whose early accounts are already billed.
 * This resets only what is *not* `BILLED`, and `processBillingRun`
 * selects `PENDING` items, so an account cannot be billed twice.
 *
 * `SKIPPED` is reset along with `FAILED`, because a skip is "not ready"
 * rather than "nothing to do": `NO_READ_IN_WINDOW` resolves the moment
 * a reader submits, and re-checking one that genuinely has nothing to
 * bill costs an eligibility query and skips again.
 */
export async function resumeBillingRun(
  utilityId: string,
  actorId: string,
  actorName: string,
  runId: string,
): Promise<BillingRunSummary> {
  const run = await prisma.billingRun.findFirst({ where: { id: runId, utilityId } });
  if (!run) {
    throw Object.assign(new Error(`Billing run ${runId} not found`), {
      statusCode: 404,
      code: "RUN_NOT_FOUND",
    });
  }

  if (!(RESUMABLE_STATUSES as readonly string[]).includes(run.status)) {
    throw Object.assign(
      new Error(
        `Billing run ${runId} is ${run.status}. Only a ${RESUMABLE_STATUSES.join(" or ")} ` +
          "run has unbilled accounts to retry; a live run is already working through them.",
      ),
      { statusCode: 409, code: "RUN_NOT_RESUMABLE" },
    );
  }

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "BillingRun" },
    EVENT_TYPES.BILLING_RUN_RESUMED,
    run,
    async (tx) => {
      await tx.billingRunItem.updateMany({
        where: { billingRunId: runId, status: { in: ["FAILED", "SKIPPED"] } },
        // The reason is cleared with the retry: a stale error_code
        // describes an attempt that is no longer the latest one, and the
        // exception list reads it as current.
        data: { status: "PENDING", errorCode: null, errorMessage: null, processedAt: null },
      });

      const updated = await tx.billingRun.update({
        where: { id: runId },
        data: {
          status: "PENDING",
          // A cancel asked for during the previous pass must not carry
          // over, or the worker would stop on the first item again.
          cancelRequested: false,
          lastProgressAt: new Date(),
        },
        include: { cycle: RUN_CYCLE_SELECT },
      });
      return toSummary(updated);
    },
  );
}
