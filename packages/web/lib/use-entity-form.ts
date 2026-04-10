"use client";

import { useState, useCallback } from "react";
import { apiClient } from "./api-client";

interface UseEntityFormOptions<T extends Record<string, unknown>> {
  endpoint: string;
  initialValues: T;
  /**
   * Transforms the form state into the request body sent to the API.
   * Defaults to the form state as-is. Use this to drop empty strings,
   * parse numbers, or build nested structures.
   */
  toRequestBody?: (values: T) => Record<string, unknown>;
  /**
   * Called after a successful POST. The default behavior is handled by
   * the caller (usually redirect to the list page). If this returns a
   * string, the caller should navigate to that path instead.
   */
  onSuccess?: (response: unknown) => string | void;
}

export interface UseEntityFormResult<T extends Record<string, unknown>> {
  values: T;
  setValue: <K extends keyof T>(key: K, value: T[K]) => void;
  setValues: (updater: (prev: T) => T) => void;
  submitting: boolean;
  error: string | null;
  submit: () => Promise<{ ok: true; response: unknown; nextPath?: string } | { ok: false }>;
  reset: () => void;
}

/**
 * Shared state + submit machinery for entity creation forms. Owns
 * the values, submitting, and error state so callers don't have to
 * hand-roll the same useState + try/catch/finally block in every
 * /new/page.tsx. Returns a `submit` function that returns a result
 * object rather than navigating directly — the calling component
 * decides where to go next.
 */
export function useEntityForm<T extends Record<string, unknown>>({
  endpoint,
  initialValues,
  toRequestBody,
  onSuccess,
}: UseEntityFormOptions<T>): UseEntityFormResult<T> {
  const [values, setValuesState] = useState<T>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setValue = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValuesState((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setValues = useCallback((updater: (prev: T) => T) => {
    setValuesState(updater);
  }, []);

  const reset = useCallback(() => {
    setValuesState(initialValues);
    setError(null);
  }, [initialValues]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const body = toRequestBody ? toRequestBody(values) : values;
      const response = await apiClient.post(endpoint, body);
      const nextPath = onSuccess?.(response);
      return { ok: true as const, response, nextPath: nextPath || undefined };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save";
      setError(message);
      return { ok: false as const };
    } finally {
      setSubmitting(false);
    }
  }, [endpoint, values, toRequestBody, onSuccess]);

  return { values, setValue, setValues, submitting, error, submit, reset };
}
