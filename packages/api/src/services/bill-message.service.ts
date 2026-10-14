import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { EVENT_TYPES, type BillMessageCreate, type BillMessageUpdate } from "@utility-cis/shared";

/**
 * Bill messages — the configurable text a tenant prints on bills
 * (Bozeman #137).
 *
 * Targeting is deliberately two independent nullable dimensions rather
 * than a rule expression: a message aimed at an account type, at a
 * service, at both, or at neither. Null means "all" on each side, so
 * the query is an OR of "untargeted" with "targeted at this bill" per
 * dimension.
 */

export interface BillMessageRow {
  id: string;
  label: string;
  body: string;
  priority: number;
}

export interface BillMessageSelector {
  accountTypeDefId: string | null;
  /** Every commodity billed on this bill. Empty is legitimate. */
  commodityIds: string[];
  /**
   * The bill's own billDate. Never `now()` — a reprint has to reproduce
   * the messages the bill carried when it was issued, not the ones
   * active today.
   */
  onDate: Date;
}

/**
 * The messages that belong on one bill, in print order.
 *
 * Ordered by priority then label: priority is the operator's intent,
 * and label breaks ties so two messages at the same priority do not
 * swap places between renders of the same bill.
 */
export async function selectBillMessages(
  utilityId: string,
  opts: BillMessageSelector,
): Promise<BillMessageRow[]> {
  const accountTypeClause: Array<Record<string, unknown>> = [{ accountTypeDefId: null }];
  if (opts.accountTypeDefId) {
    accountTypeClause.push({ accountTypeDefId: opts.accountTypeDefId });
  }

  const commodityClause: Array<Record<string, unknown>> = [{ commodityId: null }];
  if (opts.commodityIds.length > 0) {
    commodityClause.push({ commodityId: { in: opts.commodityIds } });
  }

  return prisma.billMessage.findMany({
    where: {
      utilityId,
      activeFrom: { lte: opts.onDate },
      OR: [{ activeTo: null }, { activeTo: { gte: opts.onDate } }],
      AND: [{ OR: accountTypeClause }, { OR: commodityClause }],
    },
    orderBy: [{ priority: "asc" }, { label: "asc" }],
    select: { id: true, label: true, body: true, priority: true },
  });
}

// ─── CRUD ─────────────────────────────────────────────────────────────
// Audited through the same wrappers every other tenant catalogue uses,
// so a change to the text printed on customers' bills is attributable.

const ENTITY_TYPE = "BillMessage";
const auditCtx = (utilityId: string, actorId: string, actorName?: string) => ({
  utilityId,
  actorId,
  actorName,
  entityType: ENTITY_TYPE,
});

export async function listBillMessages(utilityId: string) {
  return prisma.billMessage.findMany({
    where: { utilityId },
    orderBy: [{ priority: "asc" }, { label: "asc" }],
  });
}

export async function createBillMessage(
  utilityId: string,
  actorId: string,
  actorName: string | undefined,
  data: BillMessageCreate,
) {
  return auditCreate(auditCtx(utilityId, actorId, actorName), EVENT_TYPES.BILL_MESSAGE_CREATED, (tx) =>
    tx.billMessage.create({ data: { ...data, utilityId } }),
  );
}

export async function updateBillMessage(
  utilityId: string,
  actorId: string,
  actorName: string | undefined,
  id: string,
  data: BillMessageUpdate,
) {
  const before = await prisma.billMessage.findFirstOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    auditCtx(utilityId, actorId, actorName),
    EVENT_TYPES.BILL_MESSAGE_UPDATED,
    before,
    (tx) => tx.billMessage.update({ where: { id }, data }),
  );
}

export async function deleteBillMessage(
  utilityId: string,
  actorId: string,
  actorName: string | undefined,
  id: string,
) {
  const before = await prisma.billMessage.findFirstOrThrow({ where: { id, utilityId } });
  await auditUpdate(
    auditCtx(utilityId, actorId, actorName),
    EVENT_TYPES.BILL_MESSAGE_DELETED,
    before,
    async (tx) => {
      await tx.billMessage.delete({ where: { id } });
      return { id };
    },
  );
}
