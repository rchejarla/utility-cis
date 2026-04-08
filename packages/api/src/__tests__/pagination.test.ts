import { describe, it, expect } from "vitest";
import { paginationArgs, paginatedResponse } from "../lib/pagination.js";

describe("paginationArgs", () => {
  it("returns skip=0 for page 1", () => {
    const result = paginationArgs({ page: 1, limit: 10, sort: "createdAt", order: "asc" });
    expect(result.skip).toBe(0);
    expect(result.take).toBe(10);
    expect(result.orderBy).toEqual({ createdAt: "asc" });
  });

  it("returns skip=20 for page 3 with limit 10", () => {
    const result = paginationArgs({ page: 3, limit: 10, sort: "id", order: "desc" });
    expect(result.skip).toBe(20);
    expect(result.take).toBe(10);
    expect(result.orderBy).toEqual({ id: "desc" });
  });

  it("calculates correct skip for arbitrary page and limit", () => {
    const result = paginationArgs({ page: 5, limit: 25, sort: "name", order: "asc" });
    expect(result.skip).toBe(100);
    expect(result.take).toBe(25);
  });
});

describe("paginatedResponse", () => {
  it("builds correct meta for first page", () => {
    const data = [{ id: "1" }, { id: "2" }];
    const result = paginatedResponse(data, 50, { page: 1, limit: 10, sort: "id", order: "asc" });
    expect(result.data).toBe(data);
    expect(result.meta.total).toBe(50);
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(10);
    expect(result.meta.pages).toBe(5);
  });

  it("calculates pages correctly when total is not divisible by limit", () => {
    const result = paginatedResponse([], 25, { page: 2, limit: 10, sort: "id", order: "asc" });
    expect(result.meta.pages).toBe(3);
    expect(result.meta.total).toBe(25);
    expect(result.meta.page).toBe(2);
    expect(result.meta.limit).toBe(10);
  });

  it("returns pages=0 when total is 0", () => {
    const result = paginatedResponse([], 0, { page: 1, limit: 10, sort: "id", order: "asc" });
    expect(result.meta.pages).toBe(0);
  });

  it("returns pages=1 when total equals limit", () => {
    const result = paginatedResponse([], 10, { page: 1, limit: 10, sort: "id", order: "asc" });
    expect(result.meta.pages).toBe(1);
  });
});
