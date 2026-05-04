import { Decimal } from "decimal.js";

export { Decimal };

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

export function toDecimal(v: number | string | Decimal): Decimal {
  return v instanceof Decimal ? v : new Decimal(v);
}
