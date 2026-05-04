import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateAccountInput, UpdateAccountInput, AccountQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { generateNumber } from "../lib/number-generator.js";
import { validateCustomFields } from "./custom-field-schema.service.js";

export async function listAccounts(utilityId: string, query: AccountQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.status) where.status = query.status;
  if (query.accountType) where.accountType = query.accountType;
  if (query.creditRating) where.creditRating = query.creditRating;
  if (query.customerId) where.customerId = query.customerId;
  if (query.premiseSearch) {
    where.serviceAgreements = {
      some: {
        servicePoints: {
          some: {
            endDate: null,
            premise: {
              OR: [
                { addressLine1: { contains: query.premiseSearch, mode: "insensitive" } },
                { city: { contains: query.premiseSearch, mode: "insensitive" } },
              ],
            },
          },
        },
      },
    };
  }
  if (query.search) {
    // Search matches both the account number and any associated
    // premise's address — operators usually know one or the other,
    // not which field to search.
    where.OR = [
      { accountNumber: { contains: query.search, mode: "insensitive" } },
      {
        serviceAgreements: {
          some: {
            servicePoints: {
              some: {
                endDate: null,
                premise: {
                  OR: [
                    { addressLine1: { contains: query.search, mode: "insensitive" } },
                    { city: { contains: query.search, mode: "insensitive" } },
                  ],
                },
              },
            },
          },
        },
      },
    ];
  }

  // Hydrate customer + the first SA's premise address so the list
  // page can show "who" and "where" alongside the account number.
  // An account serves one premise (CLAUDE.md memory: "An account
  // serves one premise; don't UI it as 1→many"), so picking the
  // first SA's premise is the right derivation rather than listing
  // every SA's premise. We sort SAs by status ASC + startDate DESC
  // so the most-recent ACTIVE agreement wins; FINAL/CLOSED accounts
  // still get their last-known premise as a fallback.
  return paginatedTenantList(prisma.account, where, query, {
    include: {
      _count: { select: { serviceAgreements: true } },
      customer: {
        select: { id: true, customerType: true, firstName: true, lastName: true, organizationName: true },
      },
      serviceAgreements: {
        select: {
          servicePoints: {
            where: { endDate: null },
            select: {
              premise: { select: { id: true, addressLine1: true, city: true, state: true } },
            },
            orderBy: { startDate: "asc" },
            take: 1,
          },
        },
        orderBy: [{ status: "asc" }, { startDate: "desc" }],
        take: 1,
      },
    },
  });
}

export async function getAccount(id: string, utilityId: string) {
  return prisma.account.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      customer: {
        select: { id: true, customerType: true, firstName: true, lastName: true, organizationName: true, email: true, phone: true },
      },
      serviceAgreements: {
        include: {
          servicePoints: {
            where: { endDate: null },
            orderBy: { startDate: "asc" },
            include: { premise: true },
          },
          commodity: true,
        },
        orderBy: { startDate: "desc" },
      },
      contacts: { orderBy: { lastName: "asc" } },
      billingAddresses: true,
    },
  });
}

export async function createAccount(
  utilityId: string,
  actorId: string,
  actorName: string,
  data: CreateAccountInput
) {
  // Split custom fields off the payload — the core create() only
  // touches Prisma-modeled columns; customFields gets validated
  // against the tenant's custom_field_schema before being merged
  // into the jsonb column on the same row.
  const { customFields: rawCustom, ...core } = data;
  const validatedCustom = await validateCustomFields(
    utilityId,
    "account",
    rawCustom,
    { mode: "create" },
  );

  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_CREATED,
    async (tx) => {
      // Auto-generate account number from tenant template when absent.
      const accountNumber =
        core.accountNumber ??
        (await generateNumber({
          utilityId,
          entity: "account",
          defaultTemplate: "AC-{seq:5}",
          tableName: "account",
          columnName: "account_number",
          db: tx,
        }));
      return tx.account.create({
        data: {
          ...core,
          accountNumber,
          utilityId,
          customFields: validatedCustom as object,
        },
      });
    },
  );
}

export async function updateAccount(
  utilityId: string,
  actorId: string,
  actorName: string,
  id: string,
  data: UpdateAccountInput
) {
  const before = await prisma.account.findUniqueOrThrow({ where: { id, utilityId } });

  // Merge incoming custom fields against stored values so partial
  // updates don't clobber fields the caller didn't touch.
  const { customFields: rawCustom, ...core } = data;
  const existingStored = (before.customFields as Record<string, unknown>) ?? {};
  const mergedCustom =
    rawCustom === undefined
      ? existingStored
      : await validateCustomFields(utilityId, "account", rawCustom, {
          mode: "update",
          existingStored,
        });

  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_UPDATED,
    before,
    async (tx) => {
      if (core.status === "CLOSED") {
        const activeCount = await tx.serviceAgreement.count({
          where: {
            accountId: id,
            status: { in: ["PENDING", "ACTIVE"] },
          },
        });

        if (activeCount > 0) {
          throw Object.assign(
            new Error("Account has active or pending service agreements"),
            { statusCode: 400, code: "ACTIVE_AGREEMENTS_EXIST" }
          );
        }
      }

      return tx.account.update({
        where: { id, utilityId },
        data: { ...core, customFields: mergedCustom as object },
      });
    },
  );
}
