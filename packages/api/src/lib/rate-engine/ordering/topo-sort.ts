import type { RateComponentSnapshot, CycleReport } from "../types.js";

function findMatchingComponents(
  selector: Record<string, unknown>,
  components: RateComponentSnapshot[],
): RateComponentSnapshot[] {
  const keys = Object.keys(selector);
  if (keys.length !== 1) {
    throw new Error(`Selector must have exactly one operator key`);
  }
  const op = keys[0];
  const value = (selector as Record<string, unknown>)[op];

  switch (op) {
    case "component_id":
      return components.filter((c) => c.id === value);
    case "kind":
      return components.filter((c) => c.kindCode === value);
    case "kind_in":
      return components.filter((c) => (value as string[]).includes(c.kindCode));
    case "exclude_kind":
      return components.filter((c) => !(value as string[]).includes(c.kindCode));
    case "source_schedule_id":
      return components.filter((c) => c.rateScheduleId === value);
    case "source_schedule_role":
      return []; // role isn't on RateComponentSnapshot; not exercised in slice 3
    case "has_label_prefix":
      return components.filter((c) => c.label.startsWith(value as string));
    case "and":
      return components.filter((c) =>
        (value as Array<Record<string, unknown>>).every((sub) =>
          findMatchingComponents(sub, components).some((m) => m.id === c.id),
        ),
      );
    case "or":
      return components.filter((c) =>
        (value as Array<Record<string, unknown>>).some((sub) =>
          findMatchingComponents(sub, components).some((m) => m.id === c.id),
        ),
      );
    default:
      return []; // Unknown op — defensive default to empty match
  }
}

export function topoSortComponents(
  components: RateComponentSnapshot[],
): RateComponentSnapshot[] {
  const minimumBills = components.filter((c) => c.kindCode === "minimum_bill");
  const others = components.filter((c) => c.kindCode !== "minimum_bill");

  // Preserve original input order to break sortOrder ties stably.
  const inputIndex = new Map<string, number>();
  others.forEach((c, i) => inputIndex.set(c.id, i));

  const tieBreak = (a: RateComponentSnapshot, b: RateComponentSnapshot) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return (inputIndex.get(a.id) ?? 0) - (inputIndex.get(b.id) ?? 0);
  };

  // Build dependency map: c.id → set of component ids c depends on
  const dependencies = new Map<string, Set<string>>();
  for (const c of others) dependencies.set(c.id, new Set());

  for (const c of others) {
    const pricing = c.pricing as { type?: string; selector?: unknown };
    if (pricing?.type === "percent_of") {
      const matches = findMatchingComponents(
        pricing.selector as Record<string, unknown>,
        others,
      );
      for (const m of matches) {
        if (m.id !== c.id) dependencies.get(c.id)!.add(m.id);
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const [id, deps] of dependencies) inDegree.set(id, deps.size);

  const ready: RateComponentSnapshot[] = others
    .filter((c) => inDegree.get(c.id) === 0)
    .sort(tieBreak);

  const result: RateComponentSnapshot[] = [];

  while (ready.length > 0) {
    const c = ready.shift()!;
    result.push(c);

    for (const other of others) {
      if (dependencies.get(other.id)?.has(c.id)) {
        const newDegree = (inDegree.get(other.id) ?? 0) - 1;
        inDegree.set(other.id, newDegree);
        if (newDegree === 0) {
          ready.push(other);
          ready.sort(tieBreak);
        }
      }
    }
  }

  if (result.length !== others.length) {
    const unprocessed = others
      .filter((c) => !result.includes(c))
      .map((c) => c.id);
    throw new Error(
      `Cycle detected in component dependencies: ${unprocessed.join(", ")}`,
    );
  }

  return [...result, ...minimumBills.sort(tieBreak)];
}

export function detectCycles(
  components: RateComponentSnapshot[],
): CycleReport | null {
  try {
    topoSortComponents(components);
    return null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cycle detected")) {
      const match = err.message.match(
        /Cycle detected in component dependencies: (.+)/,
      );
      const cycle = match ? match[1].split(", ") : [];
      return { cycle };
    }
    throw err;
  }
}
