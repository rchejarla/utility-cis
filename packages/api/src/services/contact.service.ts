import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateContactInput, UpdateContactInput } from "@utility-cis/shared";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

export async function listContacts(utilityId: string, accountId: string) {
  return prisma.contact.findMany({
    where: { utilityId, accountId },
    include: {
      customer: true,
    },
    orderBy: { isPrimary: "desc" },
  });
}

export async function createContact(
  utilityId: string,
  actorId: string,
  data: CreateContactInput
) {
  return auditCreate(
    { utilityId, actorId, entityType: "Contact" },
    EVENT_TYPES.CONTACT_CREATED,
    () => prisma.contact.create({ data: { ...data, utilityId } })
  );
}

export async function updateContact(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateContactInput
) {
  const before = await prisma.contact.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, entityType: "Contact" },
    EVENT_TYPES.CONTACT_UPDATED,
    before,
    () => prisma.contact.update({ where: { id, utilityId }, data })
  );
}

export async function deleteContact(
  utilityId: string,
  _actorId: string,
  id: string
) {
  return prisma.contact.delete({
    where: { id, utilityId },
  });
}
