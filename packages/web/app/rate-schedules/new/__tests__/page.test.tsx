import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import NewRateSchedulePage from "../page";

/**
 * The commodity a tariff prices.
 *
 * `/api/v1/commodities` answers with a bare array — `listCommodities`
 * is a `findMany` and the CRUD factory sends it unwrapped — while this
 * page read `res.data`, which is `undefined` on an array. The select
 * was therefore empty for every tenant, and since a commodity is
 * required, no rate schedule could be created here at all. The seed
 * writes schedules through Prisma, so nothing caught it.
 *
 * The contract is pinned here rather than in the page's types because
 * a type cannot fail a test: six other call sites accept either shape
 * (`entity-list-page.tsx` among them), which is the evidence that the
 * ambiguity is real and worth asserting against.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const COMMODITIES = [
  { id: "com-water", name: "Water" },
  { id: "com-electric", name: "Electric" },
];

function mockGets(commodities: unknown) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/commodities") return Promise.resolve(commodities);
    if (path === "/api/v1/tou-calendars") return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the new rate schedule form", () => {
  it("offers the commodities the endpoint returns as a bare array", async () => {
    mockGets(COMMODITIES);
    render(<NewRateSchedulePage />);

    expect(await screen.findByRole("option", { name: "Water" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Electric" })).toBeInTheDocument();
  });

  it("still offers them if the endpoint is ever wrapped in a page envelope", async () => {
    // The other half of the ambiguity. Asserting both directions means
    // a future change to either side cannot empty this select silently.
    mockGets({ data: COMMODITIES });
    render(<NewRateSchedulePage />);

    expect(await screen.findByRole("option", { name: "Water" })).toBeInTheDocument();
  });

  it("says why the list is empty instead of showing a dead dropdown", async () => {
    mockGets([]);
    render(<NewRateSchedulePage />);

    expect(await screen.findByText(/no commodities/i)).toBeInTheDocument();
  });
});
