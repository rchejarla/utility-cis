import type { RatingContext } from "../types.js";
import { UnsupportedInSlice3Error } from "../types.js";

type Predicate = Record<string, unknown>;

export function evaluatePredicate(predicate: Predicate, ctx: RatingContext): boolean {
  const keys = Object.keys(predicate);
  if (keys.length === 0) return true; // empty {} = always true

  if (keys.length > 1) {
    throw new Error(`Predicate must have exactly one operator key, got ${keys.length}`);
  }

  const op = keys[0]!;
  const value = (predicate as Record<string, any>)[op];

  switch (op) {
    case "and":
      return (value as Predicate[]).every((p) => evaluatePredicate(p, ctx));
    case "or":
      return (value as Predicate[]).some((p) => evaluatePredicate(p, ctx));
    case "not":
      return !evaluatePredicate(value as Predicate, ctx);
    case "eq":
      return resolveValue(value.left, ctx) === resolveValue(value.right, ctx);
    case "ne":
      return resolveValue(value.left, ctx) !== resolveValue(value.right, ctx);
    case "in":
      return (value.set as unknown[]).includes(resolveValue(value.value, ctx));
    case "class":
      return ctx.base.sa.rateServiceClassCode === value;
    case "class_in":
      return (value as string[]).includes(ctx.base.sa.rateServiceClassCode ?? "");
    case "meter_size": {
      const meterId = inferMeterId(ctx);
      const size = ctx.vars.get(`meter:size:${meterId}`);
      return size === value;
    }
    case "meter_size_in": {
      const meterId = inferMeterId(ctx);
      const size = ctx.vars.get(`meter:size:${meterId}`);
      return (value as string[]).includes(size as string);
    }
    case "season":
      return computeSeason(ctx.base.period) === value;
    case "tou_window":
      throw new UnsupportedInSlice3Error("tou_window predicate");
    case "drought_stage_active": {
      const raw =
        ctx.vars.get("tenant:drought_stage_active") ?? ctx.vars.get("tenant:drought_stage");
      return Boolean(raw) === Boolean(value);
    }
    case "premise_attr": {
      const attrVal = (ctx.base.premise as Record<string, unknown>)[value.attr];
      if (value.eq !== undefined) return attrVal === value.eq;
      if (value.ne !== undefined) return attrVal !== value.ne;
      return attrVal !== undefined;
    }
    case "meter_role": {
      const meterId = inferMeterId(ctx);
      const role = ctx.vars.get(`meter:role:${meterId}`);
      if (value.eq !== undefined) return role === value.eq;
      if (value.ne !== undefined) return role !== value.ne;
      return true;
    }
    case "qty_gte": {
      const qty = ctx.vars.get(value.var);
      return Number(qty) >= value.value;
    }
    case "qty_lte": {
      const qty = ctx.vars.get(value.var);
      return Number(qty) <= value.value;
    }
    case "customer_attr": {
      const attrVal = ctx.vars.get(`account:flag:${value.attr}`);
      if (value.eq !== undefined) return attrVal === value.eq;
      return Boolean(attrVal);
    }
    case "period": {
      const start = ctx.base.period.startDate;
      const end = ctx.base.period.endDate;
      if (value.from && new Date(value.from) > start) return false;
      if (value.to && new Date(value.to) < end) return false;
      return true;
    }
    default:
      throw new Error(`Unknown predicate operator: ${op}`);
  }
}

function resolveValue(v: unknown, ctx: RatingContext): unknown {
  if (typeof v === "object" && v !== null && "var" in v) {
    return ctx.vars.get((v as { var: string }).var);
  }
  return v;
}

function inferMeterId(ctx: RatingContext): string | undefined {
  // Engine-side: whoever calls rate() decides the "primary meter" for predicates
  // that read meter_size/role. For Slice 3 we look for a meter:reads:* key and
  // extract the meter id; this is a temporary heuristic.
  for (const key of ctx.vars.keys()) {
    if (key.startsWith("meter:reads:")) {
      return key.slice("meter:reads:".length);
    }
  }
  return undefined;
}

function computeSeason(period: { startDate: Date; endDate: Date }): string {
  const month = period.startDate.getMonth(); // 0-indexed
  if (month >= 4 && month <= 9) return "summer"; // May–Oct
  return "winter"; // Nov–Apr
}
