import { prisma } from "../lib/prisma.js";
import type { CreateBillingAddressInput, UpdateBillingAddressInput } from "@utility-cis/shared";

export async function listBillingAddresses(utilityId: string, accountId: string) {
  return prisma.billingAddress.findMany({
    where: { utilityId, accountId },
  });
}

export async function createBillingAddress(
  utilityId: string,
  _actorId: string,
  data: CreateBillingAddressInput
) {
  return prisma.billingAddress.create({
    data: { ...data, utilityId },
  });
}

export async function updateBillingAddress(
  utilityId: string,
  _actorId: string,
  id: string,
  data: UpdateBillingAddressInput
) {
  return prisma.billingAddress.update({
    where: { id, utilityId },
    data,
  });
}
