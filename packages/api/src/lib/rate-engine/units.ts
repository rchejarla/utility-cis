import { Decimal, toDecimal } from "./decimal.js";

/**
 * Converting a metered quantity into the unit a tariff is written in.
 *
 * A utility publishes its rates in the unit its rate case was argued in
 * — Bozeman's water tiers break at 6, 25 and 55 HCF — while its meters
 * are denominated in whatever the meters happen to be, usually gallons.
 * Both facts are already in the rating context: `meter-loader` carries
 * the read's unit beside its quantity, and a pricing block names its
 * own. Nothing compared them, so 3,515 gallons was priced as 3,515 HCF
 * and billed $33,445.38 of usage on one house for one month.
 *
 * Factors are held per dimension and per pair, not as a chain through
 * some canonical unit, because a tariff's unit is an auditable claim
 * about a published rate: a reader should be able to check 748.05
 * against the definition of a cubic foot without following two
 * multiplications. Converting across dimensions is refused rather than
 * approximated — there is no honest answer for gallons into kilowatt
 * hours, and returning the number unchanged is what made a 748× error
 * look like a successful run.
 */

/**
 * How many of each unit make one HCF (a hundred cubic feet).
 *
 * A US liquid gallon is 231 cubic inches and a cubic foot is 1,728, so
 * one HCF is exactly 172800/231 gallons — 748.052, give or take. Kept
 * as the ratio rather than the decimal so the arithmetic is the
 * definition rather than a rounding of it.
 */
const VOLUME_PER_HCF: Record<string, Decimal> = {
  HCF: toDecimal(1),
  // The same volume under the name the waterworks trade prefers.
  CCF: toDecimal(1),
  CF: toDecimal(100),
  GAL: toDecimal(172800).div(231),
  KGAL: toDecimal(172800).div(231).div(1000),
  // A thousand cubic feet is ten hundred-cubic-feet.
  MCF: toDecimal("0.1"),
};

/** How many of each unit make one kilowatt hour. */
const ENERGY_PER_KWH: Record<string, Decimal> = {
  KWH: toDecimal(1),
  MWH: toDecimal("0.001"),
  WH: toDecimal(1000),
};

const DIMENSIONS: Array<Record<string, Decimal>> = [VOLUME_PER_HCF, ENERGY_PER_KWH];

/**
 * `quantity` restated in `to`.
 *
 * Throws when the two units are not comparable, naming both — a bill
 * that cannot be worked out is an exception an operator can fix, and a
 * bill worked out in the wrong unit is not.
 */
export function convertQuantity(
  quantity: Decimal,
  from: string,
  to: string,
): Decimal {
  /*
   * Matched without regard to case, because a unit code identifies a
   * physical quantity and the casing is a house style. NWE publishes
   * its rates per `kWh` and the same utility records its electric
   * meters as `KWH`; an exact-match lookup called those incomparable
   * and failed the account, which is worse than the mispricing it
   * replaced — it stops a bill that was never wrong.
   */
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return quantity;

  const dimension = DIMENSIONS.find((d) => d[f] !== undefined && d[t] !== undefined);
  if (!dimension) {
    throw new Error(
      `Cannot convert a quantity from ${from} to ${to}: ` +
        (DIMENSIONS.some((d) => d[f] !== undefined)
          ? "the two measure different things"
          : `${from} is not a unit this engine knows`),
    );
  }

  // Both sides are "per the dimension's base", so the base cancels.
  return quantity.div(dimension[f]!).mul(dimension[t]!);
}
