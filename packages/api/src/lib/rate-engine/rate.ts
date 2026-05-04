import { ZERO, toDecimal } from "./decimal.js";
import type {
  RatingContext,
  RatingResult,
  LineItem,
  ComponentTrace,
  RateComponentSnapshot,
} from "./types.js";
import { evaluatePredicate } from "./evaluators/predicate.js";
import { resolveQuantity } from "./evaluators/quantity-source.js";
import { applyPricing } from "./evaluators/pricing.js";
import { evaluateSelector } from "./evaluators/selectors.js";
import { topoSortComponents } from "./ordering/topo-sort.js";

export function rate(ctx: RatingContext): RatingResult {
  // 1. Active assignments — overlap with bill period
  const activeAssignments = ctx.base.assignments.filter((a) =>
    isInPeriod(a.effectiveDate, a.expirationDate, ctx.base.period),
  );

  // 2. Collect components, decorating with the source schedule id
  const components: Array<RateComponentSnapshot & { _scheduleId: string }> = [];
  for (const a of activeAssignments) {
    for (const c of a.schedule.components) {
      if (isInPeriod(c.effectiveDate, c.expirationDate, ctx.base.period)) {
        components.push({ ...c, _scheduleId: a.schedule.id });
      }
    }
  }

  // 3. Topologically sort
  const ordered = topoSortComponents(components) as Array<
    RateComponentSnapshot & { _scheduleId: string }
  >;

  // 4. Iterate ordered components — main rating loop
  const lines: LineItem[] = [];
  const trace: ComponentTrace[] = [];

  for (const c of ordered) {
    const evalTrace: ComponentTrace = { componentId: c.id, fired: false };

    // Predicate gate
    if (!evaluatePredicate(c.predicate as Record<string, unknown>, ctx)) {
      evalTrace.skipReason = "predicate_false";
      trace.push(evalTrace);
      continue;
    }

    // Defer minimum_bill to stage 5
    if (c.kindCode === "minimum_bill") {
      evalTrace.skipReason = "silent_minimum";
      trace.push(evalTrace);
      continue;
    }

    // Quantity
    const qty = resolveQuantity(c.quantitySource as never, ctx);
    evalTrace.evaluatedQuantity = qty;

    // Pricing
    const pricing = c.pricing as Record<string, unknown> & { type: string };
    const amount = applyPricing(pricing as never, qty, lines, ctx);

    if (amount.eq(ZERO)) {
      evalTrace.skipReason = "zero_amount";
      evalTrace.evaluatedAmount = amount;
      trace.push(evalTrace);
      continue;
    }

    // Emit line
    lines.push({
      label: c.label,
      amount,
      kindCode: c.kindCode,
      sourceScheduleId: c._scheduleId,
      sourceComponentId: c.id,
      quantity: qty,
      rate: pricing,
    });
    evalTrace.fired = true;
    evalTrace.evaluatedAmount = amount;
    trace.push(evalTrace);
  }

  // 5. minimum_bill stage — apply floors after main pricing
  const minimumBills = components.filter((c) => c.kindCode === "minimum_bill");
  let minimumFloorApplied = false;
  for (const c of minimumBills) {
    const predicate = c.predicate as Record<string, unknown>;
    if (!evaluatePredicate(predicate, ctx)) continue;

    const pricing = c.pricing as { type: string; amount?: number; selector?: unknown };
    if (pricing.type !== "floor") continue;

    const selector = pricing.selector as Record<string, unknown> | undefined;
    const inScope = selector ? evaluateSelector(selector, lines) : lines;
    const subtotal = inScope.reduce((acc, l) => acc.plus(l.amount), ZERO);
    const floor = toDecimal(pricing.amount as number);

    if (subtotal.lt(floor)) {
      const adjustment = floor.minus(subtotal);
      lines.push({
        label: c.label,
        amount: adjustment,
        kindCode: "minimum_bill",
        sourceScheduleId: c._scheduleId,
        sourceComponentId: c.id,
      });
      minimumFloorApplied = true;
    }
  }

  // 6. Totals
  const subtotal = lines
    .filter((l) => l.kindCode !== "tax" && l.kindCode !== "credit")
    .reduce((a, l) => a.plus(l.amount), ZERO);
  const taxes = lines
    .filter((l) => l.kindCode === "tax")
    .reduce((a, l) => a.plus(l.amount), ZERO);
  const credits = lines
    .filter((l) => l.kindCode === "credit")
    .reduce((a, l) => a.plus(l.amount), ZERO);
  const total = subtotal.plus(taxes).plus(credits);

  return {
    lines,
    totals: { subtotal, taxes, credits, minimumFloorApplied, total },
    trace,
  };
}

function isInPeriod(
  start: Date,
  end: Date | null,
  period: { startDate: Date; endDate: Date },
): boolean {
  if (start > period.endDate) return false;
  if (end !== null && end < period.startDate) return false;
  return true;
}
