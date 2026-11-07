import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "../filter-bar";

/**
 * The item that clears a filter, and what it is called.
 *
 * It is `All {label}`, which reads correctly while a filter's label
 * names a *dimension* — "All Status", "All Commodity". It stops being
 * true the moment the label names a *condition*: the Meter Reads
 * screen's Exceptions pill offered
 *
 *     All Exceptions  ·  With exception  ·  No exception
 *
 * where the first item means "do not filter on this" and plainly reads
 * as "every read that has an exception". Reported 2026-11-07, by
 * someone who had just watched that pill return the wrong rows for a
 * different reason and could not tell the two faults apart — which is
 * the cost of the label: it made a working filter unreadable and a
 * broken one undiagnosable.
 *
 * So a filter whose label is a condition says what clearing it means.
 */
describe("FilterBar's clear item", () => {
  const open = async (label: string) => {
    await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
  };

  it("is All {label} by default, which suits a dimension", async () => {
    render(
      <FilterBar
        filters={[
          {
            key: "status",
            label: "Status",
            options: [{ label: "Active", value: "ACTIVE" }],
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    await open("Status");
    expect(screen.getByText("All Status")).toBeInTheDocument();
  });

  it("says what the filter says when the label is a condition", async () => {
    render(
      <FilterBar
        filters={[
          {
            key: "hasException",
            label: "Exceptions",
            allLabel: "All Reads",
            options: [
              { label: "With exception", value: "true" },
              { label: "No exception", value: "false" },
            ],
            onChange: vi.fn(),
          },
        ]}
      />,
    );

    await open("Exceptions");
    // Three items, and the first one names what it returns — the
    // reads, not the exceptions.
    expect(screen.getByText("All Reads")).toBeInTheDocument();
    expect(screen.getByText("With exception")).toBeInTheDocument();
    expect(screen.getByText("No exception")).toBeInTheDocument();
    // The whole point: not an item that reads as a third subset.
    expect(screen.queryByText("All Exceptions")).not.toBeInTheDocument();
  });

  it("clears the filter when that item is chosen", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={[
          {
            key: "hasException",
            label: "Exceptions",
            allLabel: "All Reads",
            value: "true",
            options: [
              { label: "With exception", value: "true" },
              { label: "No exception", value: "false" },
            ],
            onChange,
          },
        ]}
      />,
    );

    await open("Exceptions");
    await userEvent.click(screen.getByText("All Reads"));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
