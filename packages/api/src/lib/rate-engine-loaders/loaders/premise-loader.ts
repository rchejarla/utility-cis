import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { Decimal } from "../../rate-engine/decimal.js";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Slice 4 task 4 — premise-attribute loader.
 *
 * Capability:
 *   - `premise:attr:<attr_name>`  → Decimal | number | string | boolean | null
 *
 * Maps a small set of premise attributes onto first-class Premise
 * columns. Anything outside that map resolves to `null` rather than
 * throwing — a configurator referencing an unknown attribute is a
 * stale-config issue the engine should report by name, not crash on.
 *
 * Construction binds to one `premiseId` per loader instance — same
 * lifecycle pattern as AccountLoader/MeterLoader. The single-row
 * fetch dynamically narrows `select` to just the columns the keys
 * need, so unrelated columns aren't pulled into memory.
 */
const KEY_PREFIX = "premise:attr:";

const ATTR_TO_COLUMN: Record<string, string> = {
  eru_count: "eruCount",
  impervious_sqft: "impervioussSqft", // matches schema's typoed column name
  has_stormwater_infra: "hasStormwaterInfra",
  premise_type: "premiseType",
  city: "city",
  state: "state",
  zip: "zip",
};

const DECIMAL_COLUMNS = new Set<string>(["eruCount"]);

export class PremiseLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private premiseId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "premise:attr:<attr_name>",
        paramTypes: { attr_name: z.string() },
        scope: "per_sa",
        returns: z.unknown(),
        description:
          "Premise attribute (eru_count, impervious_sqft, has_stormwater_infra, premise_type, city, state, zip)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const attrs = keys
      .filter((k) => k.startsWith(KEY_PREFIX))
      .map((k) => k.slice(KEY_PREFIX.length));
    if (attrs.length === 0) return out;

    // Build a narrowed `select` from the union of known attrs requested.
    // Unknown attrs don't contribute a column — they short-circuit to
    // null below.
    const select: Record<string, true> = {};
    for (const attr of attrs) {
      const col = ATTR_TO_COLUMN[attr];
      if (col) select[col] = true;
    }

    // If every requested attr is unknown, we still want predictable
    // null mappings without an unnecessary DB hit.
    let premise: Record<string, unknown> | null = null;
    if (Object.keys(select).length > 0) {
      premise = (await this.prisma.premise.findUniqueOrThrow({
        where: { id: this.premiseId, utilityId: this.utilityId },
        select: select as never,
      })) as Record<string, unknown>;
    }

    for (const attr of attrs) {
      const key: VariableKey = `${KEY_PREFIX}${attr}`;
      const col = ATTR_TO_COLUMN[attr];
      if (!col) {
        out.set(key, null);
        continue;
      }
      let value = premise?.[col];
      if (value !== null && value !== undefined && DECIMAL_COLUMNS.has(col)) {
        // Prisma returns Decimal for @db.Decimal columns; route through
        // decimal.js so callers get a single Decimal implementation.
        value = new Decimal((value as { toString(): string }).toString());
      }
      out.set(key, value ?? null);
    }

    return out;
  }
}
