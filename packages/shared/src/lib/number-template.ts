/**
 * Tenant-configurable identifier number template engine.
 *
 * A template is a string with literal characters and curly-brace tokens.
 * Supported tokens:
 *
 *   {YYYY}    4-digit year
 *   {YY}      2-digit year
 *   {MM}      2-digit month
 *   {seq}     sequence number, unpadded
 *   {seq:N}   sequence number, zero-padded to N digits
 *
 * Every template MUST contain exactly one {seq} or {seq:N} token. More
 * than one, or zero, is rejected.
 *
 * Why a template: lets each tenant pick a numbering scheme that matches
 * their own conventions (SA-2026-0042, AC-0001, 202604-00042, etc.)
 * without code changes. Consumed in two places:
 *
 *   - API: generators read the template, substitute date tokens, build
 *     a regex to find the highest existing sequence number for the
 *     current date window, increment, format, and write the result.
 *
 *   - Web: the settings page renders a live preview as the admin types
 *     by calling previewTemplate() with a dummy sequence value.
 *
 * Implicit sequence reset: because the regex is built from the current
 * date's substituted template, including {YYYY} naturally resets the
 * sequence every January 1 (new year prefix → no matching rows → start
 * fresh). Same for {MM}. No separate "reset policy" field needed.
 */

export interface ParsedTemplate {
  /**
   * Ordered list of template parts. Literal strings mixed with token
   * markers. Used by format() and previewTemplate().
   */
  parts: Array<
    | { kind: "literal"; text: string }
    | { kind: "year4" }
    | { kind: "year2" }
    | { kind: "month2" }
    | { kind: "seq"; width: number } // width === 0 means "no padding"
  >;
  /** Padding width for the seq token (0 = no padding). */
  seqWidth: number;
}

export interface NumberFormatConfig {
  template: string;
  startAt?: number;
}

/**
 * Parse a template string into ordered parts. Throws on invalid
 * templates: missing seq token, multiple seq tokens, unclosed braces,
 * unknown tokens, or invalid seq widths.
 */
export function parseTemplate(template: string): ParsedTemplate {
  if (typeof template !== "string" || template.length === 0) {
    throw new Error("Template must be a non-empty string");
  }

  const parts: ParsedTemplate["parts"] = [];
  let seqCount = 0;
  let seqWidth = 0;
  let i = 0;

  while (i < template.length) {
    const char = template[i];

    if (char === "{") {
      const close = template.indexOf("}", i);
      if (close === -1) {
        throw new Error(`Unclosed token starting at position ${i}`);
      }
      const token = template.slice(i + 1, close);

      if (token === "YYYY") {
        parts.push({ kind: "year4" });
      } else if (token === "YY") {
        parts.push({ kind: "year2" });
      } else if (token === "MM") {
        parts.push({ kind: "month2" });
      } else if (token === "seq") {
        parts.push({ kind: "seq", width: 0 });
        seqCount++;
      } else if (token.startsWith("seq:")) {
        const widthStr = token.slice(4);
        const width = Number(widthStr);
        if (!Number.isInteger(width) || width < 1 || width > 20) {
          throw new Error(
            `Invalid seq width "${widthStr}" — must be an integer between 1 and 20`,
          );
        }
        parts.push({ kind: "seq", width });
        seqCount++;
        seqWidth = width;
      } else {
        throw new Error(`Unknown token "{${token}}"`);
      }

      i = close + 1;
    } else {
      // Accumulate literal characters up to the next token.
      let end = i;
      while (end < template.length && template[end] !== "{") end++;
      parts.push({ kind: "literal", text: template.slice(i, end) });
      i = end;
    }
  }

  if (seqCount === 0) {
    throw new Error("Template must contain exactly one {seq} or {seq:N} token");
  }
  if (seqCount > 1) {
    throw new Error("Template must contain at most one sequence token");
  }

  return { parts, seqWidth };
}

/**
 * Format a sequence number into a concrete identifier using the
 * parsed template and a reference date. The date is used for the year
 * and month tokens; today's date is the typical caller-supplied value.
 */
export function format(
  parsed: ParsedTemplate,
  seq: number,
  now: Date = new Date(),
): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  let out = "";

  for (const part of parsed.parts) {
    switch (part.kind) {
      case "literal":
        out += part.text;
        break;
      case "year4":
        out += String(year).padStart(4, "0");
        break;
      case "year2":
        out += String(year % 100).padStart(2, "0");
        break;
      case "month2":
        out += String(month).padStart(2, "0");
        break;
      case "seq":
        out += part.width > 0
          ? String(seq).padStart(part.width, "0")
          : String(seq);
        break;
    }
  }

  return out;
}

/**
 * Convenience: parse + format in one call. Useful for the settings
 * page's live preview where the admin is typing a template and we
 * want to show a sample rendered number (or a helpful error).
 */
export function previewTemplate(
  template: string,
  seq: number,
  now: Date = new Date(),
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const parsed = parseTemplate(template);
    return { ok: true, value: format(parsed, seq, now) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build a Postgres-compatible regex that matches any identifier
 * produced by this template under the current date. Literal date
 * parts are substituted with the actual current year/month. The seq
 * token is represented as a non-greedy capture of one-or-more digits
 * — critically, WITHOUT enforcing the configured padding width, so
 * that a mid-stream width change doesn't cause the query to miss
 * legacy rows that share the same date prefix.
 *
 * Returns an object with two regexes:
 *
 *   - match: a regex string suitable for PostgreSQL's `~` operator
 *     (anchored with ^ and $, no capture groups around the seq tail).
 *
 *   - seqExtract: a JavaScript RegExp that, applied to a matched
 *     identifier, captures the sequence number as the first group
 *     for numeric parsing.
 */
export function buildMatchPattern(
  parsed: ParsedTemplate,
  now: Date = new Date(),
): { match: string; seqExtract: RegExp } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  let pattern = "^";
  let jsPattern = "^";

  for (const part of parsed.parts) {
    switch (part.kind) {
      case "literal":
        pattern += escapeRegex(part.text);
        jsPattern += escapeRegex(part.text);
        break;
      case "year4":
        pattern += String(year).padStart(4, "0");
        jsPattern += String(year).padStart(4, "0");
        break;
      case "year2":
        pattern += String(year % 100).padStart(2, "0");
        jsPattern += String(year % 100).padStart(2, "0");
        break;
      case "month2":
        pattern += String(month).padStart(2, "0");
        jsPattern += String(month).padStart(2, "0");
        break;
      case "seq":
        pattern += "\\d+";
        jsPattern += "(\\d+)";
        break;
    }
  }
  pattern += "$";
  jsPattern += "$";

  return { match: pattern, seqExtract: new RegExp(jsPattern) };
}

/** Escape characters that have special meaning in POSIX and JS regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compute the next sequence number given the highest existing match
 * and the configured startAt. Returns max(startAt, existing+1), or
 * startAt if there is no existing match. Exported for reuse in tests
 * and by the generator helpers.
 */
export function nextSeq(
  existingMaxSeq: number | null,
  startAt: number = 1,
): number {
  if (existingMaxSeq === null) return Math.max(startAt, 1);
  return Math.max(startAt, existingMaxSeq + 1);
}
