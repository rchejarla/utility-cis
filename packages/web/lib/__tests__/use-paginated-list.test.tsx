import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePaginatedList } from "../use-paginated-list";
import { apiClient } from "../api-client";

const mockedGet = vi.mocked(apiClient.get);

function envelope<T>(data: T[], total = data.length, page = 1, limit = 20) {
  return { data, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
}

describe("usePaginatedList", () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("fetches on mount and populates data + meta", async () => {
    mockedGet.mockResolvedValueOnce(envelope([{ id: "1" }, { id: "2" }], 42));

    const { result } = renderHook(() =>
      usePaginatedList<{ id: string }>({ endpoint: "/api/v1/customers" })
    );

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.meta.total).toBe(42);
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/customers", {
      page: "1",
      limit: "20",
    });
  });

  it("drops undefined and empty-string params from the query", async () => {
    mockedGet.mockResolvedValue(envelope([]));

    renderHook(() =>
      usePaginatedList({
        endpoint: "/api/v1/customers",
        params: { status: "ACTIVE", search: "", type: undefined },
      })
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/customers", {
      page: "1",
      limit: "20",
      status: "ACTIVE",
    });
  });

  it("refetches when params change", async () => {
    mockedGet.mockResolvedValue(envelope([]));

    const { rerender } = renderHook(
      ({ status }: { status?: string }) =>
        usePaginatedList({
          endpoint: "/api/v1/customers",
          params: { status },
        }),
      { initialProps: { status: undefined as string | undefined } }
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));

    rerender({ status: "ACTIVE" });
    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));

    expect(mockedGet).toHaveBeenLastCalledWith(
      "/api/v1/customers",
      expect.objectContaining({ status: "ACTIVE" })
    );
  });

  it("refetches with the new page when setPage is called", async () => {
    mockedGet.mockResolvedValue(envelope([]));

    const { result } = renderHook(() =>
      usePaginatedList({ endpoint: "/api/v1/customers" })
    );

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(1));

    act(() => result.current.setPage(3));

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
    expect(mockedGet).toHaveBeenLastCalledWith(
      "/api/v1/customers",
      expect.objectContaining({ page: "3" })
    );
  });

  it("handles unpaginated endpoints (plain array responses)", async () => {
    mockedGet.mockResolvedValueOnce([{ id: "a" }, { id: "b" }, { id: "c" }]);

    const { result } = renderHook(() =>
      usePaginatedList({ endpoint: "/api/v1/billing-cycles", paginated: false })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(3);
    expect(result.current.meta.total).toBe(3);
    // Unpaginated endpoints should NOT get page/limit query params
    expect(mockedGet).toHaveBeenCalledWith("/api/v1/billing-cycles", {});
  });

  it("does not setState after unmount when response arrives late", async () => {
    let resolveFn: (value: unknown) => void = () => {};
    mockedGet.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );

    const { unmount } = renderHook(() =>
      usePaginatedList({ endpoint: "/api/v1/customers" })
    );

    // Unmount BEFORE the response resolves
    unmount();

    // Now let the promise resolve — should not throw or warn about
    // setState on unmounted component
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    resolveFn(envelope([{ id: "1" }]));
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("logs and leaves loading false when the endpoint errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedGet.mockRejectedValueOnce(new Error("500 boom"));

    const { result } = renderHook(() =>
      usePaginatedList({ endpoint: "/api/v1/customers" })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(errorSpy).toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    errorSpy.mockRestore();
  });
});
