/**
 * Whether anything is still working a run, and taking it if not.
 *
 * One pass at a time over one run — which is not the same statement as
 * "one run at a time", and the difference is the whole reason this
 * module exists. Two runs at once are fine, two tenants at once are the
 * point, and generation and posting of *the same* run are not: they read
 * and rewrite the same `billing_run_item` rows.
 *
 * That guarantee used to come from `concurrency: 1`, which holds only
 * while there is one replica. Expressing it here instead is what lets
 * the limit become a capacity setting — see
 * `docs/specs/27-job-scheduling.md` §6, SCH-CONC-8 — rather than
 * something an operator can raise and silently break correctness with.
 *
 * **Liveness, not existence.** A run is held by whoever is still
 * reporting progress on it; a pass that has gone quiet past the cutoff
 * is a corpse whose remaining work another node may finish. Judging on
 * existence instead — "is the status RUNNING", "is `posting_started_at`
 * set" — is what `reclaimZombieBillingRuns` did before 2026-10-30, and
 * it is wrong in both directions at once: it refuses the reclaim that
 * exists to recover from a dead node, and it permits a live node's run
 * to be taken by a booting one.
 */
import { Prisma } from "@utility-cis/shared/src/generated/prisma";
import { prisma } from "../../lib/prisma.js";

/**
 * How quiet a run has to be before another process may take it.
 *
 * `last_progress_at` is stamped after every account generated and every
 * bill posted, so a live pass is never five minutes silent — the same
 * cutoff, and the same reasoning, as the import sweep.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Quiet for longer than the cutoff, or never having spoken at all.
 *
 * The null half is not a loophole in the rule, it is the rule at its
 * limit: both entry points stamp `last_progress_at` as they begin, so a
 * row holding none has been advanced by no process that is still
 * running. Excluding it would strand a run as RUNNING forever, which is
 * the same silence the reclaim exists to break.
 *
 * Stated positively, never as `NOT (last_progress_at >= cutoff)`. A NULL
 * in that comparison yields NULL, `NOT NULL` is NULL, and the row simply
 * stops matching — a run nothing can ever claim, failing in the one
 * direction no error would be raised for.
 */
export function unattended(quietSince: Date) {
  return {
    OR: [{ lastProgressAt: { lt: quietSince } }, { lastProgressAt: null }],
  };
}

/**
 * No live pass of either kind holds this run.
 *
 * Both halves are stated as "not live" rather than as a list of statuses
 * a claim is allowed from, which keeps every existing caller working:
 * a PENDING run, a resumed one, and a finished one being re-processed as
 * a no-op are all unheld, and none of them has to be enumerated here.
 */
function unheld(quietSince: Date): Prisma.BillingRunWhereInput {
  return {
    AND: [
      // Generation: not RUNNING at all, or RUNNING and gone quiet.
      { OR: [{ status: { not: "RUNNING" } }, unattended(quietSince)] },
      // Posting: never started, finished, or started and gone quiet.
      // `posted_at` is stamped after the loop, so it cannot mark a
      // middle — a pass in flight is the started-but-not-finished pair.
      {
        OR: [
          { postingStartedAt: null },
          { postedAt: { not: null } },
          unattended(quietSince),
        ],
      },
    ],
  };
}

/**
 * Take the run for a generation pass, or report that someone else has it.
 *
 * One `UPDATE … WHERE`, which is what makes it a claim rather than a
 * check: two processes racing both block on the row, and PostgreSQL
 * re-evaluates the predicate against the committed row before the second
 * proceeds, so it matches nothing and reports zero. The same shape
 * `postBill` uses to claim one bill.
 */
export async function claimForGeneration(runId: string, utilityId: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.billingRun.updateMany({
    where: { id: runId, utilityId, ...unheld(new Date(now.getTime() - STALE_AFTER_MS)) },
    data: { status: "RUNNING", lastProgressAt: now },
  });
  return count > 0;
}

/**
 * Take the run for a posting pass, or report that someone else has it.
 *
 * Marking the pass and claiming it are deliberately the same write.
 * Posting had no guard at all and said so — on the grounds that
 * `postBill` claims each bill atomically, so a duplicate pass cannot
 * double-charge. True, and not the whole cost: a second pass re-renders
 * every document, which is an HTTP call per bill to apptor-connect's
 * files plane, and reports counts for work the other pass did.
 */
export async function claimForPosting(runId: string, utilityId: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.billingRun.updateMany({
    where: { id: runId, utilityId, ...unheld(new Date(now.getTime() - STALE_AFTER_MS)) },
    data: { postingStartedAt: now, lastProgressAt: now },
  });
  return count > 0;
}

/** The 409 both the route and the posting job raise for a live pass. */
export function postingInFlight(runId: string): Error {
  return Object.assign(
    new Error(
      `Billing run ${runId} is being posted by another process. ` +
        "Wait for it to finish; a pass that has stopped is picked up automatically.",
    ),
    { statusCode: 409, code: "RUN_POSTING_IN_FLIGHT" },
  );
}
