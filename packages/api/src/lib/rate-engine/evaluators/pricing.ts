import { Decimal, ZERO, HUNDRED, toDecimal } from "../decimal.js";
import type { LineItem, RatingContext } from "../types.js";
import { evaluateSelector } from "./selectors.js";
import { daysIn, monthOf, quarterOf, yearOf } from "../period.js";

type Pricing = Record<string, unknown> & { type: string };

export function applyPricing(
  pricing: Pricing,
  qty: Decimal,
  lines: LineItem[],
  ctx: RatingContext,
): Decimal {
  switch (pricing.type) {
    case "flat": {
      return toDecimal(pricing.rate as number).mul(qty);
    }
    case "tiered": {
      const tiers = pricing.tiers as Array<{ to: number | null; rate: number }>;
      /*
       * Tier thresholds are an allowance for a period, so a period of a
       * different length needs a different allowance (Bozeman Req 138).
       *
       * A tariff declares what its thresholds were written for with
       * `standard_days`, and the allowance is then scaled by the days
       * actually billed. Without it a 44-day interval — ordinary after a
       * missed read, now that periods run read to read — is priced
       * against one month's allowance and crosses tiers the customer has
       * not earned. For the Bozeman SFR tariff that is 100 units at
       * tier 1 against 44 days of usage: the overcharge is not rounding,
       * it is a whole tier.
       *
       * Opt-in, and deliberately. The engine is given an interval and
       * never told what a normal one looks like, so "standard" has to
       * come from the tariff. It also means existing published schedules
       * price exactly as they did until someone revises them to say
       * otherwise — a silent change to every tiered schedule's
       * arithmetic is not something to ship by inference.
       *
       * Scaled thresholds are not rounded. The engine rounds nothing;
       * cents are decided when a line is printed.
       */
      const standardDays = pricing.standard_days as number | undefined;
      const factor =
        standardDays === undefined || standardDays <= 0
          ? null
          : toDecimal(daysIn(ctx.base.period)).div(toDecimal(standardDays));

      let remaining = qty;
      let prev = ZERO;
      let total = ZERO;
      for (const tier of tiers) {
        const declared = tier.to === null ? null : toDecimal(tier.to);
        // The open-ended tier has no threshold to scale.
        const tierTo = declared === null ? null : factor ? declared.mul(factor) : declared;
        const span = tierTo === null ? remaining : Decimal.min(remaining, tierTo.minus(prev));
        if (span.lte(ZERO)) break;
        total = total.plus(span.mul(toDecimal(tier.rate)));
        remaining = remaining.minus(span);
        if (tierTo === null) break;
        prev = tierTo;
      }
      return total;
    }
    case "lookup": {
      const byKey = pricing.by as string;
      const table = pricing.table as Record<string, number>;
      const lookupVarKey = inferVarKeyForByField(byKey, ctx);
      const lookupValue = ctx.vars.get(lookupVarKey) as string | undefined;
      if (!lookupValue) {
        throw new Error(`lookup pricing requires var ${lookupVarKey}`);
      }
      const rate = table[lookupValue];
      if (rate === undefined) {
        throw new Error(`lookup pricing: no entry for ${lookupValue} in table`);
      }
      return toDecimal(rate).mul(qty);
    }
    case "catalog": {
      const byFields = pricing.by as string[];
      const table = pricing.table as Record<string, number>;
      // For Slice 3: items are passed via items:<sp_id>:<item_type> = Container[]
      // Each container has fields matching `byFields`. Compute total = sum over
      // all matching items of table[joinKey].
      const itemKeys = [...ctx.vars.keys()].filter((k) => k.startsWith("items:"));
      let total = ZERO;
      for (const key of itemKeys) {
        const items = ctx.vars.get(key) as Array<Record<string, unknown>> | undefined;
        if (!items) continue;
        for (const item of items) {
          const joinKey = byFields
            .map((f) => snakeToCamel(f))
            .map((f) => String(item[f]))
            .join(":");
          const rate = table[joinKey];
          if (rate !== undefined) {
            total = total.plus(toDecimal(rate));
          }
        }
      }
      return total;
    }
    case "per_unit": {
      return toDecimal(pricing.rate as number).mul(qty);
    }
    case "percent_of": {
      const selector = pricing.selector as Record<string, unknown>;
      const matched = evaluateSelector(selector, lines);
      const sum = matched.reduce((acc, l) => acc.plus(l.amount), ZERO);
      return sum.mul(toDecimal(pricing.percent as number)).div(HUNDRED);
    }
    case "indexed": {
      const indexName = pricing.index_name as string;
      const period = resolvePeriod(
        pricing.period_resolver as string,
        pricing.fixed_period as string | undefined,
        ctx,
      );
      const indexValue = ctx.vars.get(`index:${indexName}:${period}`);
      if (indexValue === undefined) {
        throw new Error(`indexed pricing requires var index:${indexName}:${period}`);
      }
      const multiplier = toDecimal((pricing.multiplier as number) ?? 1);
      return toDecimal(indexValue as number).mul(qty).mul(multiplier);
    }
    case "floor":
      // Floor is handled separately in stage 5 of the orchestrator; pricing.applyPricing
      // never returns a value for kind=minimum_bill. Throw if it gets here directly.
      throw new Error(
        "floor pricing is applied at the orchestrator level, not via applyPricing",
      );
    default:
      throw new Error(`Unknown pricing type: ${(pricing as { type: string }).type}`);
  }
}

function inferVarKeyForByField(byKey: string, ctx: RatingContext): string {
  // Most common case: byKey="meter_size" → look up the primary meter's size var
  if (byKey === "meter_size") {
    for (const k of ctx.vars.keys()) {
      if (k.startsWith("meter:size:")) return k;
    }
    throw new Error("lookup by meter_size requires a meter:size:* variable");
  }
  // Future: extend for other lookup keys
  throw new Error(`lookup pricing 'by' field not supported: ${byKey}`);
}

function resolvePeriod(
  resolver: string,
  fixedPeriod: string | undefined,
  ctx: RatingContext,
): string {
  const p = ctx.base.period.startDate;
  switch (resolver) {
    case "current_quarter":
      return quarterOf(p);
    case "current_month":
      return monthOf(p);
    case "current_year":
      return yearOf(p);
    case "fixed":
      if (!fixedPeriod) throw new Error("fixed period_resolver requires fixed_period");
      return fixedPeriod;
    default:
      throw new Error(`Unknown period_resolver: ${resolver}`);
  }
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
