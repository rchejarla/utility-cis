import { DEFAULT_REASON_CODES, EVENT_TYPES, type ReasonedType } from "@utility-cis/shared";
import { prisma } from "../../lib/prisma.js";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import type { TxClient } from "./posting.service.js";

/**
 * The tenant's reason codes — why a fee or adjustment was raised.
 *
 * What varies per utility is the business reason, not the kind of act:
 * tap fee, meter test fee, tamper charge, "courtesy — first occurrence"
 * all grow without a code change, while the three acts stay fixed in the
 * type enum (§3.4, §3.5).
 *
 * `resolveReason` is the single gate every writing service goes through,
 * so the `appliesToType` rule is enforced in one place rather than in
 * four services with a chance of being forgotten in the fourth.
 *
 * There is deliberately no `requiresApproval` here (§4.4): it would be
 * write-only until an approvals workflow exists, and approval cannot be
 * a state on a ledger entry at all — posting is final, so a waiver
 * awaiting approval must not already have reduced the balance. That
 * needs a request object outside the ledger.
 */

function err(code: string, message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export interface ReasonRow {
  id: string;
  code: string;
  label: string;
  appliesToType: string;
  isActive: boolean;
}

/**
 * Resolve a reason for a new entry of `expectedType`, or throw.
 *
 * Callers pass the type they are about to write, not the type they hope
 * the reason has, so a mismatch is caught before the insert rather than
 * by the database.
 */
export async function resolveReason(
  tx: TxClient,
  utilityId: string,
  reasonId: string,
  expectedType: ReasonedType,
): Promise<ReasonRow> {
  const row = await tx.ledgerReasonDef.findFirst({
    where: { id: reasonId, utilityId },
    select: { id: true, code: true, label: true, appliesToType: true, isActive: true },
  });
  // An inactive code is treated the same as a missing one, on purpose:
  // both mean "you may not cite this on a new entry", and distinguishing
  // them would confirm to a caller that an id they guessed exists.
  if (!row || !row.isActive) {
    throw err("REASON_NOT_FOUND", `Reason ${reasonId} not found or inactive`, 404);
  }
  if (row.appliesToType !== expectedType) {
    throw err(
      "REASON_TYPE_MISMATCH",
      `Reason ${row.code} applies to ${row.appliesToType}, not ${expectedType}`,
      422,
    );
  }
  return row;
}

/**
 * The reason codes an operator may choose from.
 *
 * Active only by default. A retired code is still returned on request,
 * because entries that already cite it have to stay readable — retiring
 * a code stops new use, it does not rewrite history.
 */
export async function listReasons(
  utilityId: string,
  opts: { appliesToType?: ReasonedType; includeInactive?: boolean } = {},
): Promise<ReasonRow[]> {
  return prisma.ledgerReasonDef.findMany({
    where: {
      utilityId,
      ...(opts.appliesToType ? { appliesToType: opts.appliesToType } : {}),
      ...(opts.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ appliesToType: "asc" }, { code: "asc" }],
    select: { id: true, code: true, label: true, appliesToType: true, isActive: true },
  });
}

/**
 * Put the default set on a tenant, skipping codes it already has.
 *
 * Idempotent so it is safe on every onboarding run, and so that when the
 * default list grows a later call fills in only the new ones rather than
 * failing on the (utilityId, code) unique.
 */
export async function seedDefaultReasons(
  utilityId: string,
  actorId: string,
  actorName: string,
): Promise<{ created: number }> {
  return prisma.$transaction(async (tx) => {
    const existing = new Set(
      (await tx.ledgerReasonDef.findMany({ where: { utilityId }, select: { code: true } })).map(
        (r) => r.code,
      ),
    );

    let created = 0;
    for (const def of DEFAULT_REASON_CODES) {
      if (existing.has(def.code)) continue;
      const row = await tx.ledgerReasonDef.create({
        data: {
          utilityId,
          code: def.code,
          label: def.label,
          appliesToType: def.appliesToType as never,
        },
      });
      await writeAuditRow(
        tx,
        { utilityId, actorId, actorName, entityType: "LedgerReasonDef" },
        EVENT_TYPES.LEDGER_REASON_CREATED,
        row.id,
        null,
        row,
      );
      created++;
    }
    return { created };
  });
}
