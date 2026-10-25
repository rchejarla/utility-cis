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
      /*
       * `isActive` matters: DELETE on a rule only sets that flag
       * (`routes/delinquency.ts`), so without it "deleting" a shut-off
       * tier would go on dispatching for every live action it had
       * already raised.
       */
      rule: { serviceRequestTypeCode: { not: null }, isActive: true },
      /*
       * And the account still has to owe something. These actions
       * accumulate — nothing resolved them automatically before
       * `sweepReconnections` — so a tenant switching the feature on
       * would otherwise back-dispatch months of them at once, against
       * balances long since settled.
       */
      account: { isProtected: false, status: "ACTIVE", balance: { gt: 0 } },
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

/**
 * How the balance came to be clear, in the vocabulary
 * `resolutionTypes` already uses.
 *
 * A balance reaches zero by being paid, written off or credited, and
 * recording a write-off as a payment received would put a falsehood in
 * the collections record. The ledger says which it was: the most recent
 * credit on the account is what cleared it.
 *
 * Nothing at all means nothing was ever owed, which the vocabulary has
 * no word for; PAYMENT_RECEIVED is the least misleading of the four.
 */
const CLEARED_BY = {
  PAYMENT: "PAYMENT_RECEIVED",
  WRITE_OFF: "WRITE_OFF",
  ADJUSTMENT_CREDIT: "WAIVED",
} as const;

async function howItCleared(utilityId: string, accountId: string): Promise<string> {
  const last = await prisma.ledgerEntry.findFirst({
    where: {
      utilityId,
      accountId,
      type: { in: ["PAYMENT", "WRITE_OFF", "ADJUSTMENT_CREDIT"] },
    },
    orderBy: { postedAt: "desc" },
    select: { type: true },
  });
  return CLEARED_BY[last?.type as keyof typeof CLEARED_BY] ?? "PAYMENT_RECEIVED";
}

/**
 * Ask for the service back where an account has cleared its balance,
 * and close the action that put it off (#199).
 *
 * Keyed on state for the same reason as the sweep above, and against a
 * sharper alternative: the obvious trigger is "a payment brought the
 * balance to zero", but hanging this off `recordPayment` would put
 * collections in the money path, so taking a payment could fail because
 * the service request module refused. Backwards. "Which accounts have a
 * live shut-off action and nothing owing" needs no event at all.
 *
 * A reconnection is only asked for where the disconnection was actually
 * carried out — the shut-off request exists and is COMPLETED. An account
 * that paid before a crew went out has nothing to turn back on, and
 * sending one would be a wasted truck roll. The action is resolved
 * either way: the debt is settled, which is what the action was about.
 *
 * Runs **before** `sweepDelinquencyWorkOrders` in the worker, so an
 * account that cleared in the same hour it passed the tier is resolved
 * before anything is dispatched against it.
 */
export async function sweepReconnections(
  utilityId: string,
): Promise<{ created: number; resolved: number }> {
  /*
   * Every live action on a cleared account, not only the ones whose
   * tier names a reconnection type. Filtering on that code was the
   * original reading of #199 and it left the notice tiers — the ones
   * that charge the late fees — live forever, because nothing else
   * resolves an action: `resolveAccount` has one caller, a route. A
   * tier that has already acted and is never resolved can never act
   * again, so a customer who pays twenty days late every month would
   * have been charged one late fee in their lifetime.
   *
   * Closing the episode here is what makes the charge gate in
   * `delinquency.service.ts` safe in the other direction too.
   */
  const cleared = await prisma.delinquencyAction.findMany({
    where: {
      utilityId,
      status: { in: [...LIVE] },
      account: { balance: { lte: 0 } },
    },
    select: {
      id: true,
      accountId: true,
      rule: {
        select: { name: true, serviceRequestTypeCode: true, reconnectRequestTypeCode: true },
      },
      serviceRequests: { select: { requestType: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let created = 0;
  let resolved = 0;

  for (const action of cleared) {
    const reconnectCode = action.rule.reconnectRequestTypeCode;
    const shutOffCode = action.rule.serviceRequestTypeCode;
    const wasDisconnected =
      !!reconnectCode &&
      !!shutOffCode &&
      action.serviceRequests.some(
        (r) => r.requestType === shutOffCode && r.status === "COMPLETED",
      );
    const alreadyAsked =
      !!reconnectCode && action.serviceRequests.some((r) => r.requestType === reconnectCode);

    if (reconnectCode && wasDisconnected && !alreadyAsked) {
      try {
        await createServiceRequest(
          utilityId,
          AUTOMATED_ACTOR_ID,
          AUTOMATED_ACTOR_NAME,
          {
            accountId: action.accountId,
            requestType: reconnectCode,
            priority: WORK_ORDER_PRIORITY,
            description: `Balance cleared after ${action.rule.name}. Restore service.`,
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
         * The action stays live, so the next tick tries again. Resolving
         * it here would lose the reconnection entirely, and an account
         * left without supply after paying is the one outcome worth
         * retrying forever.
         */
        logger.error(
          {
            err,
            component: "delinquency-work-order",
            utilityId,
            delinquencyActionId: action.id,
            requestType: reconnectCode,
          },
          "Could not raise the reconnection request for a cleared account",
        );
        continue;
      }
    }

    await prisma.delinquencyAction.update({
      where: { id: action.id },
      data: {
        status: "RESOLVED",
        resolvedAt: new Date(),
        resolutionType: await howItCleared(utilityId, action.accountId),
      },
    });
    resolved++;
  }

  return { created, resolved };
}
