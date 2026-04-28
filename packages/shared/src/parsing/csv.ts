import Papa from "papaparse";

/**
 * Tiny `papaparse` wrapper used both client and server. Returning the
 * same shape from both ends keeps the wizard's preview consistent with
 * what the server actually processes — no parser drift.
 *
 * Why we use papaparse rather than ad-hoc string splitting:
 *   - Handles quoted fields with embedded commas correctly.
 *   - Handles escaped quotes inside quoted fields.
 *   - Handles BOM markers (Excel-exported CSVs sometimes have them).
 *   - Handles mixed CRLF / LF line endings.
 * Splitting on `,` and `\n` produces silent garbage on any of those.
 *
 * `header: true` makes papaparse parse the first row as headers and
 * return each subsequent row as an object keyed by header. We then
 * also surface the raw header list so callers can drive a mapping UI.
 *
 * `skipEmptyLines: true` because a trailing newline in a CSV is the
 * norm and shouldn't materialise as an empty row we'd then fail to
 * validate.
 */

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsvText(text: string): ParsedCsv {
  // Strip BOM if present — papaparse handles it but the resulting
  // first header sometimes carries a stray U+FEFF that breaks header
  // matching downstream. Be explicit.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const result = Papa.parse<Record<string, string>>(cleaned, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
    // Keep every cell as a string. We don't want papaparse trying to
    // coerce numbers because it'll silently turn "00123" (a meter
    // number with leading zeros) into 123. Per-field typing happens
    // in the kind handler's parseRow.
    dynamicTyping: false,
  });

  return {
    headers: result.meta.fields ?? [],
    rows: result.data,
  };
}
