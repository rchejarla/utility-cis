import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiClient } from "@/lib/api-client";
import ImportsPage from "../page";

/**
 * The imports page, and the question it could not answer: how do I
 * start one?
 *
 * It is reached from the sidebar's "Imports" entry, which is where
 * anybody looks, and it listed history only. The sole affordance was a
 * 12px muted footnote under the table — "Start a new import from the
 * entity-specific page (e.g. /meter-reads/import)" — naming one of six
 * kinds and leaving the rest as URLs you had to know.
 *
 * So the menu is built from `GET /imports/kinds`, where each handler
 * declares its own `wizardPath`. The list is the registry's, not a copy
 * of it: a seventh kind appears here on registration, which is the
 * whole reason the path is declared server-side.
 */

const get = apiClient.get as unknown as ReturnType<typeof vi.fn>;

const KINDS = [
  { kind: "meter_read", label: "Meter reads", module: "meter_reads", permission: "CREATE", wizardPath: "/meter-reads/import" },
  { kind: "customer", label: "Customers", module: "customers", permission: "CREATE", wizardPath: "/customers/import" },
  { kind: "premise", label: "Premises", module: "premises", permission: "CREATE", wizardPath: "/premises/import" },
  { kind: "service_agreement", label: "Service agreements", module: "agreements", permission: "CREATE", wizardPath: "/service-agreements/import" },
];

function routeGets(opts: { kinds?: unknown[]; batches?: unknown[] } = {}) {
  get.mockImplementation((path: string) => {
    if (path === "/api/v1/imports/kinds") return Promise.resolve(opts.kinds ?? KINDS);
    if (path === "/api/v1/imports") {
      return Promise.resolve({
        data: opts.batches ?? [],
        meta: { total: (opts.batches ?? []).length, page: 1, limit: 20, pages: 1 },
      });
    }
    return Promise.resolve({ data: [], meta: { total: 0, page: 1, limit: 20, pages: 0 } });
  });
}

async function renderPage() {
  await act(async () => {
    render(<ImportsPage />);
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

describe("Imports page — starting one", () => {
  it("offers a New import control", async () => {
    routeGets();
    await renderPage();

    expect(await screen.findByRole("button", { name: /new import/i })).toBeInTheDocument();
  });

  it("lists every registered kind, linked to its own wizard", async () => {
    routeGets();
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /new import/i }));

    for (const k of KINDS) {
      const link = screen.getByRole("link", { name: k.label });
      expect(link).toHaveAttribute("href", k.wizardPath);
    }
  });

  it("takes the list from the registry, so a kind it has never heard of still appears", async () => {
    // The point of serving `wizardPath`: this page holds no map of its
    // own, so a kind added in the API needs no edit here.
    routeGets({
      kinds: [
        {
          kind: "solid_waste_container",
          label: "Containers",
          module: "solid_waste",
          permission: "CREATE",
          wizardPath: "/containers/import",
        },
      ],
    });
    await renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /new import/i }));

    expect(screen.getByRole("link", { name: "Containers" })).toHaveAttribute(
      "href",
      "/containers/import",
    );
  });

  it("drops the footnote that named one kind out of six", async () => {
    routeGets();
    await renderPage();

    expect(
      screen.queryByText(/start a new import from the entity-specific page/i),
    ).not.toBeInTheDocument();
  });
});
