"use client";

import { useEffect, useState } from "react";
import { MoneyInput } from "./money-input";
import { UnitPicker, type UnitOptionGroup } from "./unit-picker";

interface FlatValue {
  type: "flat";
  rate: number;
  unit?: string;
}

interface Props {
  value: FlatValue | null;
  onChange: (value: FlatValue | null) => void;
  unitOptions: UnitOptionGroup[];
}

/**
 * Slice 2 task 5 — structured editor for `pricing.type === "flat"`.
 *
 * Two inputs: a numeric rate and an optional unit label. The rate is the
 * only required field; while it parses to a finite number we emit the
 * full shape, otherwise we emit `null` so the parent treats pricing as
 * incomplete and disables Save.
 */
export function FlatEditor({ value, onChange, unitOptions }: Props) {
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
        <span style={labelStyle}>Rate</span>
        <MoneyInput value={rate} onChange={setRate} ariaLabel="Rate" />
      </div>
      <div style={{ flex: 1 }}>
        <UnitPicker value={unit} onChange={setUnit} groups={unitOptions} />
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

