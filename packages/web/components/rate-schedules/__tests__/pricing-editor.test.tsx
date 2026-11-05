import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlatEditor } from "../pricing-editors/flat-editor";
import { TieredEditor } from "../pricing-editors/tiered-editor";
import { LookupEditor } from "../pricing-editors/lookup-editor";
import type { UnitOptionGroup } from "../pricing-editors/unit-picker";

/**
 * The pricing editors' two unmarked fields: a money amount that did not
 * say it was money, and a unit that was a free-text box.
 *
 * The unit is a **bill-line label**, not a unit of measure — the engine
 * copies it onto the line and never interprets it, which is why `MONTH`
 * and `ERU` are legitimate values alongside `HCF`. So the picker offers
 * the known vocabulary and still accepts anything: a closed list drawn
 * from `unit_of_measure` would not contain `HCF`, which is the single
 * most-used unit in the seeded tariffs.
 *
 * It being free text is also how `kWh` and `KWH` both ended up in one
 * seed, which a bill prints as written.
 *
 * The round-trip tests here cover a live data loss, not a hypothetical:
 * `TieredEditor` and `LookupEditor` read only their rows and re-emitted
 * only their rows, so opening a seeded Bozeman water component
 * (tiered, `unit: "HCF"`) and saving silently dropped the unit — and
 * `standard_days` with it, which scales tier thresholds by the days
 * billed and therefore changes what the customer owes.
 */

const GROUPS: UnitOptionGroup[] = [
  { label: "Used in this tariff", codes: ["HCF"] },
  { label: "Units of measure", codes: ["GAL", "KWH"] },
  { label: "Billing periods", codes: ["MONTH", "DAY"] },
];

const unitSelect = () => screen.getByLabelText("Unit");

describe("the flat editor", () => {
  it("marks the rate as money", () => {
    render(<FlatEditor value={null} onChange={vi.fn()} unitOptions={GROUPS} />);

    expect(screen.getAllByText("$")).toHaveLength(1);
  });

  it("offers the known units instead of an empty text box", () => {
    render(<FlatEditor value={null} onChange={vi.fn()} unitOptions={GROUPS} />);

    const select = unitSelect();
    expect(select.tagName).toBe("SELECT");
    expect(select.textContent).toMatch(/HCF/);
    expect(select.textContent).toMatch(/MONTH/);
  });

  it("emits the unit that was picked", async () => {
    const onChange = vi.fn();
    render(
      <FlatEditor value={{ type: "flat", rate: 0.0741 }} onChange={onChange} unitOptions={GROUPS} />,
    );

    await userEvent.selectOptions(unitSelect(), "MONTH");

    expect(onChange).toHaveBeenLastCalledWith({ type: "flat", rate: 0.0741, unit: "MONTH" });
  });

  it("keeps a unit that is in no group, and says so", async () => {
    // A tenant's vocabulary is not ours to close. `ERU` is in the
    // seeded tariffs and is not a unit of measure of anything.
    const onChange = vi.fn();
    render(
      <FlatEditor
        value={{ type: "flat", rate: 12, unit: "ERU" }}
        onChange={onChange}
        unitOptions={GROUPS}
      />,
    );

    expect(unitSelect()).toHaveValue("__other");
    expect(screen.getByLabelText("Unit label")).toHaveValue("ERU");
    expect(onChange).toHaveBeenLastCalledWith({ type: "flat", rate: 12, unit: "ERU" });
  });

  it("accepts a unit typed into the escape hatch", async () => {
    const onChange = vi.fn();
    render(
      <FlatEditor value={{ type: "flat", rate: 3 }} onChange={onChange} unitOptions={GROUPS} />,
    );

    await userEvent.selectOptions(unitSelect(), "__other");
    await userEvent.type(screen.getByLabelText("Unit label"), "CART");

    expect(onChange).toHaveBeenLastCalledWith({ type: "flat", rate: 3, unit: "CART" });
  });
});

describe("the tiered editor", () => {
  const tiered = {
    type: "tiered" as const,
    unit: "HCF",
    tiers: [
      { to: 5, rate: 2.15 },
      { to: null, rate: 5.05 },
    ],
  };

  it("keeps the unit through an edit of the rates", async () => {
    const onChange = vi.fn();
    render(<TieredEditor value={tiered} onChange={onChange} unitOptions={GROUPS} />);

    await userEvent.clear(screen.getAllByLabelText(/^Rate for tier/)[0]!);
    await userEvent.type(screen.getAllByLabelText(/^Rate for tier/)[0]!, "2.25");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "tiered", unit: "HCF" }),
    );
  });

  it("keeps standard_days, which it does not edit", async () => {
    /*
     * Thresholds scaled by the days billed (Bozeman Req 138). Dropping
     * it turns a prorated allowance back into a full month's, which is
     * a different bill — and nothing would have said so.
     */
    const onChange = vi.fn();
    render(
      <TieredEditor
        value={{ ...tiered, standard_days: 30 }}
        onChange={onChange}
        unitOptions={GROUPS}
      />,
    );

    await userEvent.clear(screen.getAllByLabelText(/^Rate for tier/)[0]!);
    await userEvent.type(screen.getAllByLabelText(/^Rate for tier/)[0]!, "2.25");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ standard_days: 30 }),
    );
  });

  it("marks the rates as money and the thresholds as not", () => {
    render(<TieredEditor value={tiered} onChange={vi.fn()} unitOptions={GROUPS} />);

    // One per tier rate; the "up to" threshold is a quantity of the
    // priced thing, not an amount of money.
    expect(screen.getAllByText("$")).toHaveLength(2);
  });
});

