import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EntityListPage } from "../entity-list-page";
import type { Column } from "../data-table";
import { apiClient } from "@/lib/api-client";

const mockedGet = vi.mocked(apiClient.get);

interface Widget {
  id: string;
  name: string;
  status: string;
}

const columns: Column<Widget>[] = [
  { key: "name", header: "Name", render: (row) => <span>{row.name}</span> },
  { key: "status", header: "Status", render: (row) => <span data-testid="status">{row.status}</span> },
];

function envelope(data: Widget[], total = data.length, page = 1, limit = 20) {
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

const rows: Widget[] = [
  { id: "w1", name: "Alpha", status: "ACTIVE" },
  { id: "w2", name: "Bravo", status: "INACTIVE" },
];

const baseProps = {
  title: "Widgets",
  subject: "widgets",
  module: "widgets",
  endpoint: "/api/v1/widgets",
  getDetailHref: (row: Widget) => `/widgets/${row.id}`,
  columns,
};

describe("EntityListPage", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("renders title, subtitle, and list rows fetched from the endpoint", async () => {
    mockedGet.mockResolvedValueOnce(envelope(rows, 2));

    render(<EntityListPage<Widget> {...baseProps} />);

    expect(screen.getByText("Widgets")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Bravo")).toBeInTheDocument();
    });
    expect(screen.getByText(/2 total widgets/i)).toBeInTheDocument();
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/widgets", {
      page: "1",
      limit: "20",
    });
  });

  it("debounces the prominent search input before updating the query param", async () => {
    mockedGet.mockResolvedValue(envelope(rows, 2));
    const user = userEvent.setup();

    render(
      <EntityListPage<Widget>
        {...baseProps}
        search={{
          paramKey: "search",
          variant: "prominent",
          debounceMs: 100,
          placeholder: "Search widgets...",
        }}
      />
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText("Search widgets...");
    await user.type(input, "acme");

    // Mid-debounce: still only the initial fetch
    expect(mockedGet).toHaveBeenCalledTimes(1);

    // Wait for the debounced fetch to land
    await waitFor(
      () => expect(mockedGet).toHaveBeenCalledTimes(2),
      { timeout: 1000 }
    );
    expect(mockedGet).toHaveBeenLastCalledWith(
      "/api/v1/widgets",
      expect.objectContaining({ search: "acme", page: "1" })
    );
  });

  it("fires the search query immediately in compact variant (no debounce)", async () => {
    mockedGet.mockResolvedValue(envelope(rows, 2));
    const user = userEvent.setup();

    render(
      <EntityListPage<Widget>
        {...baseProps}
        search={{
          paramKey: "accountNumber",
          variant: "compact",
          placeholder: "Search...",
        }}
      />
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));

    const input = screen.getByPlaceholderText("Search...");
    await user.type(input, "A");

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
    expect(mockedGet).toHaveBeenLastCalledWith(
      "/api/v1/widgets",
      expect.objectContaining({ accountNumber: "A" })
    );
  });

  it("applies a static filter and resets page to 1 on change", async () => {
    mockedGet.mockResolvedValue(envelope(rows, 2));
    const user = userEvent.setup();

    render(
      <EntityListPage<Widget>
        {...baseProps}
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { label: "Active", value: "ACTIVE" },
              { label: "Inactive", value: "INACTIVE" },
            ],
          },
        ]}
      />
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));

    // Open the filter pill and click "Active"
    await user.click(screen.getByRole("button", { name: /Status/i }));
    await user.click(await screen.findByText("Active"));

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
    expect(mockedGet).toHaveBeenLastCalledWith(
      "/api/v1/widgets",
      expect.objectContaining({ status: "ACTIVE", page: "1" })
    );
  });

  it("fetches dynamic filter options from the configured endpoint and populates the pill", async () => {
    mockedGet.mockImplementation(async (path: string) => {
      if (path === "/api/v1/widgets") return envelope(rows, 2);
      if (path === "/api/v1/commodities") {
        return { data: [{ id: "c1", name: "Water" }, { id: "c2", name: "Electric" }] };
      }
      throw new Error(`unexpected endpoint ${path}`);
    });
    const user = userEvent.setup();

    render(
      <EntityListPage<Widget>
        {...baseProps}
        filters={[
          {
            key: "commodityId",
            label: "Commodity",
            optionsEndpoint: "/api/v1/commodities",
            mapOption: (c) => ({ label: String(c.name), value: String(c.id) }),
          },
        ]}
      />
    );

    // Both fetches happen: the list AND the dynamic options
    await waitFor(() => {
      expect(mockedGet).toHaveBeenCalledWith("/api/v1/widgets", expect.any(Object));
      expect(mockedGet).toHaveBeenCalledWith("/api/v1/commodities", undefined);
    });

    // Open the pill and confirm fetched options are shown
    await user.click(await screen.findByRole("button", { name: /Commodity/i }));
    expect(await screen.findByText("Water")).toBeInTheDocument();
    expect(screen.getByText("Electric")).toBeInTheDocument();
  });

  it("requests the unpaginated endpoint without page/limit params when paginated=false", async () => {
    mockedGet.mockResolvedValueOnce([
      { id: "1", name: "One", status: "ACTIVE" },
    ]);

    render(<EntityListPage<Widget> {...baseProps} paginated={false} />);

    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/widgets", {});
  });

  it("renders the headerSlot above the filter bar", async () => {
    mockedGet.mockResolvedValueOnce(envelope(rows, 2));

    render(
      <EntityListPage<Widget>
        {...baseProps}
        headerSlot={<div data-testid="stats">STATS HERE</div>}
      />
    );

    await waitFor(() => expect(screen.getByTestId("stats")).toBeInTheDocument());
    expect(screen.getByTestId("stats")).toHaveTextContent("STATS HERE");
  });

  it("hides the Add action when newAction is omitted", async () => {
    mockedGet.mockResolvedValue(envelope(rows, 2));

    const { rerender } = render(<EntityListPage<Widget> {...baseProps} />);
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.queryByText(/Add Widget/i)).not.toBeInTheDocument();

    rerender(
      <EntityListPage<Widget>
        {...baseProps}
        newAction={{ label: "Add Widget", href: "/widgets/new" }}
      />
    );
    expect(await screen.findByText(/Add Widget/i)).toBeInTheDocument();
  });
});

describe("EntityListPage permission gate", () => {
  it("renders AccessDenied (not the page title) when the module is not permitted", async () => {
    // Stub the endpoint so the background fetch still resolves cleanly —
    // usePaginatedList runs before the canView branch because hooks must
    // be called unconditionally.
    mockedGet.mockResolvedValue(envelope([]));

    const permModule = await import("@/lib/use-permission");
    vi.spyOn(permModule, "usePermission").mockReturnValue({
      canView: false,
      canCreate: false,
      canEdit: false,
      canDelete: false,
    });

    render(<EntityListPage<Widget> {...baseProps} />);

    // Wait for any background effects to settle, then assert the header
    // is absent (AccessDenied is the only thing shown).
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Widgets" })).not.toBeInTheDocument();
    });

    vi.mocked(permModule.usePermission).mockRestore();
  });
});
