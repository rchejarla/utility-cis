"use client";

import { useState } from "react";
import { pricingSchema } from "@utility-cis/shared";
import { FlatEditor } from "./pricing-editors/flat-editor";
import { TieredEditor } from "./pricing-editors/tiered-editor";
import { JsonFallbackEditor } from "./pricing-editors/json-fallback-editor";

interface Props {
  value: unknown;
  onChange: (value: unknown, valid: boolean) => void;
}

/**
 * Slice 2 task 5 — pricing editor switcher.
 *
 * Renders a structured sub-editor for the two most common pricing types
 * (flat, tiered) and falls back to the JSON-with-Zod-validation editor
 * for the other six. Tasks 6+ promote the remaining shapes to structured
 * editors; until then the JSON fallback keeps every grammar shape
 * authorable from the UI.
 *
 * The structured sub-editors emit `null` when their inputs are
 * incomplete; we map that to `(null, false)` upward so the parent can
 * disable Save. Otherwise we run pricingSchema.safeParse against the
 * assembled value to produce the validity flag.
 */
export function PricingEditor({ value, onChange }: Props) {
  const initialType = (value as { type?: string } | null)?.type ?? "flat";
  const [type, setType] = useState<string>(initialType);

  const handleStructuredChange = (v: unknown) => {
    if (!v) {
      onChange(null, false);
      return;
    }
    const result = pricingSchema.safeParse(v);
    onChange(v, result.success);
  };

  const handleTypeChange = (next: string) => {
    setType(next);
    // Switching types invalidates the previous value until the user
    // fills out the new editor; emit null/false so the parent's Save
    // button reflects the transient state.
    onChange(null, false);
  };

  const currentValue = value as { type?: string } | null;
  const flatValue =
    currentValue?.type === "flat"
      ? (currentValue as { type: "flat"; rate: number; unit?: string })
      : null;
  const tieredValue =
    currentValue?.type === "tiered"
      ? (currentValue as {
          type: "tiered";
          tiers: Array<{ to: number | null; rate: number }>;
        })
      : null;

  return (
    <div>
      <label style={labelStyle}>Pricing</label>
      <select
        value={type}
        onChange={(e) => handleTypeChange(e.target.value)}
        style={{ ...inputStyle, marginBottom: 12 }}
      >
        <option value="flat">Flat per unit</option>
        <option value="tiered">Tiered blocks</option>
        <option value="lookup">Lookup (advanced — JSON for now)</option>
        <option value="catalog">Catalog (advanced — JSON for now)</option>
        <option value="per_unit">Per unit (advanced — JSON for now)</option>
        <option value="percent_of">
          Percent of selected lines (advanced — JSON for now)
        </option>
        <option value="indexed">Indexed (advanced — JSON for now)</option>
        <option value="floor">Floor (advanced — JSON for now)</option>
      </select>

      <div>
        {type === "flat" && (
          <FlatEditor value={flatValue} onChange={handleStructuredChange} />
        )}
        {type === "tiered" && (
          <TieredEditor
            value={tieredValue}
            onChange={handleStructuredChange}
          />
        )}
        {!["flat", "tiered"].includes(type) && (
          <JsonFallbackEditor
            initialJson={JSON.stringify(value ?? { type }, null, 2)}
            schema={pricingSchema}
            onChange={(parsed, isValid) => onChange(parsed, isValid)}
            rows={8}
          />
        )}
      </div>
    </div>
  );
}

const labelStyle = {
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
