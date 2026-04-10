"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { apiClient } from "./api-client";

export interface ListMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface PaginatedEnvelope<T> {
  data: T[];
  meta: ListMeta;
}

interface UsePaginatedListOptions {
  /** API endpoint path, e.g. "/api/v1/customers" */
  endpoint: string;
  /** Query parameters merged into every request (undefined values are dropped). */
  params?: Record<string, string | undefined>;
  /** Items per page (default 20) */
  limit?: number;
  /**
   * Set to false if the endpoint returns a plain array instead of a
   * {data, meta} envelope (e.g. billing-cycles).
   */
  paginated?: boolean;
  /**
   * When false, the hook does not fetch. Useful for gating behind a
   * permission check: pass `enabled: canView` so the unauthorized user
   * never triggers a 403 round-trip.
   */
  enabled?: boolean;
}

export interface UsePaginatedListResult<T> {
  data: T[];
  meta: ListMeta;
  loading: boolean;
  page: number;
  setPage: (p: number) => void;
  refetch: () => Promise<void>;
}

/**
 * Shared data-fetching hook for paginated list endpoints. Owns
 * data/meta/loading/page state; the caller owns filter state and hands
 * the current filter values in via `params`. Whenever `endpoint`,
 * `page`, or any `params` value changes, the hook refetches. Unmount is
 * tracked so late-arriving responses can't setState on a dead component.
 */
export function usePaginatedList<T>({
  endpoint,
  params,
  limit = 20,
  paginated = true,
  enabled = true,
}: UsePaginatedListOptions): UsePaginatedListResult<T> {
  const [data, setData] = useState<T[]>([]);
  const [meta, setMeta] = useState<ListMeta>({ total: 0, page: 1, limit, pages: 0 });
  const [loading, setLoading] = useState(enabled);
  const [page, setPage] = useState(1);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Serialize params into a stable dependency so we refetch when any
  // filter value changes. We intentionally ignore param key order here —
  // callers pass the same shape every render.
  const paramsKey = JSON.stringify(params ?? {});

  const fetchData = useCallback(async () => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const query: Record<string, string> = paginated
        ? { page: String(page), limit: String(limit) }
        : {};
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== "") query[k] = v;
        }
      }

      if (paginated) {
        const res = await apiClient.get<PaginatedEnvelope<T>>(endpoint, query);
        if (!mountedRef.current) return;
        setData(res.data ?? []);
        setMeta(res.meta ?? { total: 0, page: 1, limit, pages: 0 });
      } else {
        const res = await apiClient.get<T[] | PaginatedEnvelope<T>>(endpoint, query);
        if (!mountedRef.current) return;
        const items = Array.isArray(res) ? res : res.data ?? [];
        setData(items);
        setMeta({ total: items.length, page: 1, limit: items.length || 1, pages: 1 });
      }
    } catch (err) {
      console.error(`Failed to fetch ${endpoint}`, err);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
    // paramsKey is a serialized dep; eslint can't see through it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, page, limit, paginated, paramsKey, enabled]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, meta, loading, page, setPage, refetch: fetchData };
}
