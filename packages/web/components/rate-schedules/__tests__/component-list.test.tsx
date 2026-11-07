import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import { ToastProvider } from "@/components/ui/toast";
import { ComponentList, type RateComponent } from "../component-list";

/**
 * What a charge costs, and what it is charged on.
 *
 * The list showed a label, a kind and the *name* of the pricing shape —
 * "flat" — so the one number a tariff exists to state was four clicks
 * away, and a `tou_period` charge did not say which period it priced.
 * Two charges labelled "Off-peak energy" and "On-peak energy" with
 * their peak codes crossed over read identically here, publish
 * cleanly, and bill off-peak hours at the on-peak rate for ever:
 * nothing compares a free-text label against the code beside it, and
 * nothing can. Printing both is what makes the pair checkable by the
 * person who wrote it.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const base = {
  rateScheduleId: "sched-1",
  utilityId: "util-1",
  predicate: {},
  effectiveDate: "2026-01-01T00:00:00.000Z",
  expirationDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const COMPONENTS: RateComponent[] = [
  {
    ...base,
    id: "c-svc",
    kindCode: "service_charge",
    label: "Electric Service Charge",
    sortOrder: 10,
    quantitySource: { base: "fixed" },
    pricing: { type: "flat", rate: 14.5, unit: "MONTH" },
  },
  {
    ...base,
    id: "c-off",
    kindCode: "consumption",
    label: "Off-peak energy",
    sortOrder: 20,
    quantitySource: { base: "tou_period", peak_code: "off_peak" },
    pricing: { type: "flat", rate: 0.0741, unit: "KWH" },
  },
  {
    ...base,
    id: "c-mid",
    kindCode: "consumption",
    label: "Mid-peak energy",
    sortOrder: 21,
    quantitySource: { base: "tou_period", peak_code: "mid_peak" },
    pricing: { type: "flat", rate: 0.1385, unit: "KWH" },
  },
  {
    ...base,
    id: "c-on",
    kindCode: "consumption",
    label: "On-peak energy",
    sortOrder: 22,
    quantitySource: { base: "tou_period", peak_code: "peak" },
    pricing: { type: "flat", rate: 0.2648, unit: "KWH" },
  },
];

const rowFor = async (label: string) =>
  (await screen.findByText(label)).closest("tr") as HTMLElement;

const renderList = () =>
  render(
    <ToastProvider>
      <ComponentList
        scheduleId="sched-1"
        refreshKey={0}
        onEdit={vi.fn()}
        onAdd={vi.fn()}
      />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue(COMPONENTS);
});

describe("the components list", () => {
  it("prints each TOU charge's rate beside the period it prices", async () => {
    renderList();

    for (const [label, rate, code] of [
      ["Off-peak energy", "0.0741", "off_peak"],
      ["Mid-peak energy", "0.1385", "mid_peak"],
      ["On-peak energy", "0.2648", "peak"],
    ]) {
      const row = await rowFor(label);
      expect(row).toHaveTextContent(rate);
      expect(row).toHaveTextContent(code);
    }
  });

  it("does not report a period for a charge that prices none", async () => {
    renderList();

    const row = await rowFor("Electric Service Charge");
    expect(row).toHaveTextContent("14.5");
    expect(row).toHaveTextContent("fixed");
    expect(row).not.toHaveTextContent("peak");
  });

  it("names the unit the rate is per", async () => {
    renderList();

    expect(await rowFor("Off-peak energy")).toHaveTextContent("/KWH");
  });

  it("summarises a tiered charge by its tiers, not as the word tiered", async () => {
    get.mockResolvedValue([
      {
        ...base,
        id: "c-tier",
        kindCode: "consumption",
        label: "Water volumetric",
        sortOrder: 30,
        quantitySource: { base: "metered" },
        pricing: {
          type: "tiered",
          unit: "HCF",
          tiers: [
            { to: 5, rate: 2.15 },
            { to: 15, rate: 3.4 },
            { to: null, rate: 5.05 },
          ],
        },
      },
    ]);
    renderList();

    const row = await rowFor("Water volumetric");
    expect(row).toHaveTextContent("3 tiers");
    expect(row).toHaveTextContent("2.15");
    expect(row).toHaveTextContent("5.05");
    expect(row).toHaveTextContent("metered");
  });

  it("states a percent charge as its percentage", async () => {
    get.mockResolvedValue([
      {
        ...base,
        id: "c-tax",
        kindCode: "tax",
        label: "State utility tax",
        sortOrder: 90,
        quantitySource: { base: "fixed" },
        pricing: { type: "percent_of", percent: 6.5, selector: { kind: "consumption" } },
      },
    ]);
    renderList();

    const row = await rowFor("State utility tax");
    expect(row).toHaveTextContent("6.5%");
    expect(row).toHaveTextContent("consumption");
  });

  it("names the attribute a premise-attribute charge counts", async () => {
    get.mockResolvedValue([
      {
        ...base,
        id: "c-eru",
        kindCode: "service_charge",
        label: "Capacity charge",
        sortOrder: 40,
        quantitySource: { base: "premise_attribute", source_attr: "eru_count" },
        pricing: { type: "flat", rate: 8.25 },
      },
    ]);
    renderList();

    expect(await rowFor("Capacity charge")).toHaveTextContent("eru_count");
  });
});
