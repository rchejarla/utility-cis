import { prisma } from "../lib/prisma.js";
import { auditCreate, auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";
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
const auditCtx = (utilityId: string, actorId: string, actorName: string) => ({
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

/**
 * Confirm the rows a message points at are ones this tenant may target.
 *
 * `accountTypeDefId` and `commodityId` arrive from the client and were
 * written straight through. PostgreSQL enforces referential integrity
 * with triggers that bypass RLS, so the FK accepted another tenant's id
 * happily. Nothing could come of it at print time — `selectBillMessages`
 * filters on the bill's own commodities, so a foreign id matches
 * nothing — but a tenant should not be able to store a reference to
 * another tenant's row, nor to learn that one exists by whether the
 * write succeeds.
 *
 * **An account type may be global.** `account_type_def` ships five rows
 * with `utility_id = NULL` — Residential, Commercial, Industrial,
 * Municipal, Government — which every tenant sees and none owns; a
 * tenant adds its own row only to rename or extend that set. Demanding
 * ownership here therefore refused every account type that exists:
 * Settings → Bill Messages offered five options from `listAccountTypes`
 * and answered 404 to all five, so targeting a message by account type
 * had never once worked, while Req 137 was recorded as shipped. The
 * check is "may this tenant target it", not "does this tenant own it",
 * and the two differ exactly where a global default is involved.
 *
 * Commodities are tenant-owned with no global set, so ownership is the
 * right test there and stays.
 */
async function assertTargetsVisibleToTenant(
  utilityId: string,
  data: { accountTypeDefId?: string | null; commodityId?: string | null },
): Promise<void> {
  if (data.accountTypeDefId) {
    await prisma.accountTypeDef.findFirstOrThrow({
      where: {
        id: data.accountTypeDefId,
        OR: [{ utilityId }, { utilityId: null }],
      },
      select: { id: true },
    });
  }
  if (data.commodityId) {
    await prisma.commodity.findFirstOrThrow({
      where: { id: data.commodityId, utilityId },
      select: { id: true },
    });
  }
}

export async function createBillMessage(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: BillMessageCreate,
) {
  await assertTargetsVisibleToTenant(utilityId, data);
  return auditCreate(auditCtx(utilityId, actorId, actorName), EVENT_TYPES.BILL_MESSAGE_CREATED, (tx) =>
    tx.billMessage.create({ data: { ...data, utilityId } }),
  );
}

export async function updateBillMessage(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: BillMessageUpdate,
) {
  const before = await prisma.billMessage.findFirstOrThrow({ where: { id, utilityId } });
  await assertTargetsVisibleToTenant(utilityId, data);
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
  actorName: string,
  id: string,
) {
  const before = await prisma.billMessage.findFirstOrThrow({ where: { id, utilityId } });
  await prisma.$transaction(async (tx) => {
    await tx.billMessage.delete({ where: { id } });
    // afterState is null, because a deleted row is not in any state.
    // This went through auditUpdate, whose signature wants an entity
    // back so it can read an id off it, so the only thing it could
    // return was `{ id }` — and the audit row then claimed that was
    // what the row now looked like. writeAuditRow takes the id
    // directly, which is all that was ever needed.
    await writeAuditRow(
      tx,
      auditCtx(utilityId, actorId, actorName),
      EVENT_TYPES.BILL_MESSAGE_DELETED,
      id,
      before,
      null,
    );
  });
}
