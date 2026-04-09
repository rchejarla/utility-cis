import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateContactInput, UpdateContactInput } from "@utility-cis/shared";

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
  const contact = await prisma.contact.create({
    data: { ...data, utilityId },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.CONTACT_CREATED,
    entityType: "Contact",
    entityId: contact.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: contact as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return contact;
}

export async function updateContact(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateContactInput
) {
  const before = await prisma.contact.findUniqueOrThrow({ where: { id, utilityId } });

  const contact = await prisma.contact.update({
    where: { id, utilityId },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.CONTACT_UPDATED,
    entityType: "Contact",
    entityId: contact.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: contact as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return contact;
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
