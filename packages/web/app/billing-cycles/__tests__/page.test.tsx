import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@/components/ui/toast";
import { apiClient } from "@/lib/api-client";
import BillingCyclesPage from "../page";

/**
 * The billing cycle list, and the field it reads.
 *
 * Every cycle on this screen showed as Inactive while the database said
 * otherwise, because the page read `row.isActive` and the API sends
 * `active`. An undefined field is falsy, so the bug could not fail
 * loudly — it rendered the wrong word with total confidence, on the one
 * column that decides whether a cycle can be billed at all.
 *
 * The case below is pinned to the API's own spelling for that reason: a
 * screen that reads a field the backend never sends is invisible to
 * typechecking (the interface declared `isActive` too, so both halves
 * agreed with each other and neither with the server).
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function cycle(over: Record<string, unknown> = {}) {
  return {
    id: "cyc-1",
    name: "Route 1 - North District",
    cycleCode: "R01",
    readDayOfMonth: 8,
    billDayOfMonth: 10,
    frequency: "MONTHLY",
    // The API's spelling. Renaming this to `isActive` should fail the
    // test below, which is the whole point of it.
    active: true,
    ...over,
  };
}

function payload(rows: unknown[]) {
  return { data: rows, meta: { total: rows.length, page: 1, limit: 25, pages: 1 } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * No `restoreAllMocks` here, deliberately. The list renders through
 * DataTable, whose breakpoint hook reads `window.matchMedia` — stubbed
 * once in vitest.setup as a plain `vi.fn()`. Restoring every mock after
 * the first case strips that implementation, and the next case dies on
 * `undefined.matches` rather than on anything it was testing. Nothing in
 * this file spies, so there is nothing to restore.
 */

describe("Billing cycles list", () => {
  it("shows an active cycle as active, reading the field the API sends", async () => {
    get.mockResolvedValue(payload([cycle()]));
    render(
      <ToastProvider>
        <BillingCyclesPage />
      </ToastProvider>,
    );

    await screen.findByText("Route 1 - North District");
    expect(screen.getByText("✓ Active")).toBeInTheDocument();
    expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
  });

  it("shows a deactivated cycle as inactive", async () => {
    get.mockResolvedValue(payload([cycle({ active: false })]));
    render(
      <ToastProvider>
        <BillingCyclesPage />
      </ToastProvider>,
    );

    await screen.findByText("Route 1 - North District");
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.queryByText("✓ Active")).not.toBeInTheDocument();
  });

  it("states the read day and the bill day together, since one bounds the other", async () => {
    get.mockResolvedValue(payload([cycle()]));
    render(
      <ToastProvider>
        <BillingCyclesPage />
      </ToastProvider>,
    );

    await screen.findByText("Route 1 - North District");
    expect(screen.getByText(/read 8/)).toBeInTheDocument();
    expect(screen.getByText(/bill 10/)).toBeInTheDocument();
  });
});
