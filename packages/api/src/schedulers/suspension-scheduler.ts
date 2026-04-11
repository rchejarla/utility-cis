import type { FastifyBaseLogger } from "fastify";
import {
  transitionSuspensions,
  listTenantsWithActiveHolds,
} from "../services/service-suspension.service.js";

/**
 * Service-hold lifecycle scheduler.
 *
 * Runs every hour via setInterval and flips PENDING → ACTIVE for any
 * hold whose startDate has arrived (respecting the tenant's approval
 * gate) and ACTIVE → COMPLETED for any hold whose endDate has passed.
 *
 * ───────────────────────────────────────────────────────────────────
 * SINGLE-INSTANCE ONLY. Running two API processes will cause the same
 * hold to be transitioned twice and emit duplicate audit events. When
 * we move to a multi-instance deployment, swap this for BullMQ with
 * Redis-backed job locking.
 * ───────────────────────────────────────────────────────────────────
 *
 * Tests and worker processes can set DISABLE_SCHEDULERS=true to opt
 * out of background side effects.
 */

const HOURLY_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 30_000; // let the API finish warming up

let intervalHandle: NodeJS.Timeout | null = null;

async function runOnce(log: FastifyBaseLogger): Promise<void> {
  const now = new Date();
  let tenants: string[] = [];
  try {
    tenants = await listTenantsWithActiveHolds();
  } catch (err) {
    log.error({ err }, "suspension-scheduler: failed to list tenants");
    return;
  }

  if (tenants.length === 0) return;

  let totalActivated = 0;
  let totalCompleted = 0;

  for (const utilityId of tenants) {
    try {
      const result = await transitionSuspensions(utilityId, now);
      totalActivated += result.activated;
      totalCompleted += result.completed;
      if (result.activated > 0 || result.completed > 0) {
        log.info(
          { utilityId, ...result },
          "suspension-scheduler: transitioned holds for tenant",
        );
      }
    } catch (err) {
      log.error(
        { err, utilityId },
        "suspension-scheduler: transition failed for tenant",
      );
    }
  }

  if (totalActivated > 0 || totalCompleted > 0) {
    log.info(
      { tenants: tenants.length, totalActivated, totalCompleted },
      "suspension-scheduler: tick complete",
    );
  }
}

export function startSuspensionScheduler(log: FastifyBaseLogger): void {
  if (intervalHandle) {
    log.warn("suspension-scheduler: already running, ignoring start");
    return;
  }
  log.info("suspension-scheduler: starting (hourly, single-instance)");

  // Delay the first run briefly so it doesn't collide with server
  // startup, then run immediately (no waiting a full hour for the first
  // tick after a deploy).
  setTimeout(() => {
    void runOnce(log);
    intervalHandle = setInterval(() => {
      void runOnce(log);
    }, HOURLY_MS);
  }, FIRST_RUN_DELAY_MS);
}

export function stopSuspensionScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
