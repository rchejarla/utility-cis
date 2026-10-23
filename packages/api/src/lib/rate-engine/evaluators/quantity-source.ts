import { Decimal, ZERO, ONE, toDecimal } from "../decimal.js";
import type { RatingContext } from "../types.js";
import { UnsupportedInSlice3Error } from "../types.js";
import { daysIn } from "../period.js";
import { convertQuantity } from "../units.js";

export type QuantitySource = {
  base: string;
  var?: string;
  transforms?: Array<Record<string, unknown>>;
  source_attr?: string;
  interval_minutes?: number;
  aggregation?: "max" | "sum" | "avg";
};

/**
 * The quantity a component prices, in the unit that component prices in.
 *
 * `targetUnit` is the pricing block's own `unit`. Only a metered
 * quantity carries a unit to convert from — a fixed charge, an ERU
 * count or an item count is already in the terms its tariff names — so
 * the conversion is scoped to that base. A component that declares no
 * unit gets the quantity as read, which is what every tariff authored
 * in its meter's own unit relies on.
 */
export function resolveQuantity(
  qsource: QuantitySource,
  ctx: RatingContext,
  targetUnit?: string,
): Decimal {
  let qty = lookupBase(qsource, ctx, targetUnit);
  for (const t of qsource.transforms ?? []) {
    qty = applyTransform(t, qty, ctx);
  }
  return qty;
}

function lookupBase(
  qsource: QuantitySource,
  ctx: RatingContext,
  targetUnit?: string,
): Decimal {
  switch (qsource.base) {
    case "fixed":
      return ONE;
    case "metered": {
      const meterId = inferMeterId(ctx);
      const reads = ctx.vars.get(`meter:reads:${meterId}`) as
        | { quantity: number | string; unit?: string }
        | undefined;
      if (!reads) {
        throw new Error(
          `Quantity source 'metered' requires meter:reads:${meterId} variable`,
        );
      }
      const quantity = toDecimal(reads.quantity);
      if (!targetUnit || !reads.unit) return quantity;
      return convertQuantity(quantity, reads.unit, targetUnit);
    }
    case "wqa": {
      const saId = ctx.base.sa.id;
      const value = ctx.vars.get(`wqa:current:${saId}`);
      if (value === undefined) {
        throw new Error(`Quantity source 'wqa' requires wqa:current:${saId} variable`);
      }
      return toDecimal(value as number | string);
    }
    case "premise_attribute": {
      const attr = qsource.source_attr;
      if (!attr) throw new Error("premise_attribute base requires source_attr");
      const fieldName = attr.startsWith("premise.") ? attr.slice("premise.".length) : attr;
      const camel = snakeToCamel(fieldName);
      const value = (ctx.base.premise as Record<string, unknown>)[camel];
      if (value === null || value === undefined) return ZERO;
      return toDecimal(value as number | string);
    }
    case "linked_commodity": {
      const linkedKeys = [...ctx.vars.keys()].filter(
        (k) => k.startsWith("linked:") && k.endsWith(":current_period"),
      );
      if (linkedKeys.length === 0) {
        throw new Error(
          "linked_commodity base requires a linked:*:current_period variable",
        );
      }
      if (linkedKeys.length > 1) {
        throw new Error(`linked_commodity ambiguous: ${linkedKeys.length} candidates`);
      }
      const value = ctx.vars.get(linkedKeys[0]!);
      return toDecimal(value as number | string);
    }
    case "item_count": {
      const itemKeys = [...ctx.vars.keys()].filter((k) => k.startsWith("items:"));
      let total = 0;
      for (const k of itemKeys) {
        const items = ctx.vars.get(k);
        if (Array.isArray(items)) total += items.length;
      }
      return toDecimal(total);
    }
    case "peak_demand":
      throw new UnsupportedInSlice3Error("peak_demand quantity source");
    default:
      throw new Error(`Unknown quantity source base: ${qsource.base}`);
  }
}

function applyTransform(
  t: Record<string, unknown>,
  qty: Decimal,
  ctx: RatingContext,
): Decimal {
  switch (t.type) {
    case "ratchet":
      throw new UnsupportedInSlice3Error("ratchet transform");
    case "clamp": {
      let q = qty;
      if (t.min !== undefined) q = Decimal.max(q, toDecimal(t.min as number));
      if (t.max !== undefined) q = Decimal.min(q, toDecimal(t.max as number));
      return q;
    }
    case "net": {
      const subtractKey = t.subtract as string;
      const sub = toDecimal((ctx.vars.get(subtractKey) as number) ?? 0);
      return Decimal.max(ZERO, qty.minus(sub));
    }
    case "prorate": {
      const standardDays = toDecimal(t.standard_days as number);
      const days = toDecimal(daysIn(ctx.base.period));
      return qty.mul(days).div(standardDays);
    }
    case "subtract_linked_commodity": {
      const commodityId = t.commodity_id as string;
      const linkedKey = `linked:${commodityId}:current_period`;
      const linked = toDecimal((ctx.vars.get(linkedKey) as number) ?? 0);
      return Decimal.max(ZERO, qty.minus(linked));
    }
    case "tou_window_filter":
      throw new UnsupportedInSlice3Error("tou_window_filter transform");
    case "power_factor":
      throw new UnsupportedInSlice3Error("power_factor transform");
    case "load_factor":
      throw new UnsupportedInSlice3Error("load_factor transform");
    case "floor": {
      const min = toDecimal(t.min as number);
      return Decimal.max(qty, min);
    }
    default:
      throw new Error(`Unknown quantity transform type: ${t.type}`);
  }
}

function inferMeterId(ctx: RatingContext): string | undefined {
  for (const key of ctx.vars.keys()) {
    if (key.startsWith("meter:reads:")) {
      return key.slice("meter:reads:".length);
    }
  }
  return undefined;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}


