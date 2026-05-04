"use client";

import { useEffect, useState } from "react";

interface PercentOfValue {
  type: "percent_of";
  selector: Record<string, unknown>;
  percent: number;
}

interface Props {
  value: PercentOfValue | null;
  onChange: (value: PercentOfValue | null) => void;
}

/**
 * Slice 2 task 6 — structured editor for `pricing.type === "percent_of"`.
 *
 * The grammar permits arbitrary `and`/`or` selector composition; this MVP
 * editor handles the six leaf operators that cover ~all real-world surcharge
 * and tax cases (kind, kind_in, exclude_kind, source_schedule_role,
 * has_label_prefix, component_id). Composite selectors fall through to the
 * JSON fallback editor.
 *
 * Percent accepts negatives so a -45 entry expresses a 45%-off senior credit
 * via the same pricing shape used for taxes.
 */

const SIMPLE_SELECTORS = [
  { code: "kind", label: "By kind (single)", needsValue: "kind" as const },
  {
    code: "kind_in",
    label: "By kinds (multiple)",
    needsValue: "kind_array" as const,
  },
  {
    code: "exclude_kind",
    label: "Exclude kinds",
    needsValue: "kind_array" as const,
  },
  {
    code: "source_schedule_role",
    label: "By schedule role",
    needsValue: "role" as const,
  },
  {
    code: "has_label_prefix",
    label: "By label prefix",
    needsValue: "string" as const,
  },
  {
    code: "component_id",
    label: "Specific component (UUID)",
    needsValue: "uuid" as const,
  },
] as const;

const KIND_OPTIONS = [
  "service_charge",
  "consumption",
  "derived_consumption",
  "non_meter",
  "item_price",
  "one_time_fee",
  "surcharge",
  "tax",
  "credit",
  "reservation_charge",
  "minimum_bill",
];

const ROLE_OPTIONS = ["primary", "delivery", "supply", "rider", "opt_in"];

function detectInitialOp(
  selector: Record<string, unknown> | undefined,
): string {
  if (!selector) return "kind";
  const op = Object.keys(selector)[0];
  return SIMPLE_SELECTORS.find((s) => s.code === op)?.code ?? "kind";
}

export function PercentOfEditor({ value, onChange }: Props) {
  const [op, setOp] = useState<string>(detectInitialOp(value?.selector));
  const [singleValue, setSingleValue] = useState<string>("");
  const [multiValue, setMultiValue] = useState<string>("");
  const [percent, setPercent] = useState<string>(
    value?.percent !== undefined ? String(value.percent) : "",
  );

  // Initialize single/multi value from the incoming selector for the
  // detected op. Only runs on mount; subsequent edits flow through state.
  useEffect(() => {
    if (!value?.selector) return;
    const v = value.selector[op];
    if (Array.isArray(v)) setMultiValue(v.join(", "));
    else if (v != null) setSingleValue(String(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const pct = parseFloat(percent);
    if (!Number.isFinite(pct)) {
      onChange(null);
      return;
    }
    const selectorMeta = SIMPLE_SELECTORS.find((s) => s.code === op);
    if (!selectorMeta) {
      onChange(null);
      return;
    }
    let selector: Record<string, unknown>;
    if (selectorMeta.needsValue === "kind_array") {
      const arr = multiValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (arr.length === 0) {
        onChange(null);
        return;
      }
      selector = { [op]: arr };
    } else {
      if (!singleValue.trim()) {
        onChange(null);
        return;
      }
      selector = { [op]: singleValue.trim() };
    }
    onChange({ type: "percent_of", selector, percent: pct });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op, singleValue, multiValue, percent]);

  const opMeta = SIMPLE_SELECTORS.find((s) => s.code === op)!;

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Selector</label>
        <select
          value={op}
          onChange={(e) => setOp(e.target.value)}
          style={inputStyle}
        >
          {SIMPLE_SELECTORS.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={labelStyle}>Value</label>
        {opMeta.needsValue === "kind" && (
          <select
            value={singleValue}
            onChange={(e) => setSingleValue(e.target.value)}
            style={inputStyle}
          >
            <option value="">— pick a kind —</option>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        {opMeta.needsValue === "kind_array" && (
          <input
            type="text"
            value={multiValue}
            onChange={(e) => setMultiValue(e.target.value)}
            placeholder="kind1, kind2, …"
            style={inputStyle}
          />
        )}
        {opMeta.needsValue === "role" && (
          <select
            value={singleValue}
            onChange={(e) => setSingleValue(e.target.value)}
            style={inputStyle}
          >
            <option value="">— pick a role —</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        )}
        {opMeta.needsValue === "string" && (
          <input
            type="text"
            value={singleValue}
            onChange={(e) => setSingleValue(e.target.value)}
            style={inputStyle}
          />
        )}
        {opMeta.needsValue === "uuid" && (
          <input
            type="text"
            value={singleValue}
            onChange={(e) => setSingleValue(e.target.value)}
            placeholder="component UUID"
            style={inputStyle}
          />
        )}
      </div>
      <div>
        <label style={labelStyle}>Percent (use negative for credits)</label>
        <input
          type="number"
          step="0.01"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          placeholder="e.g. 25 for 25%, -45 for 45% credit"
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
