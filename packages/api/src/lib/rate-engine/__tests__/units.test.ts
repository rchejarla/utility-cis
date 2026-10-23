import { describe, it, expect } from "vitest";
import { convertQuantity } from "../units.js";
import { toDecimal } from "../decimal.js";

/**
 * Restating a metered quantity in the unit its tariff is written in.
 *
 * The cases that matter here are the ones where a utility's own records
 * disagree with themselves about spelling or naming while meaning the
 * same measure — which they do, routinely: NWE publishes its rates per
 * `kWh` and the meter's unit of measure is recorded as `KWH`. A unit
 * code is an identifier for a physical quantity, and a kilowatt hour
 * does not become a different one when a rate analyst shifts-locks the
 * h.
 */
describe("convertQuantity", () => {
  it("treats a unit code as case-insensitive", () => {
    // How this reached production: every NWE component says "kWh",
    // every electric meter says "KWH", and an exact-match lookup called
    // them incomparable — failing the account outright, which is worse
    // than the silent mispricing it replaced.
    expect(convertQuantity(toDecimal(784), "KWH", "kWh").toString()).toBe("784");
    expect(convertQuantity(toDecimal(784), "kwh", "KWH").toString()).toBe("784");
    expect(convertQuantity(toDecimal(12), "hcf", "HCF").toString()).toBe("12");
  });

  it("converts gallons to HCF by the definition of a cubic foot", () => {
    // 100 ft³ = 172800 in³; one US liquid gallon = 231 in³.
    expect(convertQuantity(toDecimal((12 * 172800) / 231), "GAL", "HCF").toFixed(4)).toBe(
      "12.0000",
    );
    expect(convertQuantity(toDecimal(3515), "GAL", "HCF").toFixed(5)).toBe("4.69887");
  });

  it("converts back again without drift", () => {
    const there = convertQuantity(toDecimal(3515), "GAL", "HCF");
    expect(convertQuantity(there, "HCF", "GAL").toFixed(4)).toBe("3515.0000");
  });

  it("converts within the volume family", () => {
    // A thousand cubic feet is ten hundred-cubic-feet.
    expect(convertQuantity(toDecimal(1), "MCF", "HCF").toString()).toBe("10");
    expect(convertQuantity(toDecimal(1), "KGAL", "GAL").toString()).toBe("1000");
  });

  it("refuses to convert across dimensions", () => {
    expect(() => convertQuantity(toDecimal(1), "GAL", "KWH")).toThrow(
      /different things/,
    );
  });

  it("refuses a unit it has never heard of, and says which", () => {
    expect(() => convertQuantity(toDecimal(1), "FURLONG", "HCF")).toThrow(
      /FURLONG is not a unit/,
    );
  });
});
