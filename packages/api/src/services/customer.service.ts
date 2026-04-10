import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCustomerInput, UpdateCustomerInput, CustomerQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";

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

  return paginatedTenantList(prisma.customer, where, query, {
    include: { _count: { select: { accounts: true } } },
  });
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
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Customer" },
    EVENT_TYPES.CUSTOMER_CREATED,
    () => prisma.customer.create({ data: { ...data, utilityId } })
  );
}

export async function updateCustomer(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateCustomerInput
) {
  const before = await prisma.customer.findUniqueOrThrow({ where: { id, utilityId } });
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Customer" },
    EVENT_TYPES.CUSTOMER_UPDATED,
    before,
    () => prisma.customer.update({ where: { id, utilityId }, data })
  );
}
