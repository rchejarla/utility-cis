import type { LineItem } from "../types.js";

type Selector = Record<string, unknown>;

export function evaluateSelector(selector: Selector, lines: LineItem[]): LineItem[] {
  return lines.filter((l) => matches(selector, l));
}

function matches(selector: Selector, line: LineItem): boolean {
  const keys = Object.keys(selector);
  if (keys.length !== 1) {
    throw new Error(`Selector must have exactly one operator key, got ${keys.length}`);
  }
  const op = keys[0]!;
  const value = (selector as Record<string, any>)[op];

  switch (op) {
    case "component_id":
      return line.sourceComponentId === value;
    case "kind":
      return line.kindCode === value;
    case "kind_in":
      return (value as string[]).includes(line.kindCode);
    case "exclude_kind":
      return !(value as string[]).includes(line.kindCode);
    case "source_schedule_id":
      return line.sourceScheduleId === value;
    case "source_schedule_role":
      // line doesn't carry roleCode directly; this requires the engine to attach
      // it during rate(). For Slice 3 we'll have the orchestrator decorate lines
      // with a role attribute or maintain a sidecar map. Simpler: throw with
      // documented message; revisit when a tariff exercises it.
      throw new Error("source_schedule_role selector not yet implemented (slice 3)");
    case "has_label_prefix":
      return line.label.startsWith(value as string);
    case "and":
      return (value as Selector[]).every((s) => matches(s, line));
    case "or":
      return (value as Selector[]).some((s) => matches(s, line));
    default:
      throw new Error(`Unknown selector op: ${op}`);
  }
}
