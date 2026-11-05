"use client";

import { useEffect, useState } from "react";
import { MoneyInput } from "./money-input";
import { UnitPicker, type UnitOptionGroup } from "./unit-picker";

interface LookupValue {
  type: "lookup";
  by: string;
  table: Record<string, number>;
  unit?: string;
}

interface Props {
  value: LookupValue | null;
  onChange: (value: LookupValue | null) => void;
  unitOptions: UnitOptionGroup[];
}

/**
 * Slice 2 task 6 — structured editor for `pricing.type === "lookup"`.
 *
 * A lookup pricing keys a numeric rate off one attribute of the line.
 * The Slice 3+4 engine only knows how to resolve `meter_size` so the
 * `by` dropdown ships with that single option; the dropdown shape leaves
 * room to add more dimensions later without rewriting the editor. The
 * key/rate row table requires every row to carry a non-empty key and a
 * finite rate; if either is missing we emit `null` so the parent blocks
 * Save until the table is complete.
 */
export function LookupEditor({ value, onChange, unitOptions }: Props) {
  const [by, setBy] = useState<string>(value?.by ?? "meter_size");
  // Carried through the same way the tiered editor carries its own: a
  // save through this form used to drop it, and every seeded service
  // charge priced by meter size is `unit: "MONTH"`.
  const [unit, setUnit] = useState<string>(value?.unit ?? "");
  const [rows, setRows] = useState<Array<{ key: string; rate: string }>>(
    Object.entries(value?.table ?? {}).map(([k, v]) => ({
      key: k,
      rate: String(v),
    })),
  );

  // If we initialized empty, give the user one blank row to fill.
  useEffect(() => {
    if (rows.length === 0) setRows([{ key: "", rate: "" }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (rows.length === 0) {
      onChange(null);
      return;
    }
    const table: Record<string, number> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) {
        onChange(null);
        return;
      }
      const r = parseFloat(row.rate);
      if (!Number.isFinite(r)) {
        onChange(null);
        return;
      }
      table[key] = r;
    }
    // Same rule as the flat and tiered editors.
    if (!unit) {
      onChange(null);
      return;
    }
    const next: LookupValue = { type: "lookup", by, table, unit };
    onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, rows, unit]);

  const updateRow = (idx: number, field: "key" | "rate", v: string) =>
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, [field]: v } : r)),
    );
  const addRow = () =>
    setRows((prev) => [...prev, { key: "", rate: "" }]);
  const removeRow = (idx: number) =>
    setRows((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Lookup by</label>
        <select
          value={by}
          onChange={(e) => setBy(e.target.value)}
          style={inputStyle}
        >
          <option value="meter_size">meter_size</option>
        </select>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Key (e.g. {`5/8"`})</th>
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
          {rows.map((r, idx) => (
            <tr key={idx}>
              <td style={tdStyle}>
                <input
                  type="text"
                  aria-label={`Key for row ${idx + 1}`}
                  value={r.key}
                  onChange={(e) => updateRow(idx, "key", e.target.value)}
                  placeholder={`e.g. 5/8"`}
                  style={inputStyle}
                />
              </td>
              <td style={tdStyle}>
                <MoneyInput
                  value={r.rate}
                  onChange={(v) => updateRow(idx, "rate", v)}
                  ariaLabel={`Rate for ${r.key.trim() || `row ${idx + 1}`}`}
                  step="0.01"
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
        + Add Row
      </button>
      <div style={{ marginTop: 12, maxWidth: 240 }}>
        <UnitPicker value={unit} onChange={setUnit} groups={unitOptions} required />
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
