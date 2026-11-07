"use client";

import { useEffect, useState } from "react";
import type { TransformOption } from "./quantity-source-builder";

/**
 * The adjustments applied to a quantity before it is priced.
 *
 * A JSON textarea before this: authoring the commonest adjustment in
 * the grammar meant knowing that prorate's key is `standard_days` and
 * that it takes an integer. The five transforms the engine evaluates
 * have two parameters between them at most.
 *
 * Two properties this has to hold on to.
 *
 * **Order is semantic.** They apply left to right, and clamping then
 * prorating is a different quantity from prorating then clamping, so
 * the list is ordered, says so, and can be reordered.
 *
 * **A transform it does not recognise is kept, not dropped.** Four are
 * declared in the grammar and not evaluated by the engine, so they are
 * never offered — authoring one builds a tariff that cannot be rated.
 * One already stored is shown and preserved in place: silently
 * discarding what an editor does not understand is how `unit: "HCF"`
 * vanished from the tiered editor.
 */

interface Commodity {
  id: string;
  name: string;
}

interface Props {
  value: unknown[];
  onChange: (transforms: unknown[], valid: boolean) => void;
  available: TransformOption[];
  commodities?: Commodity[];
}

/** One row's editable parameters, as strings while being typed. */
interface Row {
  type: string;
  min: string;
  max: string;
  subtract: string;
  standardDays: string;
  commodityId: string;
  /** Set for a transform this builder cannot edit; emitted verbatim. */
  opaque?: Record<string, unknown>;
}

const EDITABLE = new Set([
  "clamp",
  "net",
  "prorate",
  "subtract_linked_commodity",
  "floor",
]);

const blankRow = (type: string): Row => ({
  type,
  min: "",
  max: "",
  subtract: "",
  standardDays: "",
  commodityId: "",
});

function toRow(t: unknown): Row {
  const obj = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  if (!EDITABLE.has(type)) {
    return { ...blankRow(type), opaque: obj };
  }
  return {
    type,
    min: str(obj.min),
    max: str(obj.max),
    subtract: str(obj.subtract),
    standardDays: str(obj.standard_days),
    commodityId: str(obj.commodity_id),
  };
}

/**
 * One row to the grammar's shape, or `null` while it is incomplete.
 *
 * A clamp with neither bound parses — both are optional — and bounds
 * nothing, so it counts as incomplete here rather than emitting a
 * transform that silently does no work.
 */
