"use client";

import { useEffect, useState } from "react";
import { JsonFallbackEditor } from "./pricing-editors/json-fallback-editor";
import { predicateSchema } from "@utility-cis/shared";

/**
 * Slice 2 task 7 — structured PredicateBuilder.
 *
 * Top-level operator dropdown + per-operator inputs covering the 5 most
 * common predicates (empty / class / class_in / drought_stage_active /
 * premise_attr). The remaining 14+ operators fall through to a JSON
 * textarea so they're still authorable without leaving the editor.
 *
 * The assembled predicate object is validated against the closed-grammar
 * schema before bubbling validity up to the parent (ComponentEditor).
 */

const STRUCTURED_OPS = [
  { code: "empty", label: "Always applies (no predicate)" },
  { code: "class", label: "Customer class equals" },
  { code: "class_in", label: "Customer class is one of" },
  { code: "drought_stage_active", label: "Drought stage is active" },
  { code: "premise_attr", label: "Premise attribute" },
  { code: "json", label: "Advanced (JSON)" },
];

interface Props {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>, valid: boolean) => void;
}

function detectInitial(value: Record<string, unknown>): string {
  if (Object.keys(value).length === 0) return "empty";
  const op = Object.keys(value)[0];
  if (
    op === "class" ||
    op === "class_in" ||
    op === "drought_stage_active" ||
    op === "premise_attr"
  ) {
    return op;
  }
  return "json";
}

export function PredicateBuilder({ value, onChange }: Props) {
  const [op, setOp] = useState<string>(detectInitial(value));
  const [classValue, setClassValue] = useState<string>(
    typeof (value as { class?: string }).class === "string"
      ? (value as { class: string }).class
      : "",
  );
  const [classInValue, setClassInValue] = useState<string>(
    Array.isArray((value as { class_in?: string[] }).class_in)
      ? (value as { class_in: string[] }).class_in.join(", ")
      : "",
  );
  const [droughtStage, setDroughtStage] = useState<boolean>(
    typeof (value as { drought_stage_active?: boolean }).drought_stage_active ===
      "boolean"
      ? (value as { drought_stage_active: boolean }).drought_stage_active
      : true,
  );
  const [premiseAttrName, setPremiseAttrName] = useState<string>(
    (value as { premise_attr?: { attr: string } }).premise_attr?.attr ?? "",
  );
  const [premiseAttrCmp, setPremiseAttrCmp] = useState<string>(() => {
    const pa = (value as { premise_attr?: { eq?: unknown; ne?: unknown } })
      .premise_attr;
    if (pa && "eq" in pa && pa.eq !== undefined) return "eq";
    if (pa && "ne" in pa && pa.ne !== undefined) return "ne";
    return "eq";
  });
  const [premiseAttrValue, setPremiseAttrValue] = useState<string>(() => {
    const pa = (value as { premise_attr?: { eq?: unknown; ne?: unknown } })
      .premise_attr;
    if (pa) {
      if (pa.eq !== undefined) return String(pa.eq);
      if (pa.ne !== undefined) return String(pa.ne);
    }
    return "";
  });

  useEffect(() => {
    let assembled: Record<string, unknown>;
    switch (op) {
      case "empty":
        assembled = {};
        break;
      case "class":
        if (!classValue.trim()) {
          onChange({}, false);
          return;
        }
        assembled = { class: classValue.trim() };
        break;
      case "class_in": {
        const arr = classInValue
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (arr.length === 0) {
          onChange({}, false);
          return;
        }
        assembled = { class_in: arr };
        break;
      }
      case "drought_stage_active":
        assembled = { drought_stage_active: droughtStage };
        break;
      case "premise_attr": {
        if (!premiseAttrName.trim()) {
          onChange({}, false);
          return;
        }
        // Coerce value: try boolean / number / string. Most tenant-defined
        // premise attributes are booleans or scalars; this lets the author
        // type "true" / "12" without thinking about JSON quoting.
        let coerced: unknown = premiseAttrValue;
        if (premiseAttrValue === "true") coerced = true;
        else if (premiseAttrValue === "false") coerced = false;
        else if (
          premiseAttrValue !== "" &&
          Number.isFinite(parseFloat(premiseAttrValue))
        )
          coerced = parseFloat(premiseAttrValue);
        assembled = {
          premise_attr: {
            attr: premiseAttrName.trim(),
            [premiseAttrCmp]: coerced,
          },
        };
        break;
      }
      default:
        // JSON mode handled by the JsonFallbackEditor branch below
        return;
    }
    const result = predicateSchema.safeParse(assembled);
    onChange(assembled, result.success);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    op,
    classValue,
    classInValue,
    droughtStage,
    premiseAttrName,
    premiseAttrCmp,
    premiseAttrValue,
  ]);

  return (
    <div>
      <label style={labelStyle}>Predicate</label>
      <select
        value={op}
        onChange={(e) => setOp(e.target.value)}
        style={inputStyle}
      >
        {STRUCTURED_OPS.map((s) => (
          <option key={s.code} value={s.code}>
            {s.label}
          </option>
        ))}
      </select>
      <div style={{ marginTop: 12 }}>
        {op === "empty" && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>
            This predicate matches all rows.
          </p>
        )}
        {op === "class" && (
          <input
            type="text"
            value={classValue}
            onChange={(e) => setClassValue(e.target.value)}
            placeholder="e.g. single_family"
            style={inputStyle}
          />
        )}
        {op === "class_in" && (
          <input
            type="text"
            value={classInValue}
            onChange={(e) => setClassInValue(e.target.value)}
            placeholder="comma-separated, e.g. multi_family, commercial, government"
            style={inputStyle}
          />
        )}
        {op === "drought_stage_active" && (
          <select
            value={droughtStage ? "true" : "false"}
            onChange={(e) => setDroughtStage(e.target.value === "true")}
            style={inputStyle}
          >
            <option value="true">drought_stage_active = true</option>
            <option value="false">drought_stage_active = false</option>
          </select>
        )}
        {op === "premise_attr" && (
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={premiseAttrName}
              onChange={(e) => setPremiseAttrName(e.target.value)}
              placeholder="attribute name (e.g. has_stormwater_infra)"
              style={{ ...inputStyle, flex: 2 }}
            />
            <select
              value={premiseAttrCmp}
              onChange={(e) => setPremiseAttrCmp(e.target.value)}
              style={{ ...inputStyle, flex: 1, maxWidth: 80 }}
            >
              <option value="eq">eq</option>
              <option value="ne">ne</option>
            </select>
            <input
              type="text"
              value={premiseAttrValue}
              onChange={(e) => setPremiseAttrValue(e.target.value)}
              placeholder="value (true/false/string)"
              style={{ ...inputStyle, flex: 2 }}
            />
          </div>
        )}
        {op === "json" && (
          <JsonFallbackEditor
            initialJson={JSON.stringify(value, null, 2)}
            schema={predicateSchema}
            onChange={(parsed, isValid) =>
              onChange((parsed as Record<string, unknown>) ?? {}, isValid)
            }
            label="Predicate JSON"
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
  padding: 8,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  background: "var(--bg-deep)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box" as const,
} as const;
