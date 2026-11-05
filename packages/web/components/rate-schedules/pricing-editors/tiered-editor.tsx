"use client";

import { useEffect, useState } from "react";
import { MoneyInput } from "./money-input";
import { UnitPicker, type UnitOptionGroup } from "./unit-picker";

interface Tier {
  to: number | null;
  rate: number;
}

interface TieredValue {
  type: "tiered";
  tiers: Tier[];
  unit?: string;
  /**
   * Edited nowhere in this form and carried through untouched. It
   * scales each tier's threshold by the days actually billed (Bozeman
   * Req 138), so dropping it silently turns a prorated allowance back
   * into a full period's and changes what the customer owes. It used
   * to be dropped: this editor read only `tiers` and re-emitted only
   * `tiers`, so a save through the form erased everything else in the
   * shape.
   */
  standard_days?: number;
}

interface Props {
  value: TieredValue | null;
  onChange: (value: TieredValue | null) => void;
  unitOptions: UnitOptionGroup[];
}

/**
 * Slice 2 task 5 — structured editor for `pricing.type === "tiered"`.
 *
 * Dynamic table of `{ to, rate }` rows. Blank `to` means the tier is
 * unbounded — typically used on the final row to represent "everything
 * above the previous threshold." Any non-numeric rate (or non-blank
 * non-numeric `to`) collapses the whole value to `null` so the parent
 * blocks Save until the user fills the gap.
 */
export function TieredEditor({ value, onChange, unitOptions }: Props) {
  const [tiers, setTiers] = useState<Array<{ to: string; rate: string }>>(
    value?.tiers.map((t) => ({
      to: t.to === null ? "" : String(t.to),
      rate: String(t.rate),
    })) ?? [{ to: "", rate: "" }],
  );
  const [unit, setUnit] = useState<string>(value?.unit ?? "");
  // Read once, from the value this editor opened on: it has no input,
  // so nothing in the form can change it, and re-reading `value` would
  // fight the parent's re-render of what we just emitted.
  const [standardDays] = useState<number | undefined>(value?.standard_days);

  useEffect(() => {
    const parsed: Tier[] = [];
    for (const t of tiers) {
      const rate = parseFloat(t.rate);
      if (!Number.isFinite(rate)) {
        onChange(null);
        return;
      }
      const to = t.to.trim() === "" ? null : parseFloat(t.to);
      if (to !== null && !Number.isFinite(to)) {
        onChange(null);
        return;
      }
      parsed.push({ to, rate });
    }
    if (parsed.length === 0) {
      onChange(null);
      return;
    }
    // Same rule as the flat editor: the bill line has to name what it
    // counted, so a blank unit holds Save.
    if (!unit) {
      onChange(null);
      return;
    }
    const next: TieredValue = { type: "tiered", tiers: parsed, unit };
    if (standardDays !== undefined) next.standard_days = standardDays;
    onChange(next);
    // onChange is stable; only re-emit when the rows change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiers, unit, standardDays]);

  const updateRow = (idx: number, field: "to" | "rate", v: string) => {
    setTiers((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, [field]: v } : t)),
    );
  };
  const addRow = () =>
    setTiers((prev) => [...prev, { to: "", rate: "" }]);
  const removeRow = (idx: number) =>
    setTiers((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Up to (blank = unbounded)</th>
            <th style={thStyle}>
              Rate
              <span aria-hidden="true" style={{ color: "var(--danger)", marginLeft: 3 }}>
                *
              </span>
            </th>
            <th style={{ ...thStyle, width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {tiers.map((t, idx) => (
            <tr key={idx}>
              <td style={tdStyle}>
                {/* A quantity of the priced thing — HCF, kWh — not money. */}
                <input
                  type="number"
                  step="0.01"
                  aria-label={`Up to, tier ${idx + 1}`}
                  value={t.to}
                  onChange={(e) => updateRow(idx, "to", e.target.value)}
                  placeholder="unbounded"
                  style={inputStyle}
                />
              </td>
              <td style={tdStyle}>
                <MoneyInput
                  value={t.rate}
                  onChange={(v) => updateRow(idx, "rate", v)}
                  ariaLabel={`Rate for tier ${idx + 1}`}
                  style={{ padding: 6 }}
                  required
                />
              </td>
              <td style={tdStyle}>
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  style={removeButtonStyle}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={addRow} style={addButtonStyle}>
        + Add Tier
      </button>
      <div style={{ marginTop: 12, maxWidth: 240 }}>
        <UnitPicker value={unit} onChange={setUnit} groups={unitOptions} required />
      </div>
    </div>
  );
}

const thStyle = {
  textAlign: "left" as const,
  padding: 4,
  fontSize: 12,
  color: "var(--text-muted)",
  fontWeight: 500,
};

const tdStyle = { padding: 4 } as const;

const inputStyle = {
  width: "100%",
  padding: 6,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};

const removeButtonStyle = {
  padding: "4px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
} as const;

const addButtonStyle = {
  marginTop: 8,
  padding: "6px 12px",
  border: "1px dashed var(--border)",
  borderRadius: "var(--radius)",
  background: "transparent",
  color: "var(--accent-primary)",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: "inherit",
} as const;
