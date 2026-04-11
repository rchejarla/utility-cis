import { prisma } from "../lib/prisma.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateAccountInput, UpdateAccountInput, AccountQuery } from "@utility-cis/shared";
import { paginatedTenantList } from "../lib/pagination.js";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { generateNumber } from "../lib/number-generator.js";

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
  return auditCreate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_CREATED,
    () => prisma.$transaction(async (tx) => {
      // Auto-generate account number from tenant template when absent.
      const accountNumber =
        data.accountNumber ??
        (await generateNumber({
          utilityId,
          entity: "account",
          defaultTemplate: "AC-{seq:5}",
          tableName: "account",
          columnName: "account_number",
          db: tx,
        }));
      return tx.account.create({
        data: { ...data, accountNumber, utilityId },
      });
    })
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
  return auditUpdate(
    { utilityId, actorId, actorName, entityType: "Account" },
    EVENT_TYPES.ACCOUNT_UPDATED,
    before,
    () =>
      prisma.$transaction(async (tx) => {
        if (data.status === "CLOSED") {
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

        return tx.account.update({ where: { id, utilityId }, data });
      })
  );
}
