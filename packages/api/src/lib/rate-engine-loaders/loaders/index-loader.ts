import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { Decimal } from "../../rate-engine/decimal.js";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Slice 4 task 4 — index-backed pricing loader.
 *
 * Capability:
 *   - `index:<index_name>:<period>`  → Decimal | <absent>
 *
 * Backs `pricing.type = "indexed"` components. Each variable key resolves
 * to one (utility_id, name, period) row of `rate_index`. Missing rows
 * are intentionally LEFT OUT of the result map — the engine treats an
 * absent index value as a hard miss and surfaces the variable name in
 * its error trace, which is more useful than silently substituting 0.
 *
 * Multiple keys batch into one OR query: `(name=A AND period=X) OR
 * (name=B AND period=Y) ...`. Cheap at our row counts.
 */
const KEY_PREFIX = "index:";

export class IndexLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "index:<index_name>:<period>",
        paramTypes: { index_name: z.string(), period: z.string() },
        scope: "global",
        // Decimal doesn't have a canonical Zod schema in this codebase
        // — the rate-engine treats it as opaque. Leave as `unknown`
        // and rely on the loader contract for shape.
        returns: z.unknown(),
        description: "External rate index value (FAC, EPCC, supply quarterlies, drought_reserve_rate, ...)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const parsed: Array<{ key: VariableKey; name: string; period: string }> = [];
    for (const k of keys) {
      if (!k.startsWith(KEY_PREFIX)) continue;
      const parts = k.split(":");
      // parts = ["index", name, period]; ignore malformed keys (the
      // registry validates pattern shape, but defend anyway).
      if (parts.length !== 3) continue;
      parsed.push({ key: k, name: parts[1], period: parts[2] });
    }

    if (parsed.length === 0) return out;

    const rows = await this.prisma.rateIndex.findMany({
      where: {
        utilityId: this.utilityId,
        OR: parsed.map((p) => ({ name: p.name, period: p.period })),
      },
      select: { name: true, period: true, value: true },
    });

    const byKey = new Map(rows.map((r) => [`${r.name}:${r.period}`, r.value]));

    for (const p of parsed) {
      const v = byKey.get(`${p.name}:${p.period}`);
      if (v !== undefined) {
        // Prisma's Decimal type stringifies cleanly; route through
        // decimal.js so the engine works against a single Decimal
        // implementation everywhere.
        out.set(p.key, new Decimal(v.toString()));
      }
      // Missing rows: deliberately do not set the key. See class doc.
    }

    return out;
  }
}
