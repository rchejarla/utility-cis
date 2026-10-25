import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createServiceRequest } from "./service-request.service.js";
import { AUTOMATED_ACTOR_ID, AUTOMATED_ACTOR_NAME } from "./delinquency.service.js";

/**
 * Turning a delinquency action into field work (#198, #199).
 *
 * A sweep rather than part of the action's own transaction, and the
 * asymmetry is the whole reason: a *late* work order costs nothing, a
 * *duplicate* fee is a wrong bill. So the fee commits with the action
 * and the work orders are eventually correct.
 *
 * `createServiceRequest` could not join that transaction anyway — it
 * calls `nextRequestNumber`, which opens a transaction of its own for
 * the counter row, so a nested call would hold a second pooled
 * connection while the first holds the account lock. Under an hourly
 * fan-out across tenants, that is how a connection pool runs dry.
 * Threading `existingTx` through the counter was the alternative and it
 * buys atomicity nothing here needs.
 *
 * Both sweeps are keyed on state rather than on an event, so they are
 * idempotent by construction and recover on the next tick when the
 * service request module was unavailable.
 */

/** Live, in the sense the ladder means: not yet resolved or cancelled. */
const LIVE = ["PENDING", "COMPLETED"] as const;

/**
 * A disconnection is time-critical field work, so every one of these is
 * HIGH. Deriving a priority from the tier number was the alternative;
 * it would have invented a policy nobody asked for, and SLA resolution
 * keys on (requestType, priority), so a tenant's own SLA row for this
 * type is a better place to express urgency than a map in here.
 */
const WORK_ORDER_PRIORITY = "HIGH" as const;

/**
 * Raise the work order each live action's tier calls for, where one has
 * not been raised already.
 *
 * "Already" means ever, not currently: `serviceRequests: { none: {} }`.
 * An operator who cancels a disconnection has decided something, and a
 * scheduler that raised it again every hour would overrule them sixty
 * times a day.
 */
export async function sweepDelinquencyWorkOrders(
  utilityId: string,
): Promise<{ created: number }> {
  const due = await prisma.delinquencyAction.findMany({
    where: {
      utilityId,
      status: { in: [...LIVE] },
      serviceRequests: { none: {} },
      rule: { serviceRequestTypeCode: { not: null } },
    },
    select: {
      id: true,
      accountId: true,
      daysPastDueAtAction: true,
      balanceAtAction: true,
      rule: { select: { name: true, serviceRequestTypeCode: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let created = 0;
  for (const action of due) {
    const typeCode = action.rule.serviceRequestTypeCode!;
    try {
      await createServiceRequest(
        utilityId,
        AUTOMATED_ACTOR_ID,
        AUTOMATED_ACTOR_NAME,
        {
          accountId: action.accountId,
          requestType: typeCode,
          priority: WORK_ORDER_PRIORITY,
          description:
            `${action.rule.name}: ${action.daysPastDueAtAction} days past due, ` +
            `$${action.balanceAtAction.toFixed(2)} outstanding.`,
        },
        {
          source: "DELINQUENCY_WORKFLOW",
          delinquencyActionId: action.id,
          createdBy: null,
        },
      );
      created++;
    } catch (err) {
      /*
       * One unroutable account must not stop the rest. The type code is
       * validated when the rule is saved, but a type can be deactivated
       * afterwards, and then every account on that tier would throw.
       * Logged and left: the sweep is state-keyed, so the next tick
       * tries again once someone fixes the type.
       */
      logger.error(
        {
          err,
          component: "delinquency-work-order",
          utilityId,
          delinquencyActionId: action.id,
          requestType: typeCode,
        },
        "Could not raise the work order for a delinquency action",
      );
    }
  }

  return { created };
}
