import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { z } from "zod";
import { Decimal, ZERO } from "../../rate-engine/decimal.js";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

interface SaContext {
  id: string;
  accountId: string;
  premiseId: string;
}

const KEY_PREFIX = "linked:";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Slice 4 task 6 — cross-commodity reference loader.
 *
 * Capability:
 *   - `linked:<commodity_id_or_code>:current_period` → Decimal
 *
 * Use case: Bozeman commercial sewer is `derived_consumption` with
 * `quantitySource.base = "linked_commodity"` — sewer is billed off the
 * water customer's own consumption. The loader finds the sibling SA
 * on the same account+premise carrying the requested commodity and
 * sums its meter reads in the period.
 *
 * The commodity selector accepts either a UUID or a code (e.g.
 * "WATER") so configurators can stay readable. Throws on zero or >1
 * sibling — the rate model assumes a single sibling per commodity per
 * (account, premise) and an ambiguous match is a configuration bug,
 * not something to silently aggregate.
 *
 * SA → premise is reached through ServicePoint (SA has no direct
 * premise FK) — we filter siblings by `servicePoints.some.premiseId`.
 */
export class LinkedCommodityLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private period: { startDate: Date; endDate: Date },
    private sa: SaContext,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "linked:<commodity_id>:current_period",
        paramTypes: { commodity_id: z.string() },
        scope: "per_sa",
        returns: z.unknown(),
        description:
          "Aggregated meter consumption from a sibling SA on the same account+premise for a specific commodity (id or code) over the current period",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    for (const key of keys) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const rest = key.slice(KEY_PREFIX.length);
      // rest = "<commodity>:current_period"
      const colon = rest.lastIndexOf(":");
      if (colon < 0) {
        throw new Error(`Malformed linked:* key '${key}' — expected 'linked:<commodity>:current_period'`);
      }
      const commoditySel = rest.slice(0, colon);
      const window = rest.slice(colon + 1);
      if (window !== "current_period") {
        throw new Error(`Unsupported window '${window}' on linked:* key '${key}'`);
      }

      const isUuid = UUID_RE.test(commoditySel);

      const siblings = await this.prisma.serviceAgreement.findMany({
        where: {
          utilityId: this.utilityId,
          accountId: this.sa.accountId,
          id: { not: this.sa.id },
          status: { in: ["ACTIVE", "PENDING"] },
          commodity: isUuid
            ? { id: commoditySel }
            : { code: commoditySel },
          servicePoints: {
            some: {
              utilityId: this.utilityId,
              premiseId: this.sa.premiseId,
            },
          },
        },
        select: { id: true },
      });

      if (siblings.length === 0) {
        throw new Error(
          `No sibling SA on same account+premise for commodity '${commoditySel}' (linked:* lookup)`,
        );
      }
      if (siblings.length > 1) {
        throw new Error(
          `Multiple sibling SAs (${siblings.length}) for commodity '${commoditySel}' on the same account+premise — expected exactly one`,
        );
      }

      const siblingSaId = siblings[0]!.id;

      const reads = await this.prisma.meterRead.findMany({
        where: {
          utilityId: this.utilityId,
          serviceAgreementId: siblingSaId,
          readDate: { gte: this.period.startDate, lte: this.period.endDate },
        },
        select: { consumption: true },
      });

      const total = reads.reduce<Decimal>(
        (acc, r) => acc.plus(new Decimal(r.consumption.toString())),
        ZERO,
      );

      out.set(key, total);
    }

    return out;
  }
}
