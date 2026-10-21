"use client";

import { useState, useEffect, useCallback } from "react";
import { apiClient } from "@/lib/api-client";
import type { ClusterReport } from "./types";

/**
 * The one read all three Cluster pages make.
 *
 * A hook rather than three copies of the same `useEffect`, and a
 * `reload` rather than a refetch interval: these numbers are a snapshot
 * by nature — a count can change between being drawn and being clicked —
 * and the pages say so where it matters rather than chasing live values.
 */
export function useCluster(): {
  report: ClusterReport | null;
  error: string | null;
  reload: () => void;
  /** Replace the report in place, for a start or stop that just happened. */
  setReport: (next: (r: ClusterReport) => ClusterReport) => void;
} {
  const [report, setState] = useState<ClusterReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    apiClient
      .get<ClusterReport>("/api/v1/platform/queues")
      .then((data) => {
        if (live) setState(data);
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Failed to load the cluster");
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const setReport = useCallback((next: (r: ClusterReport) => ClusterReport) => {
    setState((r) => (r ? next(r) : r));
  }, []);

  return { report, error, reload: () => setNonce((n) => n + 1), setReport };
}
