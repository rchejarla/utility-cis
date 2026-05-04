"use client";

import { useEffect, useState } from "react";

interface FlatValue {
  type: "flat";
  rate: number;
  unit?: string;
}

interface Props {
  value: FlatValue | null;
  onChange: (value: FlatValue | null) => void;
}

/**
 * Slice 2 task 5 — structured editor for `pricing.type === "flat"`.
 *
 * Two inputs: a numeric rate and an optional unit label. The rate is the
 * only required field; while it parses to a finite number we emit the
 * full shape, otherwise we emit `null` so the parent treats pricing as
 * incomplete and disables Save.
 */
export function FlatEditor({ value, onChange }: Props) {
  const [rate, setRate] = useState<string>(
    value?.rate !== undefined ? String(value.rate) : "",
  );
  const [unit, setUnit] = useState<string>(value?.unit ?? "");

  useEffect(() => {
    const r = parseFloat(rate);
    if (!Number.isFinite(r)) {
      onChange(null);
      return;
    }
    const v: FlatValue = { type: "flat", rate: r };
    if (unit) v.unit = unit;
    onChange(v);
    // onChange is stable in practice; only re-emit when the inputs change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate, unit]);

  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ flex: 1 }}>
        <label style={labelStyle}>Rate</label>
        <input
          type="number"
          step="0.0001"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          style={inputStyle}
        />
      </div>
      <div style={{ flex: 1 }}>
        <label style={labelStyle}>Unit (optional)</label>
        <input
          type="text"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="e.g. HCF, kWh"
          style={inputStyle}
        />
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
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};
