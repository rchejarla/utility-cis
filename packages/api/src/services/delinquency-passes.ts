import { evaluateDelinquencyForTenant } from "./delinquency.service.js";
import {
  sweepDelinquencyWorkOrders,
  sweepReconnections,
} from "./delinquency-work-order.service.js";
import { sweepPaymentPlans, type PlanSweepResult } from "./payment-plan/lifecycle.js";

/**
 * One tenant's nightly collections run, in order.
 *
 * The order is the whole content of this module, which is why it is a
 * function rather than four calls inside the worker's job handler: a
 * sequence nothing can call is a sequence nothing can test, and every
 * step here reads state the step before it wrote.
 *
 * 1. **Payment plans**, because the ladder's suppression reads plan
 *    state. A plan that defaults tonight must be chaseable tonight, and
 *    a plan that completes must stop suppressing before anything is
 *    charged. Run after the ladder instead and a defaulted plan's debts
 *    sit untouched for a further day.
 * 2. **The ladder**, which files actions and raises fees.
 * 3. **Reconnections**, before anything is dispatched: an account that
 *    paid in the same hour it passed the shut-off tier should have no
 *    crew sent either way.
 * 4. **Work orders**, the field work the evaluation implies. Keyed on
 *    state rather than on the evaluation's result, so an action whose
 *    work order could not be raised last night is picked up tonight.
 *
 * Four passes in one job rather than four crons: separate schedules
 * would race over the same account and the answer would depend on
 * scheduling, which is the kind of bug that appears once a month at
 * 03:00.
 */
export interface DelinquencyPassResult {
  plans: PlanSweepResult;
  evaluation: Awaited<ReturnType<typeof evaluateDelinquencyForTenant>>;
  reconnections: Awaited<ReturnType<typeof sweepReconnections>>;
  workOrders: Awaited<ReturnType<typeof sweepDelinquencyWorkOrders>>;
}

export async function runDelinquencyPasses(
  utilityId: string,
  now: Date = new Date(),
  /**
   * The ladder pass, injected only so the worker can wrap it in
   * telemetry without this module knowing what telemetry is.
   */
  evaluate: (
    utilityId: string,
    now: Date,
  ) => Promise<DelinquencyPassResult["evaluation"]> = evaluateDelinquencyForTenant,
): Promise<DelinquencyPassResult> {
  const plans = await sweepPaymentPlans(utilityId, now);
  const evaluation = await evaluate(utilityId, now);
  const reconnections = await sweepReconnections(utilityId);
  const workOrders = await sweepDelinquencyWorkOrders(utilityId);

  return { plans, evaluation, reconnections, workOrders };
}
