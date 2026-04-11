"use client";

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";

/**
 * Load one namespace of TenantConfig.settings (e.g. "branding" or
 * "retention"), expose its current value as a typed draft, and let the
 * caller save it back via PATCH /api/v1/tenant-config.
 *
 * The server shallow-merges the patched namespace into the existing
 * settings bucket, so unrelated namespaces are preserved automatically.
 *
 * `defaults` is what to render when the tenant has never saved this
 * namespace before — used so placeholder values stay consistent with
 * what was shown before persistence was wired up.
 */
interface TenantConfigResponse {
  settings: Record<string, unknown>;
}

export function useTenantSettingsNamespace<
  Key extends string,
  Shape extends Record<string, unknown>,
>(namespace: Key, defaults: Shape) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Shape>(defaults);
  const [saved, setSaved] = useState<Shape>(defaults);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await apiClient.get<TenantConfigResponse>("/api/v1/tenant-config");
        if (cancelled) return;
        const current = (cfg.settings?.[namespace] as Shape | undefined) ?? defaults;
        const merged = { ...defaults, ...current };
        setDraft(merged);
        setSaved(merged);
      } catch (err) {
        if (!cancelled) {
          toast(err instanceof Error ? err.message : "Failed to load settings", "error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // defaults is intentionally omitted — callers should pass a stable
    // object; including it would cause a reload loop if they inline it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, toast]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await apiClient.patch("/api/v1/tenant-config", { [namespace]: draft });
      setSaved(draft);
      toast("Settings saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  }, [namespace, draft, toast]);

  const reset = useCallback(() => {
    setDraft(saved);
  }, [saved]);

  return { loading, saving, draft, setDraft, isDirty, save, reset };
}
