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
  /** `tou_period` base: which of the calendar's periods this prices. */
  peak_code?: string;
};

/**
 * Where a TOU bucket lives: `meter:tou:<meterId>:<peakCode>`.
 *
 * **The loader emits one per period in the calendar, zero included.**
 * That contract is what lets an absent bucket raise instead of billing
 * nothing: a customer with no on-peak usage has a bucket reading zero,
 * so a missing bucket means the TOU data did not load — and returning
 * zero there would bill a TOU customer nothing for their peak usage on
 * a bill that looked like a quiet month.
 */
const TOU_VAR_PREFIX = "meter:tou:";

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
  /** Collects why the quantity differs from the measurement — the bill line's `basis`. */
  notes?: string[],
): Decimal {
  let qty = lookupBase(qsource, ctx, targetUnit);
  for (const t of qsource.transforms ?? []) {
    qty = applyTransform(t, qty, ctx, targetUnit, notes);
  }
  return qty;
}

/** Where a meter's period peak lives (spec 31): `demand:peak:<meterId>`. */
const DEMAND_PEAK_PREFIX = "demand:peak:";

/** A rating refusal with a code a billing run can record against the account. */
function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, statusCode: 422 });
}

/** A kW figure as a bill prints it: up to two decimals, no trailing zeros. */
const kw = (d: Decimal) => String(Number(d.toFixed(2)));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (yyyyMm: string) => `${MONTHS[Number(yyyyMm.slice(5, 7)) - 1]} ${yyyyMm.slice(0, 4)}`;

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
    case "tou_period": {
      /*
       * One TOU period's usage (spec 26, TOU-ENG-1).
       *
       * A base rather than a filter on `metered`, because on-peak kWh
       * cannot be derived from total kWh — the quantity *is* this
       * period's usage, read from where it lives. Each period is its
       * own component with its own price and its own bill line, which
       * is how tariffs are written and how bills read.
       */
      const peakCode = qsource.peak_code;
      if (!peakCode) {
        throw new Error("tou_period quantity source requires peak_code");
      }

      /*
       * The key is parsed, not suffix-matched. `peak`, `mid_peak`,
       * `off_peak` and `super_off_peak` all end in "peak", so a suffix
       * test would have the on-peak charge price off-peak usage — at
       * roughly twice the rate, on every TOU bill, with nothing raised.
       */
      const buckets = [...ctx.vars.keys()].filter((key) => {
        if (!key.startsWith(TOU_VAR_PREFIX)) return false;
        const parts = key.split(":");
        return parts.length === 4 && parts[3] === peakCode;
      });

      if (buckets.length === 0) {
        throw new Error(
          `Quantity source 'tou_period' requires a ${TOU_VAR_PREFIX}<meter>:${peakCode} variable. ` +
            "The loader emits one per period in the calendar, zero included, so none means " +
            "the TOU data did not load for this period.",
        );
      }

      // Summed across the agreement's meters, each converted first: two
      // meters reporting in different units cannot simply be added.
      let total = ZERO;
      for (const key of buckets) {
        const read = ctx.vars.get(key) as { quantity: number | string; unit?: string };
        const quantity = toDecimal(read.quantity);
        total = total.plus(
          targetUnit && read.unit ? convertQuantity(quantity, read.unit, targetUnit) : quantity,
        );
      }
      return total;
    }
    case "peak_demand": {
      /*
       * The period's measured peak (spec 31, DEM-ENG-1): each meter's own
       * peak — already the maximum of its reads, DEM-ENG-1a — then the
       * meters added (DEM-ENG-2, non-coincident).
       *
       * **An absent peak is never zero** (DEM-ENG-3), the rule the TOU
       * buckets follow. A meter with a demand register and no read this
       * period may have had its peak in the read that is missing; an
       * agreement whose meters measure no demand at all cannot be billed
       * a demand charge. Both refuse, naming why.
       */
      const peaks = [...ctx.vars.entries()].filter(([k]) => k.startsWith(DEMAND_PEAK_PREFIX));
      const missing = peaks.filter(([, v]) => (v as { quantity: unknown }).quantity === null);
      if (missing.length > 0) {
        const ids = missing.map(([k]) => k.slice(DEMAND_PEAK_PREFIX.length)).join(", ");
        throw refusal(
          "DEMAND_READ_MISSING",
          `No demand read in this period for meter ${ids}, which has a demand register. ` +
            "Its peak may be the read that is missing, so the demand charge cannot be worked out.",
        );
      }
      if (peaks.length === 0) {
        throw refusal(
          "DEMAND_NOT_MEASURED",
          "This agreement's tariff charges for peak demand, but none of its meters measures demand. " +
            "Give a meter a demand register, or move the agreement to a tariff without a demand charge.",
        );
      }
      let total = ZERO;
      for (const [, v] of peaks) {
        const peak = v as { quantity: Decimal; unit: string };
        total = total.plus(targetUnit ? convertQuantity(peak.quantity, peak.unit, targetUnit) : peak.quantity);
      }
      return total;
    }
    default:
      throw new Error(`Unknown quantity source base: ${qsource.base}`);
  }
}

