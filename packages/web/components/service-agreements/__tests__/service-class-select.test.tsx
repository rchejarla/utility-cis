import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { apiClient } from "@/lib/api-client";
import { ServiceClassSelect } from "../service-class-select";

/**
 * The agreement's service class picker. The class is required — a rate
 * charge restricted to a class applies only to agreements in it — so what
 * matters is that the choices are the commodity's, and that a sensible one
 * is pre-selected without inventing one where nothing matches.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const ELECTRIC = [
  { id: "c-res", code: "residential", label: "Residential" },
  { id: "c-sc", code: "small_commercial", label: "Small Commercial" },
];
const WATER = [
  { id: "w-sf", code: "single_family", label: "Single Family" },
  { id: "w-com", code: "commercial", label: "Commercial" },
];

function Harness({ commodityId, accountType, initial = "" }: { commodityId: string; accountType?: string; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ServiceClassSelect commodityId={commodityId} value={value} onChange={setValue} accountType={accountType} />
      <output data-testid="value">{value}</output>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockImplementation(async (_url: string, params: { commodityId: string }) => ({
    data: params.commodityId === "electric" ? ELECTRIC : WATER,
  }));
});

describe("ServiceClassSelect", () => {
  it("offers the commodity's classes and pre-selects the one matching the account type", async () => {
    render(<Harness commodityId="electric" accountType="RESIDENTIAL" />);

    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("c-res"));
    expect(get).toHaveBeenCalledWith("/api/v1/service-agreements/service-classes", { commodityId: "electric" });
    expect(screen.getByRole("option", { name: "Small Commercial" })).toBeInTheDocument();
  });

  it("leaves it to the user when no class matches the account type", async () => {
    // Water says "single family", not "residential".
    render(<Harness commodityId="water" accountType="RESIDENTIAL" />);

    await screen.findByRole("option", { name: "Single Family" });
    expect(screen.getByTestId("value").textContent).toBe("");
    expect(screen.getByLabelText("Service class")).toBeRequired();
  });

  it("drops a class that is not one of this commodity's", async () => {
    render(<Harness commodityId="water" initial="c-res" />);

    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe(""));
  });

  it("asks for the commodity first", () => {
    render(<Harness commodityId="" />);

    expect(screen.getByLabelText("Service class")).toBeDisabled();
    expect(screen.getByRole("option", { name: "Pick the commodity first" })).toBeInTheDocument();
  });
});
