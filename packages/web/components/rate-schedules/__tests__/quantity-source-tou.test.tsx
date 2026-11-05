import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import { QuantitySourceBuilder } from "../quantity-source-builder";

/**
 * Pricing one TOU period (spec 26, TOU-UI-3).
 *
 * The engine has rated `base: "tou_period"` since 2026-11-03 and the
 * grammar the API accepts did not have it, so the charge a TOU
 * calendar exists to price could not be authored at all. What matters
 * here is that the builder cannot emit the half-written shape: a
 * `tou_period` charge naming no period parses as invalid in the
 * schema, and reaches the engine as a bill run that throws.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const PERIODS = [
  { peakCode: "off_peak", label: "Off-peak" },
  { peakCode: "peak", label: "On-peak" },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: PERIODS });
});

describe("the TOU period source", () => {
  it("offers the tenant's periods once it is chosen", async () => {
    const onChange = vi.fn();
    render(<QuantitySourceBuilder value={{ base: "metered" }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "tou_period");

    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/tou-periods"));
    expect((await screen.findByLabelText("TOU period")).textContent).toMatch(/On-peak \(peak\)/);
  });

  it("is not valid until a period is picked", async () => {
    const onChange = vi.fn();
    render(<QuantitySourceBuilder value={{ base: "metered" }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "tou_period");

    expect(onChange).toHaveBeenLastCalledWith({ base: "tou_period" }, false);
  });

  it("emits the period it prices", async () => {
    const onChange = vi.fn();
    render(<QuantitySourceBuilder value={{ base: "metered" }} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByRole("combobox"), "tou_period");
    await userEvent.selectOptions(await screen.findByLabelText("TOU period"), "peak");

    expect(onChange).toHaveBeenLastCalledWith(
      { base: "tou_period", peak_code: "peak" },
      true,
    );
  });

  it("re-opens an existing charge on the period it already prices", async () => {
    // The editor is also how an author reads a charge back. A field
    // that did not round-trip would silently blank the period on the
    // next save.
    const onChange = vi.fn();
    render(
      <QuantitySourceBuilder
        value={{ base: "tou_period", peak_code: "off_peak" }}
        onChange={onChange}
      />,
    );

    expect(await screen.findByLabelText("TOU period")).toHaveValue("off_peak");
    expect(onChange).toHaveBeenLastCalledWith(
      { base: "tou_period", peak_code: "off_peak" },
      true,
    );
  });
});
