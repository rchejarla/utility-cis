import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { apiClient } from "@/lib/api-client";
import CustomersPage from "../page";

/**
 * A tenant with no rows yet can still bulk-load.
 *
 * `EntityListPage` suppresses its whole header action group while the
 * empty-state CTA is showing (`canCreate && !showEmptyCta && …`), and
 * that CTA took a single action — the Add one. So on a fresh tenant
 * every entity page offered "Add Customer" and nothing else, and the
 * import feature was invisible at the exact moment somebody has a file
 * of a thousand customers and no desire to type them in.
 *
 * That is not a cosmetic gap: a new utility's first interaction with
 * this product is a migration, so the empty state is the *most*
 * important place for the import to appear, not the least.
 *
 * The customers page stands in for the five that pass `importHref`;
 * what it proves is `EntityListPage`'s wiring, which they share.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

function emptyList() {
  get.mockImplementation(() =>
    Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 20, pages: 0 } }),
  );
}

function oneRow() {
  get.mockImplementation(() =>
    Promise.resolve({
      data: [
        {
          id: "c-1",
          customerType: "INDIVIDUAL",
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          status: "ACTIVE",
          createdAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      meta: { total: 1, page: 1, limit: 20, pages: 1 },
    }),
  );
}

async function renderPage() {
  await act(async () => {
    render(<CustomersPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

/*
 * No `vi.restoreAllMocks()` here. It restores the mocks the setup file
 * installs too — `window.matchMedia` among them, which jsdom does not
 * implement and `useBreakpoint` calls — so every case after the first
 * died on "Cannot read properties of undefined (reading 'matches')" in
 * a component that has nothing to do with what is under test.
 * `clearAllMocks` in `beforeEach` is what per-case isolation needs.
 */

describe("Customers — the import is reachable from an empty list", () => {
  it("offers the import beside the add action when there is nothing yet", async () => {
    emptyList();
    await renderPage();

    const link = await screen.findByRole("link", { name: /import/i });
    expect(link).toHaveAttribute("href", "/customers/import");
  });

  it("still offers the add action, which stays the primary one", async () => {
    emptyList();
    await renderPage();

    const add = await screen.findByRole("link", { name: /add customer/i });
    expect(add).toHaveAttribute("href", "/customers/new");
  });

  it("offers the import from the header once rows exist", async () => {
    oneRow();
    await renderPage();

    const link = await screen.findByRole("link", { name: /^import$/i });
    expect(link).toHaveAttribute("href", "/customers/import");
  });
});
