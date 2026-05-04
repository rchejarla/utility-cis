import type { BaseContext, VariableKey } from "./types.js";

/**
 * Walk the active components on `base.assignments` and collect every variable
 * key the engine will need to evaluate them.
 *
 * Returns distinct keys sorted alphabetically for deterministic output.
 *
 * Note: meter:reads:* / meter:size:* keys are NOT collected here — they
 * require the SA's meter assignment which the caller infers at rate time.
 * That's a Slice 4 concern.
 */
export function manifest(base: BaseContext): VariableKey[] {
  const keys = new Set<VariableKey>();

  for (const a of base.assignments) {
    for (const c of a.schedule.components) {
      collectFromPredicate(c.predicate, base, keys);
      collectFromQuantitySource(c.quantitySource, base, keys);
      collectFromPricing(c.pricing, base, keys);
    }
  }

  return [...keys].sort();
}

function collectFromPredicate(
  pred: unknown,
  base: BaseContext,
  keys: Set<VariableKey>,
): void {
  if (!pred || typeof pred !== "object") return;
  const p = pred as Record<string, unknown>;
  for (const op of Object.keys(p)) {
    const v = p[op];
    switch (op) {
      case "and":
      case "or":
        for (const sub of v as unknown[]) collectFromPredicate(sub, base, keys);
        break;
      case "not":
        collectFromPredicate(v, base, keys);
        break;
      case "drought_stage_active":
        keys.add("tenant:drought_stage");
        break;
      case "qty_gte":
      case "qty_lte":
        keys.add((v as { var: string }).var);
        break;
      case "customer_attr":
        keys.add(`account:flag:${(v as { attr: string }).attr}`);
        break;
      // meter_size / meter_size_in / meter_role need the meter id, which manifest()
      // doesn't know upfront. Caller fills via meter:reads:* heuristic at rate time.
    }
  }
}

function collectFromQuantitySource(
  qs: unknown,
  base: BaseContext,
  keys: Set<VariableKey>,
): void {
  if (!qs || typeof qs !== "object") return;
  const q = qs as Record<string, unknown>;
  switch (q.base) {
    case "wqa":
      keys.add(`wqa:current:${base.sa.id}`);
      break;
    // metered, item_count, premise_attribute, fixed need no upfront keys
    // (metered uses inferMeterId at rate time — caller pre-loads)
  }

  for (const t of (q.transforms as Array<Record<string, unknown>> | undefined) ?? []) {
    if (t.type === "net" && typeof t.subtract === "string") {
      keys.add(t.subtract);
    }
    if (t.type === "subtract_linked_commodity" && typeof t.commodity_id === "string") {
      keys.add(`linked:${t.commodity_id}:current_period`);
    }
  }
}

function collectFromPricing(
  pr: unknown,
  base: BaseContext,
  keys: Set<VariableKey>,
): void {
  if (!pr || typeof pr !== "object") return;
  const p = pr as Record<string, unknown>;
  if (p.type === "indexed") {
    const indexName = p.index_name;
    const period = resolvePeriod(
      p.period_resolver as string,
      p.fixed_period as string | undefined,
      base,
    );
    keys.add(`index:${indexName}:${period}`);
  }
  // Note: lookup with by="meter_size" needs meter id; caller pre-loads at rate time.
}

function resolvePeriod(
  resolver: string,
  fixedPeriod: string | undefined,
  base: BaseContext,
): string {
  const p = base.period.startDate;
  switch (resolver) {
    case "current_quarter":
      return `${p.getFullYear()}-Q${Math.floor(p.getMonth() / 3) + 1}`;
    case "current_month":
      return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, "0")}`;
    case "current_year":
      return String(p.getFullYear());
    case "fixed":
      return fixedPeriod ?? "";
    default:
      return "";
  }
}
