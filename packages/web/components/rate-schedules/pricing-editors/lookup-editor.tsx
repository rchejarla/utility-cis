"use client";

import { useEffect, useState } from "react";

interface LookupValue {
  type: "lookup";
  by: string;
  table: Record<string, number>;
}

interface Props {
  value: LookupValue | null;
  onChange: (value: LookupValue | null) => void;
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
export function LookupEditor({ value, onChange }: Props) {
  const [by, setBy] = useState<string>(value?.by ?? "meter_size");
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
    onChange({ type: "lookup", by, table });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, rows]);

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
            <th style={thStyle}>Rate</th>
            <th style={{ ...thStyle, width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              <td style={tdStyle}>
                <input
                  type="text"
                  value={r.key}
                  onChange={(e) => updateRow(idx, "key", e.target.value)}
                  placeholder={`e.g. 5/8"`}
                  style={inputStyle}
                />
              </td>
              <td style={tdStyle}>
                <input
                  type="number"
                  step="0.01"
                  value={r.rate}
                  onChange={(e) => updateRow(idx, "rate", e.target.value)}
                  style={inputStyle}
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
