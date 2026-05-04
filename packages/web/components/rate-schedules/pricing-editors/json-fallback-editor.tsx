"use client";

import { useState, useEffect } from "react";

/**
 * Structural shape of a Zod schema's `safeParse` we care about. Mirroring
 * this here keeps the web package free of a direct `zod` dependency — the
 * schemas are re-exported by `@utility-cis/shared` and only consumed via
 * `safeParse`. If Zod ever changes the failure shape, the build breaks
 * here, which is the desired fail-loud signal.
 */
type SafeParseSchema = {
  safeParse: (value: unknown) =>
    | { success: true; data: unknown }
    | {
        success: false;
        error: { errors: Array<{ message: string }> };
      };
};

interface Props {
  initialJson: string;
  schema?: SafeParseSchema;
  onChange: (parsed: unknown, isValid: boolean) => void;
  rows?: number;
  label?: string;
}

/**
 * Slice 2 task 4 — reusable JSON-with-Zod-validation editor.
 *
 * Shipping this as the fallback for predicate / quantitySource / pricing
 * before the structured editors land in tasks 5-7. Live-validates JSON
 * syntax on every keystroke, then runs the (optional) Zod schema. Bubbles
 * the parsed value + validity flag up so the parent can disable Save when
 * any of the three is invalid.
 */
export function JsonFallbackEditor({
  initialJson,
  schema,
  onChange,
  rows = 8,
  label,
}: Props) {
  const [text, setText] = useState(initialJson);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(initialJson);
    // Re-run validation when initialJson changes so the parent's
    // validity state matches the freshly-loaded value (edit mode).
    let parsed: unknown;
    try {
      parsed = JSON.parse(initialJson);
    } catch (e) {
      setError("Invalid JSON: " + (e as Error).message);
      onChange(null, false);
      return;
    }
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        setError(
          "Schema validation failed: " +
            result.error.errors.map((er: { message: string }) => er.message).join(", "),
        );
        onChange(parsed, false);
        return;
      }
    }
    setError(null);
    onChange(parsed, true);
    // initialJson changes are the trigger; onChange/schema are stable in practice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJson]);

  const handleChange = (value: string) => {
    setText(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      setError("Invalid JSON: " + (e as Error).message);
      onChange(null, false);
      return;
    }
    if (schema) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        setError(
          "Schema validation failed: " +
            result.error.errors.map((er: { message: string }) => er.message).join(", "),
        );
        onChange(parsed, false);
        return;
      }
    }
    setError(null);
    onChange(parsed, true);
  };

  return (
    <div>
      {label && (
        <label
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            display: "block",
            marginBottom: 6,
          }}
        >
          {label}
        </label>
      )}
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        style={{
          width: "100%",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 12,
          padding: 8,
          border: error
            ? "1px solid var(--danger, #dc2626)"
            : "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--bg-deep)",
          color: "var(--text-primary)",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      {error && (
        <div
          style={{
            color: "var(--danger, #dc2626)",
            fontSize: 11,
            marginTop: 4,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
