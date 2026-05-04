import { describe, it, expect } from "vitest";
import {
  topoSortComponents,
  detectCycles,
} from "../ordering/topo-sort.js";
import type { RateComponentSnapshot } from "../types.js";

function mkComponent(
  id: string,
  kindCode: string,
  sortOrder = 100,
  pricing: unknown = { type: "flat", rate: 1 },
): RateComponentSnapshot {
  return {
    id,
    rateScheduleId: "rs-1",
    kindCode,
    label: `comp-${id}`,
    predicate: {},
    quantitySource: { base: "fixed" },
    pricing,
    sortOrder,
    effectiveDate: new Date("2026-01-01"),
    expirationDate: null,
  };
}

describe("topoSortComponents", () => {
  it("orders independent components by sortOrder", () => {
    const a = mkComponent("a", "service_charge", 300);
    const b = mkComponent("b", "volumetric", 100);
    const c = mkComponent("c", "fee", 200);

    const sorted = topoSortComponents([a, b, c]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("orders percent_of-referenced component first (consumption before surcharge)", () => {
    const surcharge = mkComponent("surcharge", "fee", 50, {
      type: "percent_of",
      percent: "10",
      selector: { kind: "consumption" },
    });
    const consumption = mkComponent("consumption", "consumption", 200);

    const sorted = topoSortComponents([surcharge, consumption]);
    expect(sorted.map((x) => x.id)).toEqual(["consumption", "surcharge"]);
  });

  it("cascades taxes correctly (city tax depends on state tax + consumption)", () => {
    const consumption = mkComponent("cons", "consumption", 10);
    const stateTax = mkComponent("state-tax", "tax", 100, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "consumption" },
    });
    const cityTax = mkComponent("city-tax", "tax", 101, {
      type: "percent_of",
      percent: "2",
      selector: { kind_in: ["consumption", "tax"] },
    });

    const sorted = topoSortComponents([cityTax, stateTax, consumption]);
    const order = sorted.map((x) => x.id);
    expect(order.indexOf("cons")).toBeLessThan(order.indexOf("state-tax"));
    expect(order.indexOf("state-tax")).toBeLessThan(order.indexOf("city-tax"));
    expect(order.indexOf("cons")).toBeLessThan(order.indexOf("city-tax"));
  });

  it("forces minimum_bill to the end regardless of sortOrder", () => {
    const min = mkComponent("min", "minimum_bill", 1);
    const cons = mkComponent("cons", "consumption", 500);
    const svc = mkComponent("svc", "service_charge", 200);

    const sorted = topoSortComponents([min, cons, svc]);
    expect(sorted[sorted.length - 1].id).toBe("min");
    expect(sorted.map((x) => x.id)).toEqual(["svc", "cons", "min"]);
  });

  it("orders multiple minimum_bill components by sortOrder at the end", () => {
    const min1 = mkComponent("min1", "minimum_bill", 200);
    const min2 = mkComponent("min2", "minimum_bill", 100);
    const cons = mkComponent("cons", "consumption", 50);

    const sorted = topoSortComponents([min1, min2, cons]);
    expect(sorted.map((x) => x.id)).toEqual(["cons", "min2", "min1"]);
  });

  it("throws on a cycle (A → B → A)", () => {
    const a = mkComponent("a", "tax_a", 100, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "tax_b" },
    });
    const b = mkComponent("b", "tax_b", 101, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "tax_a" },
    });

    expect(() => topoSortComponents([a, b])).toThrow(/Cycle detected/);
  });

  it("preserves input order for tied sortOrder (stable tiebreak)", () => {
    const a = mkComponent("a", "fee_a", 100);
    const b = mkComponent("b", "fee_b", 100);
    const c = mkComponent("c", "fee_c", 100);

    const sorted = topoSortComponents([b, a, c]);
    expect(sorted.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("returns empty array for empty input", () => {
    expect(topoSortComponents([])).toEqual([]);
  });
});

describe("detectCycles", () => {
  it("returns null on an acyclic graph", () => {
    const cons = mkComponent("cons", "consumption", 10);
    const tax = mkComponent("tax", "tax", 100, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "consumption" },
    });

    expect(detectCycles([cons, tax])).toBeNull();
  });

  it("returns a CycleReport with the involved component IDs on a cycle", () => {
    const a = mkComponent("a", "tax_a", 100, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "tax_b" },
    });
    const b = mkComponent("b", "tax_b", 101, {
      type: "percent_of",
      percent: "5",
      selector: { kind: "tax_a" },
    });

    const report = detectCycles([a, b]);
    expect(report).not.toBeNull();
    expect(report!.cycle).toContain("a");
    expect(report!.cycle).toContain("b");
  });
});