describe("the lookup editor", () => {
  it("keeps the unit through an edit of the table", async () => {
    const onChange = vi.fn();
    render(
      <LookupEditor
        value={{ type: "lookup", by: "meter_size", unit: "MONTH", table: { '5/8"': 14.5 } }}
        onChange={onChange}
        unitOptions={GROUPS}
      />,
    );

    await userEvent.clear(screen.getAllByLabelText(/^Rate for/)[0]!);
    await userEvent.type(screen.getAllByLabelText(/^Rate for/)[0]!, "15.75");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "lookup", unit: "MONTH" }),
    );
  });

  it("marks the table rates as money", () => {
    render(
      <LookupEditor
        value={{ type: "lookup", by: "meter_size", table: { '5/8"': 14.5, '1"': 22 } }}
        onChange={vi.fn()}
        unitOptions={GROUPS}
      />,
    );

    expect(screen.getAllByText("$")).toHaveLength(2);
  });
});

describe("what the form will not let you leave blank", () => {
  /*
   * Both fields were enforced-but-unmarked or not enforced at all. The
   * rate already blocked Save by emitting null, and said nothing about
   * it; the unit did not block anything, and `bill_segment_line.unit`
   * exists precisely because "the engine converts, so a gallons meter
   * on an HCF tariff bills 6.6279 and the bill has to say of what".
   * A priced quantity with no unit is a bill line that prints a number
   * and never names it.
   *
   * Requiring the unit here, not in `pricingSchema`: the grammar stays
   * permissive for the engine and for rows already stored, and the
   * editor enforces the house rule. Across the three seeds, 48
   * components carry a unit-bearing pricing shape and every one of
   * them already sets a unit, so this refuses nothing anyone has
   * actually written.
   */
  it("marks the rate required, and holds Save while it is empty", () => {
    const onChange = vi.fn();
    render(<FlatEditor value={null} onChange={onChange} unitOptions={GROUPS} />);

    expect(screen.getByLabelText("Rate")).toBeRequired();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("marks the unit required, and holds Save until one is chosen", async () => {
    const onChange = vi.fn();
    render(
      <FlatEditor value={{ type: "flat", rate: 0.0741 }} onChange={onChange} unitOptions={GROUPS} />,
    );

    expect(unitSelect()).toBeRequired();
    expect(onChange).toHaveBeenLastCalledWith(null);

    await userEvent.selectOptions(unitSelect(), "HCF");

    expect(onChange).toHaveBeenLastCalledWith({ type: "flat", rate: 0.0741, unit: "HCF" });
  });

  it("holds Save on a tiered charge with no unit", () => {
    const onChange = vi.fn();
    render(
      <TieredEditor
        value={{ type: "tiered", tiers: [{ to: null, rate: 2.15 }] }}
        onChange={onChange}
        unitOptions={GROUPS}
      />,
    );

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("holds Save on a lookup charge with no unit", () => {
    const onChange = vi.fn();
    render(
      <LookupEditor
        value={{ type: "lookup", by: "meter_size", table: { '5/8"': 14.5 } }}
        onChange={onChange}
        unitOptions={GROUPS}
      />,
    );

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("does not accept Other… with nothing typed into it", async () => {
    const onChange = vi.fn();
    render(
      <FlatEditor value={{ type: "flat", rate: 3 }} onChange={onChange} unitOptions={GROUPS} />,
    );

    await userEvent.selectOptions(unitSelect(), "__other");

    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("the unit picker with nothing to offer", () => {
  it("is still usable when no groups are supplied", async () => {
    // The lesson from the commodity dropdown: a control with an empty
    // list must not be a dead end.
    const onChange = vi.fn();
    render(<FlatEditor value={{ type: "flat", rate: 1 }} onChange={onChange} unitOptions={[]} />);

    await userEvent.selectOptions(unitSelect(), "__other");
    await userEvent.type(screen.getByLabelText("Unit label"), "EACH");

    expect(onChange).toHaveBeenLastCalledWith({ type: "flat", rate: 1, unit: "EACH" });
  });
});