function applyTransform(
  t: Record<string, unknown>,
  qty: Decimal,
  ctx: RatingContext,
  targetUnit: string | undefined,
  notes: string[] | undefined,
): Decimal {
  switch (t.type) {
    case "ratchet":
      return applyRatchet(t, qty, ctx, targetUnit, notes);
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
      /*
       * Left unimplemented on purpose. A transform takes a quantity and
       * returns one, and on-peak kWh cannot be computed from total kWh
       * — so this would have to ignore its own input and read the
       * buckets itself. The `tou_period` base above is that, honestly
       * shaped.
       *
       * It may yet earn its keep for **demand**, where filtering to the
       * on-peak window and then taking the maximum genuinely is a
       * filter over a series. That waits for `peak_demand`, which is
       * its own spec after slice 2.
       */
      throw new UnsupportedInSlice3Error(
        "tou_window_filter transform — use the 'tou_period' quantity source base instead",
      );
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

/**
 * Billed demand = max(measured, percent% × the highest measured peak in
 * the lookback) — spec 31, DEM-ENG-4.
 *
 * The lookback is the agreement's own history (D1), **measured** peaks
 * rather than billed ones (D7: ratcheting on a ratchet would compound for
 * ever), over the `lookback_months` before this period. `months` limits it
 * to peaks read in those calendar months — a summer ratchet (D2).
 *
 * When the ratchet sets the figure, it says so in `notes`; that becomes
 * the line's `basis`, because a customer billed for capacity they did not
 * use this month has to be able to see why (DEM-BIL-1).
 */
function applyRatchet(
  t: Record<string, unknown>,
  measured: Decimal,
  ctx: RatingContext,
  targetUnit: string | undefined,
  notes: string[] | undefined,
): Decimal {
  const percent = toDecimal(t.percent as number);
  const lookback = Number(t.lookback_months);
  const months = Array.isArray(t.months) ? new Set((t.months as number[]).map(Number)) : null;

  const historyKey = `demand:history:${ctx.base.sa.id}`;
  const history = ctx.vars.get(historyKey) as
    | Array<{ month: string; readDate: string; quantity: Decimal; unit: string }>
    | undefined;
  if (!history) {
    throw new Error(`The ratchet transform requires the ${historyKey} variable`);
  }

  const from = new Date(ctx.base.period.startDate);
  from.setUTCMonth(from.getUTCMonth() - lookback);
  const fromDay = from.toISOString().slice(0, 10);

  let best: { month: string; quantity: Decimal } | null = null;
  for (const h of history) {
    if (h.readDate < fromDay) continue;
    if (months && !months.has(Number(h.month.slice(5, 7)))) continue;
    const q = targetUnit ? convertQuantity(toDecimal(h.quantity), h.unit, targetUnit) : toDecimal(h.quantity);
    if (!best || q.gt(best.quantity)) best = { month: h.month, quantity: q };
  }
  // A young agreement ratchets on what it has; one with no history, not at all.
  if (!best) return measured;

  const floor = best.quantity.mul(percent).div(100);
  if (floor.lte(measured)) return measured;

  notes?.push(
    `Ratchet: ${kw(percent)}% of ${kw(best.quantity)} kW peak (${monthName(best.month)}); measured ${kw(measured)} kW`,
  );
  return floor;
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


