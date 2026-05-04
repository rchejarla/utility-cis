"use client";

import { useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api-client";
import { useToast } from "@/components/ui/toast";
import { DatePicker } from "@/components/ui/date-picker";
import { JsonFallbackEditor } from "./pricing-editors/json-fallback-editor";
import { PricingEditor } from "./pricing-editor";
import type { RateComponent } from "./component-list";
import {
  predicateSchema,
  quantitySourceSchema,
} from "@utility-cis/shared";

interface KindOption {
  code: string;
  label: string;
}

interface Grammar {
  kinds: KindOption[];
}

interface CycleCheckResult {
  valid: boolean;
  cycle?: string[];
}

interface Props {
  scheduleId: string;
  component: RateComponent | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
}

const DEFAULT_PREDICATE = "{}";
const DEFAULT_QUANTITY_SOURCE = '{ "base": "fixed" }';
const DEFAULT_PRICING = '{ "type": "flat", "rate": 0 }';

const fieldLabelStyle = {
  fontSize: 12,
  color: "var(--text-muted)",
  display: "block",
  marginBottom: 6,
} as const;

const inputStyle = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};

const primaryBtnStyle = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "none",
  background: "var(--accent-primary)",
  color: "#fff",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryBtnStyle = {
  padding: "7px 16px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
};

