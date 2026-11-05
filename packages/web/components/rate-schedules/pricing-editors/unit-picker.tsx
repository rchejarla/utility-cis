"use client";

import { useState } from "react";

export interface UnitOptionGroup {
  label: string;
  codes: string[];
}

export const OTHER_UNIT = "__other";

interface Props {
  value?: string;
  onChange: (value: string) => void;
  groups: UnitOptionGroup[];
  /** Accessible name. The table editors name theirs for the whole table. */
  label?: string;
  /**
   * Required by the three structured editors, and enforced by them
   * emitting `null` while it is blank — `pricingSchema` stays
   * permissive, so rows already stored without a unit still parse and
   * the engine is unchanged. `bill_segment_line.unit` is why: the
   * engine converts a gallons meter onto an HCF tariff, "and the bill
   * has to say of what".
   */
  required?: boolean;
}

/**
 * The unit a priced quantity is counted in, for the bill line.
 *
 * A dropdown over the known vocabulary, with free text still reachable,
 * because `pricing.unit` is a **label** and not a unit of measure: the
 * engine copies it onto the emitted line and never interprets it. That
 * is why `MONTH` (every service charge) and `ERU` sit beside `HCF` in
 * the seeded tariffs, and why a list closed over `unit_of_measure`
 * would be wrong — `HCF` is the most-used unit in those tariffs and is
 * not a UOM row at all.
 *
 * So the control constrains the common path without becoming a gate:
 * the groups are offered, anything else is typed. Free text alone is
 * how `kWh` and `KWH` both ended up in one seed, which a bill prints as
 * written; offering the spellings already in use is the cheap half of
 * fixing that.
 */
export function UnitPicker({
  value,
  onChange,
  groups,
  label = "Unit",
  required = false,
}: Props) {
  // Deduped across groups, first occurrence winning, so one code cannot
  // appear as two <option>s with the same value.
  const seen = new Set<string>();
  const offered = groups
    .map((g) => ({
      label: g.label,
      codes: g.codes.filter((c) => (seen.has(c) ? false : (seen.add(c), true))),
    }))
    .filter((g) => g.codes.length > 0);

  const isKnown = !!value && seen.has(value);
  const [other, setOther] = useState<boolean>(!!value && !isKnown);
  const [free, setFree] = useState<string>(!!value && !isKnown ? value : "");

  const handleSelect = (next: string) => {
    if (next === OTHER_UNIT) {
      setOther(true);
      onChange(free);
      return;
    }
    setOther(false);
    onChange(next);
  };

  return (
    <div>
      <span style={labelStyle}>
        {label}
        {required ? (
          <>
            <span aria-hidden="true" style={{ color: "var(--danger)", marginLeft: 3 }}>
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : (
          " (optional)"
        )}
      </span>
      <select
        aria-label={label}
        required={required}
        value={other ? OTHER_UNIT : (value ?? "")}
        onChange={(e) => handleSelect(e.target.value)}
        style={inputStyle}
      >
        <option value="">{required ? "Choose a unit…" : "(none)"}</option>
        {offered.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.codes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER_UNIT}>Other…</option>
      </select>
      {other && (
        <input
          type="text"
          aria-label={`${label} label`}
          required={required}
          value={free}
          onChange={(e) => {
            setFree(e.target.value);
            onChange(e.target.value);
          }}
          placeholder="e.g. ERU, CART"
          style={{ ...inputStyle, marginTop: 6 }}
        />
      )}
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
