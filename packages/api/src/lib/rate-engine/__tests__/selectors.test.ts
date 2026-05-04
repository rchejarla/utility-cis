import { describe, it, expect } from "vitest";
import { evaluateSelector } from "../evaluators/selectors.js";
import { Decimal } from "../decimal.js";
import type { LineItem } from "../types.js";

function line(overrides: Partial<LineItem> = {}): LineItem {
  return {
    label: "Default Line",
    amount: new Decimal(0),
    kindCode: "volumetric",
    sourceScheduleId: "sched-1",
    sourceComponentId: "comp-1",
    ...overrides,
  };
}

const lines: LineItem[] = [
  line({
    label: "Water Volumetric",
    amount: new Decimal(50),
    kindCode: "volumetric",
    sourceScheduleId: "sched-1",
    sourceComponentId: "comp-1",
  }),
  line({
    label: "Water Service Charge",
    amount: new Decimal(20),
    kindCode: "service_charge",
    sourceScheduleId: "sched-1",
    sourceComponentId: "comp-2",
  }),
  line({
    label: "Sewer Volumetric",
    amount: new Decimal(30),
    kindCode: "volumetric",
    sourceScheduleId: "sched-2",
    sourceComponentId: "comp-3",
  }),
  line({
    label: "Tax City",
    amount: new Decimal(5),
    kindCode: "tax",
    sourceScheduleId: "sched-3",
    sourceComponentId: "comp-4",
  }),
];

describe("evaluateSelector", () => {
  it("component_id matches a single line", () => {
    const result = evaluateSelector({ component_id: "comp-2" }, lines);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("Water Service Charge");
  });

  it("kind matches all lines of that kind", () => {
    const result = evaluateSelector({ kind: "volumetric" }, lines);
    expect(result).toHaveLength(2);
    expect(result.map((l) => l.label).sort()).toEqual([
      "Sewer Volumetric",
      "Water Volumetric",
    ]);
  });

  it("kind_in matches union of kinds", () => {
    const result = evaluateSelector(
      { kind_in: ["volumetric", "tax"] },
      lines,
    );
    expect(result).toHaveLength(3);
  });

  it("exclude_kind matches lines NOT in the list", () => {
    const result = evaluateSelector({ exclude_kind: ["tax"] }, lines);
    expect(result).toHaveLength(3);
    expect(result.every((l) => l.kindCode !== "tax")).toBe(true);
  });

  it("source_schedule_id matches lines from a given schedule", () => {
    const result = evaluateSelector({ source_schedule_id: "sched-1" }, lines);
    expect(result).toHaveLength(2);
  });

  it("has_label_prefix matches labels by string prefix", () => {
    const result = evaluateSelector({ has_label_prefix: "Water" }, lines);
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.label.startsWith("Water"))).toBe(true);
  });

  it("and composes — only lines matching ALL sub-selectors", () => {
    const result = evaluateSelector(
      {
        and: [
          { kind: "volumetric" },
          { source_schedule_id: "sched-1" },
        ],
      },
      lines,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe("Water Volumetric");
  });

  it("or composes — lines matching ANY sub-selector", () => {
    const result = evaluateSelector(
      {
        or: [{ kind: "tax" }, { component_id: "comp-1" }],
      },
      lines,
    );
    expect(result).toHaveLength(2);
  });

  it("source_schedule_role throws (slice 3 not implemented)", () => {
    expect(() => evaluateSelector({ source_schedule_role: "primary" }, lines)).toThrow(
      /source_schedule_role selector not yet implemented/,
    );
  });

  it("unknown selector op throws clear error", () => {
    expect(() =>
      evaluateSelector({ no_such_op: true } as unknown as Record<string, unknown>, lines),
    ).toThrow(/Unknown selector op: no_such_op/);
  });

  it("multi-key selector throws", () => {
    expect(() =>
      evaluateSelector(
        { kind: "volumetric", component_id: "comp-1" } as unknown as Record<string, unknown>,
        lines,
      ),
    ).toThrow(/exactly one operator key/);
  });
});
