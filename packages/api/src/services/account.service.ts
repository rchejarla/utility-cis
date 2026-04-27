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
  if (query.search) {
    where.accountNumber = { contains: query.search, mode: "insensitive" };
  }

  return paginatedTenantList(prisma.account, where, query, {
    include: { _count: { select: { serviceAgreements: true } } },
  });
}

export async function getAccount(id: string, utilityId: string) {
  return prisma.account.findUniqueOrThrow({
    where: { id, utilityId },
    include: {
      serviceAgreements: {
        include: {
          premise: true,
          commodity: true,
          rateSchedule: true,
        },
        orderBy: { startDate: "desc" },
      },
      contacts: { orderBy: { isPrimary: "desc" } },
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
