"use client";

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";

/**
 * Hook for fetching tenant-visible type definitions (globals + tenant-
 * specific) from a reference-table endpoint. Used by the Premise and
 * Account create/edit forms and list filters so the available options
 * always match what the operator configured under Configuration →
 * <Type> Types.
 *
 * The shape returned by /premise-types and /account-types is the same
 * (PremiseTypeDefDTO ≈ AccountTypeDefDTO), so a single hook covers
 * both.
 */

export interface TypeDef {
  id: string;
  code: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  isGlobal: boolean;
}

function useTypeDefs(endpoint: string): { types: TypeDef[]; loading: boolean } {
  const [types, setTypes] = useState<TypeDef[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<{ data: TypeDef[] }>(endpoint)
      .then((res) => {
        if (!cancelled) setTypes(res.data ?? []);
      })
      .catch(() => {
        // Fall back to an empty list — caller can render a friendly
        // "no types defined" hint.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint]);
  return { types, loading };
}

export function usePremiseTypes() {
  return useTypeDefs("/api/v1/premise-types");
}

export function useAccountTypes() {
  return useTypeDefs("/api/v1/account-types");
}
