import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCustomerInput, UpdateCustomerInput, CustomerQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

export async function listCustomers(utilityId: string, query: CustomerQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.customerType) where.customerType = query.customerType;
  if (query.status) where.status = query.status;
  if (query.search) {
    where.OR = [
      { firstName: { contains: query.search, mode: "insensitive" } },
      { lastName: { contains: query.search, mode: "insensitive" } },
      { organizationName: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      ...paginationArgs(query),
      include: {
        _count: {
          select: {
            accounts: true,
          },
        },
      },
    }),
    prisma.customer.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
}

export async function getCustomer(id: string, utilityId: string) {
  return prisma.customer.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      accounts: {
        include: {
          _count: {
            select: {
              serviceAgreements: true,
            },
          },
        },
      },
      contacts: true,
      ownedPremises: true,
    },
  });
}

export async function createCustomer(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateCustomerInput
) {
  const customer = await prisma.customer.create({
    data: { ...data, utilityId },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.CUSTOMER_CREATED,
    entityType: "Customer",
    entityId: customer.id,
    utilityId,
    actorId,
    actorName,
    beforeState: null,
    afterState: customer as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return customer;
}

export async function updateCustomer(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateCustomerInput
) {
  const before = await prisma.customer.findUniqueOrThrow({ where: { id, utilityId } });

  const customer = await prisma.customer.update({
    where: { id, utilityId },
    data,
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.CUSTOMER_UPDATED,
    entityType: "Customer",
    entityId: customer.id,
    utilityId,
    actorId,
    actorName,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: customer as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return customer;
}
