import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateCustomerInput, UpdateCustomerInput, CustomerQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { validateCustomFields } from "./custom-field-schema.service.js";

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
  // Split custom fields off the payload — the core create() only
  // touches Prisma-modeled columns, and customFields gets validated
  // against the tenant's custom_field_schema before being merged into
  // the jsonb column on the same row.
  const { customFields: rawCustom, ...core } = data;
  const validatedCustom = await validateCustomFields(
    utilityId,
    "customer",
    rawCustom,
    { mode: "create" },
  );

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Customer" },
    EVENT_TYPES.CUSTOMER_CREATED,
    () =>
      prisma.customer.create({
        data: {
          ...core,
          utilityId,
          customFields: validatedCustom as object,
        },
      }),
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

  // Merge the incoming patch against the existing stored custom
  // fields so a partial update doesn't clobber fields the caller
  // didn't touch. validateCustomFields handles both the merge and
  // the re-validation against the tenant schema.
  const { customFields: rawCustom, ...core } = data;
  const existingStored = (before.customFields as Record<string, unknown>) ?? {};
  const mergedCustom =
    rawCustom === undefined
      ? existingStored
      : await validateCustomFields(utilityId, "customer", rawCustom, {
          mode: "update",
          existingStored,
        });

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Customer" },
    EVENT_TYPES.CUSTOMER_UPDATED,
    before,
    () =>
      prisma.customer.update({
        where: { id, utilityId },
        data: { ...core, customFields: mergedCustom as object },
      }),
  );
}
