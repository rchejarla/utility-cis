import type { PaginatedResponse } from "@utility-cis/shared";

export interface PaginationParams {
  page: number;
  limit: number;
  sort: string;
  order: "asc" | "desc";
}

/**
 * Build Prisma pagination args. If `allowedSorts` is provided, sort values
 * outside the allowlist fall back to the first allowed value. This prevents
 * attacker-controlled orderBy keys from reaching Prisma.
 */
export function paginationArgs(
  params: PaginationParams,
  allowedSorts?: readonly string[]
) {
  let sort = params.sort;
  if (allowedSorts && allowedSorts.length > 0 && !allowedSorts.includes(sort)) {
    sort = allowedSorts[0];
  }
  return {
    skip: (params.page - 1) * params.limit,
    take: params.limit,
    orderBy: { [sort]: params.order },
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

/**
 * Runs a paginated list query against a Prisma model delegate: builds
 * `findMany` + `count` in parallel from a single `where`, applies standard
 * pagination args, and returns a `PaginatedResponse`. Every listX service
 * was re-implementing this exact 5-line block; this collapses it into one
 * call so the only thing a service hand-rolls is its filter construction.
 */
// Prisma model delegates have deeply generic, per-model signatures for
// findMany/count, so this helper accepts a structural `any`-shaped delegate
// and returns `PaginatedResponse<unknown>`. Callers get the concrete row
// type back via a narrow generic that trusts the caller's Prisma query.
// Safety comes from the compile-time checks on the `where` and `include`
// the caller constructs, not from the delegate type here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrismaDelegate = {
  findMany: (args: any) => Promise<any>;
  count: (args: any) => Promise<number>;
};

export async function paginatedTenantList<T>(
  delegate: AnyPrismaDelegate,
  where: Record<string, unknown>,
  params: PaginationParams,
  options?: {
    include?: Record<string, unknown>;
    allowedSorts?: readonly string[];
  }
): Promise<PaginatedResponse<T>> {
  const args = paginationArgs(params, options?.allowedSorts);
  const findArgs: Record<string, unknown> = { where, ...args };
  if (options?.include) findArgs.include = options.include;

  const [data, total] = await Promise.all([
    delegate.findMany(findArgs) as Promise<T[]>,
    delegate.count({ where }),
  ]);
  return paginatedResponse(data, total, params);
}
