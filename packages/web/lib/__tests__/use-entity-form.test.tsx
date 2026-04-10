import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEntityForm } from "../use-entity-form";
import { apiClient } from "../api-client";

const mockedPost = vi.mocked(apiClient.post);

interface Form extends Record<string, unknown> {
  name: string;
  count: number;
}

describe("useEntityForm", () => {
  beforeEach(() => {
    mockedPost.mockReset();
  });

  it("starts with the provided initial values and no error or submit state", () => {
    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
      }),
    );

    expect(result.current.values).toEqual({ name: "alpha", count: 0 });
    expect(result.current.submitting).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("setValue updates a single field without touching the others", () => {
    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
      }),
    );

    act(() => result.current.setValue("name", "bravo"));

    expect(result.current.values).toEqual({ name: "bravo", count: 0 });
  });

  it("setValues applies the updater to the whole record atomically", () => {
    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
      }),
    );

    act(() => result.current.setValues((prev) => ({ ...prev, name: "charlie", count: 3 })));

    expect(result.current.values).toEqual({ name: "charlie", count: 3 });
  });

  it("submit POSTs the values (or the transformed body) to the endpoint", async () => {
    mockedPost.mockResolvedValueOnce({ id: "thing-1" });

    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 5 },
        toRequestBody: (v) => ({ name: v.name.toUpperCase(), n: v.count }),
      }),
    );

    let submitResult;
    await act(async () => {
      submitResult = await result.current.submit();
    });

    expect(mockedPost).toHaveBeenCalledWith("/api/v1/things", {
      name: "ALPHA",
      n: 5,
    });
    expect(submitResult).toMatchObject({ ok: true, response: { id: "thing-1" } });
    expect(result.current.error).toBeNull();
  });

  it("onSuccess returns a nextPath that the caller can navigate to", async () => {
    mockedPost.mockResolvedValueOnce({ id: "abc" });

    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
        onSuccess: (res) => `/things/${(res as { id: string }).id}`,
      }),
    );

    let submitResult;
    await act(async () => {
      submitResult = await result.current.submit();
    });

    expect(submitResult).toEqual({
      ok: true,
      response: { id: "abc" },
      nextPath: "/things/abc",
    });
  });

  it("surfaces the error message and returns ok:false when POST rejects", async () => {
    mockedPost.mockRejectedValueOnce(new Error("409 duplicate"));

    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
      }),
    );

    let submitResult;
    await act(async () => {
      submitResult = await result.current.submit();
    });

    expect(submitResult).toEqual({ ok: false });
    await waitFor(() => expect(result.current.error).toBe("409 duplicate"));
    expect(result.current.submitting).toBe(false);
  });

  it("reset restores initial values and clears error", async () => {
    mockedPost.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() =>
      useEntityForm<Form>({
        endpoint: "/api/v1/things",
        initialValues: { name: "alpha", count: 0 },
      }),
    );

    act(() => result.current.setValue("name", "mutated"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.values.name).toBe("mutated");
    expect(result.current.error).toBe("boom");

    act(() => result.current.reset());

    expect(result.current.values).toEqual({ name: "alpha", count: 0 });
    expect(result.current.error).toBeNull();
  });
});
