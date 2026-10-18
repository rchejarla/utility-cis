import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateContactInput, UpdateContactInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";

export async function listContacts(utilityId: string, accountId: string) {
  return prisma.contact.findMany({
    where: { utilityId, accountId },
    include: {
      customer: true,
    },
    orderBy: { lastName: "asc" },
  });
}

export async function createContact(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateContactInput
) {
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Contact" },
    EVENT_TYPES.CONTACT_CREATED,
    (tx) => tx.contact.create({ data: { ...data, utilityId } })
  );
}

export async function updateContact(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateContactInput
) {
  const before = await prisma.contact.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Contact" },
    EVENT_TYPES.CONTACT_UPDATED,
    before,
    (tx) => tx.contact.update({ where: { id, utilityId }, data })
  );
}

/**
 * Deleting a contact is the one change where the audit row is the only
 * surviving evidence, since the row it describes is gone afterwards.
 * This wrote none at all — it took `_actorId` and discarded it — so a
 * contact could be removed leaving nothing behind.
 *
 * Same shape as `deleteBillMessage`: read the prior state, then delete
 * and record in one transaction so the two cannot diverge. `afterState`
 * is null, because a deleted row is not in any state.
 */
export async function deleteContact(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string
) {
  const before = await prisma.contact.findFirstOrThrow({ where: { id, utilityId } });
  await prisma.$transaction(async (tx) => {
    await tx.contact.delete({ where: { id } });
    await writeAuditRow(
      tx,
      { utilityId, actorId, actorName, entityType: "Contact" },
      EVENT_TYPES.CONTACT_DELETED,
      id,
      before,
      null
    );
  });
}
