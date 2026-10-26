import { Decimal } from "decimal.js";

/**
 * How a bill prints a number, a date and an address.
 *
 * One module so every amount on the page rounds the same way. The bill
 * is the artefact a customer disputes, and two functions rounding
 * differently is a page that does not add up.
 */

/** 4dp column to 2dp display. */
export function money(value: Decimal | string | number): string {
  return new Decimal(value as Decimal.Value).toFixed(2);
}

/** `2026-02-10`. Fixed format, so a regenerated bill keeps its bytes. */
export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "Testville, MT 59771" from its parts, skipping whatever is absent. */
export function cityLine(city?: string | null, state?: string | null, postal?: string | null): string {
  const left = [city, state].filter(Boolean).join(", ");
  return [left, postal].filter(Boolean).join(" ").trim();
}

/** A blank string is absent: that is how a settings page clears a field. */
export function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value != null;
}

/** The lines of an address, blanks dropped and each one trimmed. */
export function addressLines(parts: Array<string | null | undefined>): string[] {
  return parts.filter((line): line is string => present(line)).map((line) => line.trim());
}

/** The already-rounded line amounts, summed, as printed. */
export function sumPrinted(amounts: string[]): string {
  return amounts.reduce((acc, amount) => acc.plus(new Decimal(amount)), new Decimal(0)).toFixed(2);
}
