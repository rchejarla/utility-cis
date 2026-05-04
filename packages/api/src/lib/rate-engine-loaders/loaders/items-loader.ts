import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { z } from "zod";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

const KEY_PREFIX = "items:";

/**
 * Slice 4 task 6 — solid-waste items / containers loader.
 *
 * Capability:
 *   - `items:<sp_id>:<item_type>` → Container[]
 *
 * Use case: Bozeman solid waste rate components iterate over the
 * containers attached to the SA, partitioned by `item_type` (e.g.
 * `garbage_cart`, `recycling_cart`, `organics_cart`). Each component
 * runs its own item-type query.
 *
 * The loader fetches the SA's active containers in a single query and
 * filters per requested key in memory — multi-key loads share that
 * one DB hit. The `<sp_id>` segment is currently unused: containers
 * are pinned to the SA, not to a specific service point. We accept it
 * in the key for forward-compat (e.g. multi-SP solid-waste setups).
 */
export class ItemsLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private saId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "items:<sp_id>:<item_type>",
        paramTypes: { sp_id: z.string(), item_type: z.string() },
        scope: "per_sa",
        returns: z.array(z.unknown()),
        description:
          "Active containers attached to the SA, filtered by item_type (e.g. garbage_cart, recycling_cart, organics_cart)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const itemKeys = keys.filter((k) => k.startsWith(KEY_PREFIX));
    if (itemKeys.length === 0) return out;

    // Single query for the SA's containers; we filter per-key below so
    // a multi-component rate run shares one DB hit.
    const containers = await this.prisma.container.findMany({
      where: {
        utilityId: this.utilityId,
        serviceAgreementId: this.saId,
        status: "ACTIVE",
      },
      select: {
        id: true,
        size: true,
        frequency: true,
        itemType: true,
        sizeGallons: true,
        quantity: true,
        containerType: true,
      },
    });

    for (const key of itemKeys) {
      const parts = key.split(":");
      if (parts.length < 3) {
        throw new Error(
          `Malformed items:* key '${key}' — expected 'items:<sp_id>:<item_type>'`,
        );
      }
      const itemType = parts.slice(2).join(":");
      const filtered = containers
        .filter((c) => c.itemType === itemType)
        .map((c) => ({
          id: c.id,
          size: c.size,
          frequency: c.frequency,
          itemType: c.itemType,
          sizeGallons: c.sizeGallons,
          quantity: c.quantity,
          containerType: c.containerType,
        }));
      out.set(key, filtered);
    }

    return out;
  }
}
