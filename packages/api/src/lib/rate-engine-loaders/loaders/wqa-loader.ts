import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { Decimal } from "../../rate-engine/decimal.js";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Slice 4 task 5 — WqaLoader.
 *
 * Backs the Bozeman sewer Residential / Multi-Family rate classes,
 * which charge based on a Winter Quarter Average (WQA) of metered
 * water consumption rather than current-period reads. The WqaValue
 * row is computed once per water year by the seasonal rollup; staff
 * may apply an override (e.g. correcting a pipe-leak month). At
 * rating time the engine reads:
 *
 *   - `wqa:current:<sa_id>`   override_value when set, else computed_avg
 *   - `wqa:override:<sa_id>`  override_value or null
 *
 * Construction follows the AccountLoader convention: bind to a single
 * (utilityId, saId) at rating-call time. The `<sa_id>` token in the
 * key pattern is informational — we use the SA bound at construction
 * rather than parsing it out of every key.
 *
 * Latest-waterYear semantics: a single SA can accumulate multiple
 * historical WqaValue rows. The current-period rating run wants the
 * most recent year, so we order by water_year DESC and take one row.
 */
export class WqaLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private saId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "wqa:current:<sa_id>",
        paramTypes: { sa_id: z.string().uuid() },
        scope: "per_sa",
        returns: z.unknown(), // Decimal
        description:
          "Currently active WQA value for the SA — override_value when set, else computed_avg",
      },
      {
        pattern: "wqa:override:<sa_id>",
        paramTypes: { sa_id: z.string().uuid() },
        scope: "per_sa",
        returns: z.unknown(), // Decimal | null
        description: "Override-only WQA value (null when no override is set)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const needsCurrent = keys.some((k) => k.startsWith("wqa:current:"));
    const needsOverride = keys.some((k) => k.startsWith("wqa:override:"));

    if (!needsCurrent && !needsOverride) return out;

    // Single batched fetch — both keys read from the same row, and
    // the loader is bound to one SA. Latest waterYear wins.
    const row = await this.prisma.wqaValue.findFirst({
      where: { utilityId: this.utilityId, serviceAgreementId: this.saId },
      orderBy: { waterYear: "desc" },
    });

    if (!row) {
      // No WQA stored for this SA yet. Engine cannot price `current`
      // without one — surface as an error. `override` is allowed to
      // be null (the "no override exists" case), so emit null.
      for (const k of keys) {
        if (k.startsWith("wqa:current:")) {
          throw new Error(
            `No WqaValue stored for SA ${this.saId} — required for ${k}`,
          );
        }
        if (k.startsWith("wqa:override:")) {
          out.set(k, null);
        }
      }
      return out;
    }

    // Decimal columns come back as Prisma Decimal instances; convert
    // to the rate-engine's decimal.js Decimal via toString to keep
    // arithmetic types consistent across loaders.
    const current = row.overrideValue ?? row.computedAvg;
    for (const k of keys) {
      if (k.startsWith("wqa:current:")) {
        out.set(k, new Decimal(current.toString()));
      } else if (k.startsWith("wqa:override:")) {
        out.set(
          k,
          row.overrideValue ? new Decimal(row.overrideValue.toString()) : null,
        );
      }
    }

    return out;
  }
}
