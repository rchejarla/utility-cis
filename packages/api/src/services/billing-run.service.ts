/**
 * Billing runs — one initiated pass over a cycle, account by account.
 *
 * Design: `docs/superpowers/specs/2026-10-14-billing-run-design.md`.
 *
 * The run calculates; posting is a separate act over the finished run.
 * A run is exactly when a bad rate change becomes twelve thousand wrong
 * charges, and reversing those is far worse than discarding unposted
 * bills — so the review step between the two is the point, not an
 * omission.
 *
 * This file is the module's public face and nothing else. The work moved
 * into `billing-run/` when the single file reached 1,411 lines: planning
 * a run, working it down, posting it, sending it, stopping it and
 * reading it are six things that change for different reasons, and the
 * directory qualifies each name so none of them repeats "billing run" in
 * its own.
 *
 * It is a re-export, not a redesign — the seams were already there and
 * the split follows them rather than claiming better ones. Callers
 * import from here unchanged.
 */

export type { BillingRunSummary } from "./billing-run/summary.js";
export type { BillingRunPlan, RunBlocker, CreateBillingRunArgs } from "./billing-run/planning.js";
export { previewBillingRun, createBillingRun } from "./billing-run/planning.js";
export { processBillingRun } from "./billing-run/execution.js";
export { assertRunPostable, postBillingRun } from "./billing-run/posting.js";
export type { SendSkip } from "./billing-run/delivery.js";
export { sendBillingRun } from "./billing-run/delivery.js";
export { cancelBillingRun, resumeBillingRun } from "./billing-run/lifecycle.js";
export type { BillingRunDetail, RunExceptionGroup } from "./billing-run/reading.js";
export {
  listBillingRuns,
  getBillingRun,
  summariseRunExceptions,
  listBillingRunItems,
} from "./billing-run/reading.js";
