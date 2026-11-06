import { describe, it, expect } from "vitest";
import { METER_TYPES, meterTypeEnum } from "../meter";

/**
 * What kinds of meter there are.
 *
 * `SMART` went on 2026-11-06. It said nothing `AMI` did not — spec 03
 * admitted as much ("used interchangeably with AMI in some contexts") —
 * and two values for one idea is two answers to "what is this meter",
 * neither of which anything reads: nothing in the API branches on
 * `meter_type` at all, so the only cost of the ambiguity was paid by
 * whoever had to pick one on a form.
 *
 * The list is exported from here because it had **five** hand-kept
 * copies: this enum, the meter import handler, and three web forms —
 * one of which offered `OTHER`, a value the API would have refused.
 */
describe("meter types", () => {
  it("is the three kinds the API accepts, in one list", () => {
    expect(METER_TYPES).toEqual(["AMR", "AMI", "MANUAL"]);
    expect(meterTypeEnum.options).toEqual(METER_TYPES);
  });

  it("refuses SMART, which said nothing AMI did not", () => {
    expect(meterTypeEnum.safeParse("SMART").success).toBe(false);
    expect(meterTypeEnum.safeParse("AMI").success).toBe(true);
  });

  it("refuses OTHER, which a meter form offered and the API never had", () => {
    expect(meterTypeEnum.safeParse("OTHER").success).toBe(false);
  });
});