function stringifyOr(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Slice 2 task 4 — ComponentEditor modal scaffold.
 *
 * Form for creating + editing a single RateComponent. Three big JSON
 * textareas back the predicate / quantitySource / pricing fields with
 * live Zod validation against the closed-grammar schemas exported from
 * @utility-cis/shared. Save flow:
 *   parse → cycle-check → POST /api/v1/rate-schedules/:id/components
 *                       (or PATCH /api/v1/rate-components/:id on edit).
 *
 * Cycle errors surface inline with the offending component path. The
 * structured editors that replace the JSON textareas land in tasks 5-7;
 * the JSON fallback stays available as an "advanced" mode after that.
 */
export function ComponentEditor({
  scheduleId,
  component,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const isEdit = component !== null;

  const [kindOptions, setKindOptions] = useState<KindOption[]>([]);
  const [kindCode, setKindCode] = useState<string>(component?.kindCode ?? "");
  const [label, setLabel] = useState<string>(component?.label ?? "");
  const [sortOrder, setSortOrder] = useState<number>(
    component?.sortOrder ?? 100,
  );
  const [effectiveDate, setEffectiveDate] = useState<string>(
    component?.effectiveDate?.slice(0, 10) ?? todayIso(),
  );
  const [expirationDate, setExpirationDate] = useState<string>(
    component?.expirationDate?.slice(0, 10) ?? "",
  );

  const initialPredicateJson = useMemo(
    () => stringifyOr(component?.predicate, DEFAULT_PREDICATE),
    [component],
  );
  const initialQuantitySourceJson = useMemo(
    () => stringifyOr(component?.quantitySource, DEFAULT_QUANTITY_SOURCE),
    [component],
  );
  // Pricing flows through the structured PricingEditor as a parsed
  // object (not a JSON string). We seed it once from the loaded
  // component, falling back to the same default flat shape we used
  // when the field was a raw JSON textarea.
  const initialPricing = useMemo<unknown>(() => {
    if (component?.pricing !== undefined && component?.pricing !== null) {
      return component.pricing;
    }
    try {
      return JSON.parse(DEFAULT_PRICING);
    } catch {
      return null;
    }
  }, [component]);

  const [predicate, setPredicate] = useState<unknown>(null);
  const [quantitySource, setQuantitySource] = useState<unknown>(null);
  const [pricing, setPricing] = useState<unknown>(initialPricing);
  const [predicateValid, setPredicateValid] = useState(false);
  const [quantitySourceValid, setQuantitySourceValid] = useState(false);
  const [pricingValid, setPricingValid] = useState(false);

  const [cycleError, setCycleError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingKinds, setLoadingKinds] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .get<Grammar>("/api/v1/rate-grammar/registered")
      .then((g) => {
        if (cancelled) return;
        setKindOptions(g.kinds ?? []);
        // Default the kind dropdown to the first option in create mode
        // so the form is submittable without an explicit selection step.
        if (!isEdit && (g.kinds?.length ?? 0) > 0 && !kindCode) {
          setKindCode(g.kinds[0]!.code);
        }
      })
      .catch((err) => {
        toast(
          err instanceof Error ? err.message : "Failed to load rate kinds",
          "error",
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingKinds(false);
      });
    return () => {
      cancelled = true;
    };
    // toast is stable; kindCode/isEdit only matter on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allValid =
    predicateValid &&
    quantitySourceValid &&
    pricingValid &&
    kindCode.trim().length > 0 &&
    label.trim().length > 0 &&
    effectiveDate.length > 0;

  async function handleSave() {
    if (!allValid) return;
    setCycleError(null);
    setSaving(true);
    try {
      // Step 1: cycle-check. The detector needs the full proposed shape
      // (predicate / quantitySource / pricing) because forward references
      // can hide inside any of those — only the engine knows where.
      const cycleRes = await apiClient.post<CycleCheckResult>(
        `/api/v1/rate-schedules/${scheduleId}/cycle-check`,
        {
          componentId: component?.id ?? null,
          kindCode,
          label,
          predicate,
          quantitySource,
          pricing,
          sortOrder,
        },
      );
      if (!cycleRes.valid) {
        const path = cycleRes.cycle?.join(" → ") ?? "(unknown path)";
        setCycleError(`Cycle detected: ${path}`);
        return;
      }

      // Step 2: persist.
      const payload: Record<string, unknown> = {
        kindCode,
        label,
        predicate,
        quantitySource,
        pricing,
        sortOrder,
        effectiveDate,
      };
      if (expirationDate) payload.expirationDate = expirationDate;

      if (isEdit && component) {
        await apiClient.patch(
          `/api/v1/rate-components/${component.id}`,
          payload,
        );
        toast("Component updated", "success");
      } else {
        await apiClient.post(
          `/api/v1/rate-schedules/${scheduleId}/components`,
          payload,
        );
        toast("Component created", "success");
      }
      onSaved();
    } catch (err) {
      // The cycle-check route returns 400 with `{ valid: false, cycle: [...] }`
      // — apiClient throws on non-2xx, so we surface the raw message rather
      // than try to parse the body out of the Error here. The dedicated
      // cycle-check call above handles the happy 400 path; this catch is
      // the create/update failure path.
      const msg =
        err instanceof Error
          ? err.message.replace(/^API error \d+:\s*/, "")
          : isEdit
            ? "Failed to update component"
            : "Failed to create component";
      // If the message looks like a cycle response from a race (unlikely
      // but possible), show it inline; otherwise toast.
      if (msg.toLowerCase().includes("cycle")) {
        setCycleError(msg);
      } else {
        toast(msg, "error");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          width: "100%",
          maxWidth: 720,
          maxHeight: "calc(100vh - 48px)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: "var(--text-primary)",
            }}
          >
            {isEdit ? "Edit Component" : "Add Component"}
          </h3>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            Predicate / quantity source / pricing use the closed-grammar
            JSON shapes. Structured editors land in tasks 5-7.
          </p>
        </div>

        <div
          style={{
            padding: "20px 24px",
            overflowY: "auto",
            flex: 1,
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div>
              <label style={fieldLabelStyle}>Kind</label>
              <select
                value={kindCode}
                onChange={(e) => setKindCode(e.target.value)}
                disabled={loadingKinds}
                style={inputStyle}
              >
                {loadingKinds && <option value="">Loading…</option>}
                {!loadingKinds && kindOptions.length === 0 && (
                  <option value="">(no kinds available)</option>
                )}
                {kindOptions.map((k) => (
                  <option key={k.code} value={k.code}>
                    {k.label} ({k.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={fieldLabelStyle}>Sort Order</label>
              <input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
                style={inputStyle}
                min={0}
                step={1}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={fieldLabelStyle}>Label</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Tier 1 Volumetric"
              style={inputStyle}
            />
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <div>
              <label style={fieldLabelStyle}>Effective Date</label>
              <DatePicker
                value={effectiveDate}
                onChange={(v) => setEffectiveDate(v)}
              />
            </div>
            <div>
              <label style={fieldLabelStyle}>Expiration Date (optional)</label>
              <DatePicker
                value={expirationDate}
                onChange={(v) => setExpirationDate(v)}
              />
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <JsonFallbackEditor
              label="Predicate"
              initialJson={initialPredicateJson}
              schema={predicateSchema}
              onChange={(parsed, valid) => {
                setPredicate(parsed);
                setPredicateValid(valid);
              }}
              rows={6}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <JsonFallbackEditor
              label="Quantity Source"
              initialJson={initialQuantitySourceJson}
              schema={quantitySourceSchema}
              onChange={(parsed, valid) => {
                setQuantitySource(parsed);
                setQuantitySourceValid(valid);
              }}
              rows={6}
            />
          </div>

          <div style={{ marginBottom: 4 }}>
            <PricingEditor
              value={initialPricing}
              onChange={(parsed, valid) => {
                setPricing(parsed);
                setPricingValid(valid);
              }}
            />
          </div>

          {cycleError && (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--danger, #dc2626)",
                background: "rgba(220, 38, 38, 0.08)",
                color: "var(--danger, #dc2626)",
                fontSize: 12,
              }}
            >
              {cycleError}
            </div>
          )}
        </div>

        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              ...secondaryBtnStyle,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !allValid}
            style={{
              ...primaryBtnStyle,
              opacity: saving || !allValid ? 0.6 : 1,
              cursor: saving || !allValid ? "not-allowed" : "pointer",
            }}
          >
            {saving
              ? isEdit
                ? "Saving…"
                : "Creating…"
              : isEdit
                ? "Save Changes"
                : "Create Component"}
          </button>
        </div>
      </div>
    </div>
  );
}
