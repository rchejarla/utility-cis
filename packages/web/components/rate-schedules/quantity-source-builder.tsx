"use client";

import { useEffect, useState } from "react";
import { TransformsBuilder } from "./transforms-builder";
import { RequiredMark } from "@/components/ui/required-mark";
import { quantitySourceSchema } from "@utility-cis/shared";
import { apiClient } from "@/lib/api-client";

/**
 * Slice 2 task 7 — structured QuantitySourceBuilder.
 *
 * Base dropdown + per-base inputs covering the supported quantity
 * sources. `premise_attribute` and `tou_period` are the two that take a
 * structured extra input; transforms remain a collapsible JSON textarea
 * since they are rare and varied.
 */

const BASES = [
  { code: "metered", label: "Metered consumption" },
  { code: "tou_period", label: "One TOU period's consumption" },
  { code: "wqa", label: "Winter Quarter Average" },
  { code: "fixed", label: "Fixed (1)" },
  { code: "item_count", label: "Count of attached items" },
  { code: "linked_commodity", label: "Linked commodity" },
  { code: "premise_attribute", label: "Premise attribute" },
  { code: "peak_demand", label: "Peak demand (not supported in slice 4)" },
];

interface Period {
  peakCode: string;
  label: string;
}

export interface TransformOption {
  code: string;
  label: string;
  supported: boolean;
}

interface Props {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>, valid: boolean) => void;
  /**
   * From `/api/v1/rate-grammar/registered`, which already carries each
   * transform's label and whether the engine evaluates it. Passed in
   * rather than re-listed here: a second hand-kept copy of the grammar
   * in the web is exactly how `tou_period` came to be missing from the
   * base list, built and unreachable for two days.
   */
  transforms?: TransformOption[];
  /** For the `subtract_linked_commodity` transform's picker. */
  commodities?: { id: string; name: string }[];
}

export function QuantitySourceBuilder({
  value,
  onChange,
  transforms = [],
  commodities = [],
}: Props) {
  const [base, setBase] = useState<string>(
    typeof value.base === "string" ? (value.base as string) : "metered",
  );
  const [sourceAttr, setSourceAttr] = useState<string>(
    typeof value.source_attr === "string" ? (value.source_attr as string) : "",
  );
  const [peakCode, setPeakCode] = useState<string>(
    typeof value.peak_code === "string" ? (value.peak_code as string) : "",
  );
  const [periods, setPeriods] = useState<Period[]>([]);
  const [transformsValid, setTransformsValid] = useState<boolean>(true);
  const [transformsParsed, setTransformsParsed] = useState<unknown[]>(
    Array.isArray(value.transforms) ? (value.transforms as unknown[]) : [],
  );

  /*
   * The tenant's price tiers, which is the right list even though the
   * schedule prices one calendar's: peak codes belong to the utility,
   * and a calendar uses whichever of them its hours name. Publishing
   * is where the two are compared — it refuses a charge pricing a
   * period the calendar has not got, and a calendar period nothing
   * prices — so this offers the names rather than deciding them.
   */
  useEffect(() => {
    if (base !== "tou_period" || periods.length > 0) return;
    apiClient
      .get<{ data: Period[] }>("/api/v1/tou-periods")
      .then((res) => setPeriods(res.data ?? []))
      .catch(console.error);
  }, [base, periods.length]);

  useEffect(() => {
    const assembled: Record<string, unknown> = { base };
    if (base === "premise_attribute") {
      if (!sourceAttr.trim()) {
        onChange({ base }, false);
        return;
      }
      assembled.source_attr = sourceAttr.trim();
    }
    if (base === "tou_period") {
      if (!peakCode) {
        onChange({ base }, false);
        return;
      }
      assembled.peak_code = peakCode;
    }
    if (transformsParsed.length > 0) assembled.transforms = transformsParsed;
    const result = quantitySourceSchema.safeParse(assembled);
    onChange(assembled, result.success && transformsValid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, sourceAttr, peakCode, transformsParsed, transformsValid]);

  return (
    <div>
      <label style={labelStyle}>Quantity source</label>
      <select
        aria-label="Quantity source"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        style={inputStyle}
      >
        {BASES.map((b) => (
          <option
            key={b.code}
            value={b.code}
            disabled={b.code === "peak_demand"}
          >
            {b.label}
          </option>
        ))}
      </select>
      {base === "tou_period" && (
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>
            TOU period
            <RequiredMark />
          </label>
          <select
            aria-label="TOU period"
            required
            value={peakCode}
            onChange={(e) => setPeakCode(e.target.value)}
            style={inputStyle}
          >
            <option value="">Choose a period…</option>
            {periods.map((p) => (
              <option key={p.peakCode} value={p.peakCode}>
                {p.label} ({p.peakCode})
              </option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
            One charge per period: this one prices only the hours the
            schedule&apos;s TOU calendar puts in this period. Publishing is refused
            until every period that calendar uses has a charge.
          </div>
        </div>
      )}
      {base === "premise_attribute" && (
        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>
            Source attribute
            <RequiredMark />
          </label>
          <input
            type="text"
            aria-label="Source attribute"
            required
            value={sourceAttr}
            onChange={(e) => setSourceAttr(e.target.value)}
            placeholder="e.g. premise.eru_count or eru_count"
            style={inputStyle}
          />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <details>
          <summary
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Transforms (advanced — optional)
          </summary>
          <div style={{ marginTop: 8 }}>
            <TransformsBuilder
              value={Array.isArray(value.transforms) ? (value.transforms as unknown[]) : []}
              onChange={(built, isValid) => {
                setTransformsValid(isValid);
                setTransformsParsed(built);
              }}
              available={transforms}
              commodities={commodities}
            />
          </div>
        </details>
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
