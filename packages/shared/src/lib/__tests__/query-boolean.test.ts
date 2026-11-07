import { describe, it, expect } from "vitest";
import { queryBoolean } from "../base-list-query";
import { meterReadQuerySchema } from "../../validators/meter-read";

/**
 * A boolean that survives the journey through a URL.
 *
 * `z.coerce.boolean()` is `Boolean(input)`, and a query string carries
 * strings: `Boolean("false")` is **true**. So every filter written that
 * way answered "yes" to both of its own options — and the one that
 * looked like it worked only did so because its other value happened to
 * agree.
 *
 * Reported from the Meter Reads screen on 2026-11-07: the Exceptions
 * pill showed rows only with no filter applied. Both options asked for
 * *reads that have an exception*, and the seeded database has none, so
 * "No exception" returned an empty table — a filter that had never
 * worked, on a screen where a filter returning nothing reads as "there
 * is nothing".
 *
 * The same mistake had already been found once, on the rate-schedule
 * list, and fixed only there (its comment spells out this exact
 * arithmetic). Eight more sites kept it.
 */
describe("queryBoolean", () => {
  it("reads the strings a select box and a URL actually send", () => {
    expect(queryBoolean.parse("true")).toBe(true);
    // The whole point: `Boolean("false")` is true, and this is not.
    expect(queryBoolean.parse("false")).toBe(false);
  });

  it("takes a real boolean too, for a JSON body", () => {
    expect(queryBoolean.parse(true)).toBe(true);
    expect(queryBoolean.parse(false)).toBe(false);
  });

  it("refuses anything else rather than guessing", () => {
    // A filter that silently means `true` for "0", "no" or "yes" is how
    // this class of bug stays invisible: there is no wrong answer to
    // see, only a list that looks complete.
    for (const bad of ["0", "1", "yes", "no", "", "FALSE ", null, 0]) {
      expect(queryBoolean.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the meter-read list query's two boolean filters", () => {
  it("asks for reads without an exception when told false", () => {
    const q = meterReadQuerySchema.parse({ hasException: "false" });
    expect(q.hasException).toBe(false);
  });

  it("asks for reads with one when told true", () => {
    const q = meterReadQuerySchema.parse({ hasException: "true" });
    expect(q.hasException).toBe(true);
  });

  it("does the same for the billed filter, which had it too", () => {
    expect(meterReadQuerySchema.parse({ isFrozen: "false" }).isFrozen).toBe(false);
    expect(meterReadQuerySchema.parse({ isFrozen: "true" }).isFrozen).toBe(true);
  });

  it("leaves both unset when neither pill is chosen", () => {
    const q = meterReadQuerySchema.parse({});
    expect(q.hasException).toBeUndefined();
    expect(q.isFrozen).toBeUndefined();
  });
});
