import { prisma } from "../lib/prisma.js";
import { domainEvents } from "../events/emitter.js";
import { EVENT_TYPES } from "@utility-cis/shared";
import type { CreateAccountInput, UpdateAccountInput, AccountQuery } from "@utility-cis/shared";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

export async function listAccounts(utilityId: string, query: AccountQuery) {
  const where: Record<string, unknown> = { utilityId };

  if (query.status) where.status = query.status;
  if (query.accountType) where.accountType = query.accountType;
  if (query.search) {
    where.accountNumber = { contains: query.search, mode: "insensitive" };
  }

  const [data, total] = await Promise.all([
    prisma.account.findMany({
      where,
      ...paginationArgs(query),
      include: {
        _count: {
          select: {
            serviceAgreements: true,
          },
        },
      },
    }),
    prisma.account.count({ where }),
  ]);

  return paginatedResponse(data, total, query);
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
  data: CreateAccountInput
) {
  const account = await prisma.account.create({
    data: { ...data, utilityId },
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.ACCOUNT_CREATED,
    entityType: "Account",
    entityId: account.id,
    utilityId,
    actorId,
    beforeState: null,
    afterState: account as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return account;
}

export async function updateAccount(
  utilityId: string,
  actorId: string,
  id: string,
  data: UpdateAccountInput
) {
  const before = await prisma.account.findUniqueOrThrow({ where: { id, utilityId } });

  const account = await prisma.$transaction(async (tx) => {
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

    return tx.account.update({
      where: { id, utilityId },
      data,
    });
  });

  domainEvents.emitDomainEvent({
    type: EVENT_TYPES.ACCOUNT_UPDATED,
    entityType: "Account",
    entityId: account.id,
    utilityId,
    actorId,
    beforeState: before as unknown as Record<string, unknown>,
    afterState: account as unknown as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  });

  return account;
}