function toTransform(row: Row): Record<string, unknown> | null {
  if (row.opaque) return row.opaque;
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  switch (row.type) {
    case "clamp": {
      const min = num(row.min);
      const max = num(row.max);
      if (min === undefined && max === undefined) return null;
      if ((min !== undefined && !Number.isFinite(min)) || (max !== undefined && !Number.isFinite(max))) {
        return null;
      }
      return { type: "clamp", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
    }
    case "floor": {
      const min = num(row.min);
      if (min === undefined || !Number.isFinite(min)) return null;
      return { type: "floor", min };
    }
    case "net": {
      if (!row.subtract.trim()) return null;
      return { type: "net", subtract: row.subtract.trim() };
    }
    case "prorate": {
      const days = num(row.standardDays);
      if (days === undefined || !Number.isInteger(days) || days <= 0) return null;
      return { type: "prorate", standard_days: days };
    }
    case "subtract_linked_commodity": {
      if (!row.commodityId.trim()) return null;
      return { type: "subtract_linked_commodity", commodity_id: row.commodityId.trim() };
    }
    default:
      return null;
  }
}

export function TransformsBuilder({ value, onChange, available, commodities = [] }: Props) {
  const [rows, setRows] = useState<Row[]>(() =>
    Array.isArray(value) ? value.map(toRow) : [],
  );

  useEffect(() => {
    const built = rows.map(toTransform);
    // An incomplete row holds Save rather than being quietly omitted:
    // a transform half-entered and then dropped on save is a different
    // quantity from the one the author was in the middle of writing.
    const valid = built.every((t) => t !== null);
    onChange(built.filter((t): t is Record<string, unknown> => t !== null), valid);
    // onChange is stable in practice; re-emit when the rows change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const labelFor = (type: string) =>
    available.find((a) => a.code === type)?.label ?? type;

  const update = (idx: number, field: keyof Row, v: string) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: v } : r)));
  const remove = (idx: number) => setRows((prev) => prev.filter((_, i) => i !== idx));
  const move = (idx: number, delta: number) =>
    setRows((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target]!, next[idx]!];
      return next;
    });

  return (
    <div>
      <p style={helpStyle}>
        Adjustments applied to the quantity above, in order,{" "}
        <strong>before it is priced</strong> — so the charge prices the adjusted
        figure and the bill line shows it. Most tariffs need none.
      </p>

      {rows.length === 0 ? (
        <p style={{ ...helpStyle, fontStyle: "italic" }}>No transforms.</p>
      ) : (
        <>
          <p style={helpStyle}>
            Applied in order, top to bottom — clamping then prorating is not the
            same as prorating then clamping.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
            {rows.map((row, idx) => (
              <div key={idx} style={rowStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 14 }}>
                    {idx + 1}.
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>
                    {labelFor(row.type)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Move ${labelFor(row.type)} earlier`}
                    disabled={idx === 0}
                    onClick={() => move(idx, -1)}
                    style={{ ...iconButtonStyle, opacity: idx === 0 ? 0.3 : 1 }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${labelFor(row.type)} later`}
                    disabled={idx === rows.length - 1}
                    onClick={() => move(idx, 1)}
                    style={{ ...iconButtonStyle, opacity: idx === rows.length - 1 ? 0.3 : 1 }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${labelFor(row.type)}`}
                    onClick={() => remove(idx)}
                    style={iconButtonStyle}
                  >
                    ✕
                  </button>
                </div>

                {row.opaque ? (
                  <p style={{ ...helpStyle, margin: "6px 0 0", color: "var(--warning, #b45309)" }}>
                    Declared in the rate grammar but <strong>not evaluated</strong> by the
                    engine, so it changes nothing when this charge is rated. Kept as it
                    was written; remove it, or leave it for when the engine implements it.
                  </p>
                ) : (
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {row.type === "clamp" && (
                      <>
                        <Field label="Minimum">
                          <input
                            type="number"
                            aria-label="Minimum"
                            value={row.min}
                            onChange={(e) => update(idx, "min", e.target.value)}
                            placeholder="none"
                            style={inputStyle}
                          />
                        </Field>
                        <Field label="Maximum">
                          <input
                            type="number"
                            aria-label="Maximum"
                            value={row.max}
                            onChange={(e) => update(idx, "max", e.target.value)}
                            placeholder="none"
                            style={inputStyle}
                          />
                        </Field>
                      </>
                    )}
                    {row.type === "floor" && (
                      <Field label="Minimum quantity">
                        <input
                          type="number"
                          aria-label="Minimum quantity"
                          required
                          value={row.min}
                          onChange={(e) => update(idx, "min", e.target.value)}
                          style={inputStyle}
                        />
                      </Field>
                    )}
                    {row.type === "prorate" && (
                      <Field label="Standard days">
                        <input
                          type="number"
                          aria-label="Standard days"
                          required
                          min={1}
                          step={1}
                          value={row.standardDays}
                          onChange={(e) => update(idx, "standardDays", e.target.value)}
                          placeholder="e.g. 30"
                          style={inputStyle}
                        />
                      </Field>
                    )}
                    {row.type === "net" && (
                      <Field label="Variable to subtract">
                        <input
                          type="text"
                          aria-label="Variable to subtract"
                          required
                          value={row.subtract}
                          onChange={(e) => update(idx, "subtract", e.target.value)}
                          placeholder="e.g. meter:reads:<meter_id>"
                          style={inputStyle}
                        />
                      </Field>
                    )}
                    {row.type === "subtract_linked_commodity" && (
                      <Field label="Commodity to subtract">
                        {commodities.length > 0 ? (
                          <select
                            aria-label="Commodity to subtract"
                            required
                            value={row.commodityId}
                            onChange={(e) => update(idx, "commodityId", e.target.value)}
                            style={inputStyle}
                          >
                            <option value="">Choose a commodity…</option>
                            {commodities.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          /* Never a dead control: without the list, the id
                             is still enterable. */
                          <input
                            type="text"
                            aria-label="Commodity to subtract"
                            required
                            value={row.commodityId}
                            onChange={(e) => update(idx, "commodityId", e.target.value)}
                            placeholder="commodity uuid"
                            style={inputStyle}
                          />
                        )}
                      </Field>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <select
        aria-label="Add a transform"
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          setRows((prev) => [...prev, blankRow(e.target.value)]);
        }}
        style={{ ...inputStyle, maxWidth: 260 }}
      >
        <option value="">+ Add a transform…</option>
        {available
          .filter((a) => a.supported)
          .map((a) => (
            <option key={a.code} value={a.code}>
              {a.label}
            </option>
          ))}
      </select>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1 }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

const helpStyle = {
  margin: "0 0 8px",
  fontSize: 11,
  color: "var(--text-muted)",
  lineHeight: 1.5,
} as const;

const rowStyle = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
  background: "var(--bg-elevated)",
} as const;

const inputStyle = {
  width: "100%",
  padding: 6,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 12,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
};

const iconButtonStyle = {
  padding: "2px 7px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  fontFamily: "inherit",
} as const;
