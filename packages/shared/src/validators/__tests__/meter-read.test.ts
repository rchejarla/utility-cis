import { describe, it, expect } from "vitest";
import { READ_TYPES, readTypeEnum, readSourceEnum } from "../meter-read";

/**
 * What a read's **type** can say, and what belongs to its source instead.
 *
 * `AMI` went from `read_type` on 2026-11-06. It is not a type of read —
 * it is where a read came from, which `read_source` says beside it and
 * still does. Nothing ever wrote it: the interval roll-up, the one
 * producer of AMI reads in this codebase, set `read_source: "AMI"` and
 * had to put something in `read_type`, and the value it chose there was
 * the *same word* rather than ACTUAL or ESTIMATED. So the one column
 * that can tell a customer their on-peak charge rests on an estimate
 * said nothing at all, and TOU-GAP-2 — "a bill containing any estimate
 * says so" — had nothing to read.
 *
 * That is why the two assertions below sit in one file: the fix is not
 * "a value was dropped", it is that the question `read_type` answers is
 * measured-or-not and the question `read_source` answers is where-from.
 * A list that mixes them cannot answer either.
 */
describe("read types", () => {
  it("is the four a read can be, in one list", () => {
    expect(READ_TYPES).toEqual(["ACTUAL", "ESTIMATED", "CORRECTED", "FINAL"]);
    expect(readTypeEnum.options).toEqual(READ_TYPES);
  });

  it("refuses AMI, which names a source and not a type", () => {
    expect(readTypeEnum.safeParse("AMI").success).toBe(false);
    expect(readTypeEnum.safeParse("ESTIMATED").success).toBe(true);
  });

  it("leaves AMI where it belongs — a read's source", () => {
    expect(readSourceEnum.safeParse("AMI").success).toBe(true);
  });
});
