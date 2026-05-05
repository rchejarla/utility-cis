import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { VariableRegistry } from "./rate-engine-loaders/index.js";
import { AccountLoader } from "./rate-engine-loaders/loaders/account-loader.js";
import { MeterLoader } from "./rate-engine-loaders/loaders/meter-loader.js";
import { WqaLoader } from "./rate-engine-loaders/loaders/wqa-loader.js";
import { TenantLoader } from "./rate-engine-loaders/loaders/tenant-loader.js";
import { PremiseLoader } from "./rate-engine-loaders/loaders/premise-loader.js";
import { IndexLoader } from "./rate-engine-loaders/loaders/index-loader.js";
import { LinkedCommodityLoader } from "./rate-engine-loaders/loaders/linked-commodity-loader.js";
import { ItemsLoader } from "./rate-engine-loaders/loaders/items-loader.js";

/**
 * Slice 5a task 3 — single source of truth for assembling a `VariableRegistry`
 * stocked with all 8 v2 loaders. The Slice 4 e2e test wired this inline; the
 * bill service needs the same wiring per-bill, so we factor it out here.
 *
 * Each loader is constructed against a (prisma, utilityId, …) tuple. Some
 * loaders are SA-scoped (Account, Wqa, Items, LinkedCommodity), some are
 * meter/period-scoped (Meter), some are premise-scoped (Premise), some are
 * tenant-scoped only (Tenant, Index).
 */
export interface RegistryContext {
  utilityId: string;
  saId: string;
  accountId: string;
  premiseId: string;
  period: { startDate: Date; endDate: Date };
}

export function buildRegistry(prisma: PrismaClient, ctx: RegistryContext): VariableRegistry {
  const r = new VariableRegistry();
  r.register(new AccountLoader(prisma, ctx.utilityId, ctx.saId));
  r.register(new MeterLoader(prisma, ctx.utilityId, ctx.period));
  r.register(new WqaLoader(prisma, ctx.utilityId, ctx.saId));
  r.register(new TenantLoader(prisma, ctx.utilityId));
  r.register(new PremiseLoader(prisma, ctx.utilityId, ctx.premiseId));
  r.register(new IndexLoader(prisma, ctx.utilityId));
  r.register(
    new LinkedCommodityLoader(prisma, ctx.utilityId, ctx.period, {
      id: ctx.saId,
      accountId: ctx.accountId,
      premiseId: ctx.premiseId,
    }),
  );
  r.register(new ItemsLoader(prisma, ctx.utilityId, ctx.saId));
  return r;
}
