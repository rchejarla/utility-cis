import { prisma } from "../lib/prisma.js";
import type {
  CreateRateIndexInput,
  UpdateRateIndexInput,
  RateIndexQuery,
} from "@utility-cis/shared";

/**
 * Slice 1 task 7 — RateIndex CRUD service.
 *
 * Indexes are tenant data. The engine (slice 3) resolves
 * `pricing.type = "indexed"` references by (utility, name, period) at
 * evaluation time. Tenant scope is carried explicitly into every query
 * as belt-and-suspenders alongside the RLS policy.
 */

export async function listRateIndices(utilityId: string, query: RateIndexQuery) {
  const where: Record<string, unknown> = { utilityId };
  if (query.name) where.name = query.name;
  if (query.period) where.period = query.period;
  return prisma.rateIndex.findMany({
    where,
    orderBy: [{ name: "asc" }, { effectiveDate: "desc" }],
  });
}

export async function getRateIndex(id: string, utilityId: string) {
  return prisma.rateIndex.findUniqueOrThrow({
    where: { id, utilityId },
  });
}

export async function createRateIndex(utilityId: string, data: CreateRateIndexInput) {
  return prisma.rateIndex.create({
    data: {
      utilityId,
      name: data.name,
      period: data.period,
      value: data.value,
      effectiveDate: new Date(data.effectiveDate),
      expirationDate: data.expirationDate ? new Date(data.expirationDate) : null,
      description: data.description,
    },
  });
}

export async function updateRateIndex(
  utilityId: string,
  id: string,
  data: UpdateRateIndexInput,
) {
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.period !== undefined) updateData.period = data.period;
  if (data.value !== undefined) updateData.value = data.value;
  if (data.effectiveDate !== undefined) updateData.effectiveDate = new Date(data.effectiveDate);
  if (data.expirationDate !== undefined) {
    updateData.expirationDate = data.expirationDate ? new Date(data.expirationDate) : null;
  }
  if (data.description !== undefined) updateData.description = data.description;

  return prisma.rateIndex.update({
    where: { id, utilityId },
    data: updateData,
  });
}

export async function deleteRateIndex(utilityId: string, id: string) {
  return prisma.rateIndex.delete({
    where: { id, utilityId },
  });
}
