import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransformsBuilder } from "../transforms-builder";

/**
 * Transforms, picked rather than typed.
 *
 * It was a JSON textarea expecting an array of discriminated-union
 * objects, so authoring the commonest adjustment in the grammar —
 * prorate by days — meant knowing that `standard_days` is the key and
 * that it is an integer. The five the engine evaluates have two
 * parameters between them at most; there is nothing here that needs a
 * JSON editor.
 *
 * Two things the builder must not lose:
 *
 * **Order.** Transforms apply left to right, and clamp-then-prorate is
 * a different quantity from prorate-then-clamp. The list is ordered and
 * says so, and rows can be moved.
 *
 * **Transforms it does not understand.** Four are declared in the
 * grammar and not evaluated by the engine (`ratchet`,
 * `tou_window_filter`, `power_factor`, `load_factor`). They are not
 * offered — authoring one would build a tariff that cannot be rated —
 * but one already stored is kept and shown, because silently dropping
 * what an editor does not recognise is how `unit: "HCF"` disappeared
 * from the tiered editor.
 */

const AVAILABLE = [
  { code: "clamp", label: "Clamp (min/max)", supported: true },
  { code: "net", label: "Net (subtract var)", supported: true },
  { code: "prorate", label: "Prorate by days", supported: true },
  { code: "subtract_linked_commodity", label: "Subtract linked commodity", supported: true },
  { code: "floor", label: "Floor (minimum)", supported: true },
  { code: "ratchet", label: "Ratchet (peak-demand-based)", supported: false },
];

const COMMODITIES = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Water" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Irrigation" },
];

const addTransform = async (code: string) => {
  await userEvent.selectOptions(screen.getByLabelText("Add a transform"), code);
};

const renderBuilder = (value: unknown[] = [], onChange = vi.fn()) => {
  render(
    <TransformsBuilder
      value={value}
      onChange={onChange}
      available={AVAILABLE}
      commodities={COMMODITIES}
    />,
  );
  return onChange;
};

describe("the transforms builder", () => {
  it("starts empty and says most tariffs need none", () => {
    const onChange = renderBuilder();

    expect(screen.getByText(/no transforms/i)).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith([], true);
  });

  it("offers only the transforms the engine evaluates", () => {
    renderBuilder();

    const add = screen.getByLabelText("Add a transform");
    expect(add.textContent).toMatch(/Prorate by days/);
    expect(add.textContent).toMatch(/Clamp/);
    expect(add.textContent).not.toMatch(/Ratchet/);
  });

  it("holds Save while a new transform's parameter is blank", async () => {
    const onChange = renderBuilder();

    await addTransform("prorate");

    expect(onChange).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it("emits a prorate once its days are filled in", async () => {
    const onChange = renderBuilder();

    await addTransform("prorate");
    await userEvent.type(screen.getByLabelText("Standard days"), "30");

    expect(onChange).toHaveBeenLastCalledWith([{ type: "prorate", standard_days: 30 }], true);
  });

  it("accepts a clamp with only a maximum", async () => {
    const onChange = renderBuilder();

    await addTransform("clamp");
    await userEvent.type(screen.getByLabelText("Maximum"), "500");

    expect(onChange).toHaveBeenLastCalledWith([{ type: "clamp", max: 500 }], true);
  });

  it("refuses a clamp that bounds nothing", async () => {
    const onChange = renderBuilder();

    await addTransform("clamp");

    // Schema-valid — both bounds are optional — and meaningless, so the
    // form will not emit it.
    expect(onChange).toHaveBeenLastCalledWith(expect.anything(), false);
  });

  it("names the commodity to subtract instead of asking for its uuid", async () => {
    const onChange = renderBuilder();

    await addTransform("subtract_linked_commodity");
    await userEvent.selectOptions(screen.getByLabelText("Commodity to subtract"), COMMODITIES[1]!.id);

    expect(onChange).toHaveBeenLastCalledWith(
      [{ type: "subtract_linked_commodity", commodity_id: COMMODITIES[1]!.id }],
      true,
    );
  });

  it("keeps the order they are applied in, and lets it be changed", async () => {
    const onChange = renderBuilder([
      { type: "clamp", max: 500 },
      { type: "prorate", standard_days: 30 },
    ]);

    expect(screen.getByText(/applied in order/i)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Move Prorate by days earlier"));

    expect(onChange).toHaveBeenLastCalledWith(
      [
        { type: "prorate", standard_days: 30 },
        { type: "clamp", max: 500 },
      ],
      true,
    );
  });

  it("removes a transform", async () => {
    const onChange = renderBuilder([{ type: "floor", min: 2 }]);

    await userEvent.click(screen.getByLabelText("Remove Floor (minimum)"));

    expect(onChange).toHaveBeenLastCalledWith([], true);
  });

  it("keeps a transform it cannot edit, and says the engine ignores it", () => {
    const onChange = renderBuilder([
      { type: "ratchet", percent: 80, lookback_months: 11 },
      { type: "floor", min: 2 },
    ]);

    expect(screen.getByText(/ratchet/i)).toBeInTheDocument();
    expect(screen.getByText(/not evaluated/i)).toBeInTheDocument();
    // Preserved exactly, in place, rather than dropped on the next save.
    expect(onChange).toHaveBeenLastCalledWith(
      [
        { type: "ratchet", percent: 80, lookback_months: 11 },
        { type: "floor", min: 2 },
      ],
      true,
    );
  });

  it("reads an existing transform back into its inputs", () => {
    renderBuilder([{ type: "net", subtract: "meter:reads:irrigation" }]);

    expect(screen.getByLabelText("Variable to subtract")).toHaveValue(
      "meter:reads:irrigation",
    );
  });
});
