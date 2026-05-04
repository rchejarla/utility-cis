import { prisma } from "../lib/prisma.js";
import type {
  CreateRateServiceClassInput,
  UpdateRateServiceClassInput,
  RateServiceClassQuery,
} from "@utility-cis/shared";

/**
 * Per-tenant, per-commodity customer service class — Single Family,
 * Multi-Family, MSU, Commercial, etc. Distinct from premise type
 * (physical) — this is the billing classification used by the rate
 * engine to select which rate components apply.
 *
 * No globals: every row has a populated utility_id. RLS enforces
 * tenant isolation at the DB level; the where-clause `utilityId` here
 * is belt-and-suspenders so a misconfigured request that bypasses RLS
 * still can't read across tenants.
 */

const commoditySelect = { id: true, name: true, code: true } as const;

export async function listRateServiceClasses(
  utilityId: string,
  query: RateServiceClassQuery,
) {
  return prisma.rateServiceClass.findMany({
    where: {
      utilityId,
      ...(query.commodityId ? { commodityId: query.commodityId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    },
    orderBy: [{ commodityId: "asc" }, { sortOrder: "asc" }],
    include: { commodity: { select: commoditySelect } },
  });
}

export async function getRateServiceClass(id: string, utilityId: string) {
  return prisma.rateServiceClass.findUniqueOrThrow({
    where: { id, utilityId },
    include: { commodity: { select: commoditySelect } },
  });
}

export async function createRateServiceClass(
  utilityId: string,
  data: CreateRateServiceClassInput,
) {
  return prisma.rateServiceClass.create({
    data: { ...data, utilityId },
    include: { commodity: { select: commoditySelect } },
  });
}

export async function updateRateServiceClass(
  utilityId: string,
  id: string,
  data: UpdateRateServiceClassInput,
) {
  return prisma.rateServiceClass.update({
    where: { id, utilityId },
    data,
    include: { commodity: { select: commoditySelect } },
  });
}

export async function softDeleteRateServiceClass(utilityId: string, id: string) {
  return prisma.rateServiceClass.update({
    where: { id, utilityId },
    data: { isActive: false },
  });
}
