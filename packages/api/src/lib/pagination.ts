import type { PaginatedResponse } from "@utility-cis/shared";

export interface PaginationParams {
  page: number;
  limit: number;
  sort: string;
  order: "asc" | "desc";
}

export function paginationArgs(params: PaginationParams) {
  return {
    skip: (params.page - 1) * params.limit,
    take: params.limit,
    orderBy: { [params.sort]: params.order },
  };
}

export function paginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams
): PaginatedResponse<T> {
  return {
    data,
    meta: {
      total,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(total / params.limit),
    },
  };
}
