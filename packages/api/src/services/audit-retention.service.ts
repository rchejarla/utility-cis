import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

/**
 * Daily retention sweep for scheduler-emitted audit rows.
 *
 * Per spec docs/superpowers/specs/2026-04-24-job-scheduler-migration-design.md
 * §3.6: scheduler audits use `source = 'scheduler:<queue>'` and are
 * subject to per-tenant retention via `tenant_config.scheduler_audit_retention_days`.
 * User-emitted audits (source = 'user:<id>' or NULL for legacy rows)
 * are governed by a separate compliance retention policy and stay
 * outside this sweep's scope.
 *
 * Implementation choices:
 *   - Batched DELETE in chunks of 10k IDs to avoid taking out long
 *     row locks on a large audit table. Each batch is a single SQL
 *     statement; we loop until either the batch comes back empty
 *     or the tick runs longer than 10 minutes (the next day's run
 *     resumes from where this one stopped).
 *   - The IN (SELECT … LIMIT) form lets Postgres pick rows quickly
 *     by index; doing one big DELETE could take minutes on a hot
 *     table.
 *   - Per-tenant retention computed via a JOIN in SQL — no Node-side
 *     tenant loop.
 *
 * Returns counts so the worker can log meaningful per-tick output.
 */

const BATCH_SIZE = 10_000;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export async function sweepExpiredSchedulerAudits(
  now: Date = new Date(),
): Promise<{ deleted: number; batches: number; timedOut: boolean }> {
  const startedAt = Date.now();
  let deleted = 0;
  let batches = 0;
  let timedOut = false;

  // Loop until a batch returns 0 rows or we exceed the time budget.
  // The batch query selects the IDs of expired scheduler audits for
  // ALL tenants in one statement, picking only LIMIT rows so each
  // round trip is bounded.
  for (;;) {
    if (Date.now() - startedAt > MAX_DURATION_MS) {
      timedOut = true;
      break;
    }

    const result = await prisma.$executeRaw`
      DELETE FROM audit_log
      WHERE id IN (
        SELECT al.id
        FROM audit_log al
        INNER JOIN tenant_config tc ON tc.utility_id = al.utility_id
        WHERE al.source LIKE 'scheduler:%'
          AND al.created_at < ${now} - (tc.scheduler_audit_retention_days || ' days')::interval
        LIMIT ${BATCH_SIZE}
      )
    `;
    const rowsThisBatch = Number(result);
    if (rowsThisBatch === 0) break;
    deleted += rowsThisBatch;
    batches++;
  }

  if (deleted > 0 || timedOut) {
    logger.info(
      { component: "audit-retention", deleted, batches, timedOut },
      "Audit retention sweep complete",
    );
  }

  return { deleted, batches, timedOut };
}
