import { describe, it, expect } from "vitest";
import {
  DATA_EXCEPTION_KINDS,
  DATA_EXCEPTION_STATUSES,
  meterDataExceptionQuerySchema,
} from "../meter-data-exception";

/**
 * The interval-coverage queue's vocabulary and its list query.
 *
 * Both lists are **CHECK constraints in the database**, not Postgres
 * enums, so nothing generates them: `kind` and `status` are VARCHARs
 * whose column types are wider than their vocabularies. They were
 * written down twice — once in the migration's CHECKs, once as a union
 * type inside the API — and the screen that lists these rows needs them
 * a third time, for its filter pills. A pill offering a value the table
 * cannot hold returns nothing and explains nothing, which this repo has
 * already paid for three times over.
 */
describe("the interval-coverage queue's vocabulary", () => {
  it("is the four kinds the table's CHECK allows", () => {
    expect(DATA_EXCEPTION_KINDS).toEqual(["gap", "overlap", "overrun", "missing_reading"]);
  });

  it("is the four statuses the table's CHECK allows", () => {
    expect(DATA_EXCEPTION_STATUSES).toEqual(["open", "accepted", "estimated", "resolved"]);
  });
});

describe("the interval-coverage queue's list query", () => {
  it("pages and sorts by the window, newest first", () => {
    const q = meterDataExceptionQuerySchema.parse({});
    expect(q).toMatchObject({ page: 1, limit: 20, sort: "windowStart", order: "desc" });
  });

  /*
   * No default status, like every other list query here. A default
   * would be a filter the caller never asked for and cannot turn off —
   * and "show me everything, including what the sweep has already
   * resolved" is a real question. The screen defaults its own pill to
   * `open`, which is where the work is.
   */
  it("filters nothing unless asked", () => {
    const q = meterDataExceptionQuerySchema.parse({});
    expect(q.status).toBeUndefined();
    expect(q.kind).toBeUndefined();
    expect(q.meterId).toBeUndefined();
  });

  it("takes a status, a kind and a meter", () => {
    const q = meterDataExceptionQuerySchema.parse({
      status: "accepted",
      kind: "missing_reading",
      meterId: "00000000-0000-4000-8000-000000000001",
    });
    expect(q.status).toBe("accepted");
    expect(q.kind).toBe("missing_reading");
  });

  it("refuses a status the table cannot hold", () => {
    expect(meterDataExceptionQuerySchema.safeParse({ status: "ignored" }).success).toBe(false);
  });

  it("refuses an unknown filter rather than ignoring it", () => {
    // `.strict()`, so a misspelled filter is an error instead of a
    // query that quietly returns the unfiltered list.
    expect(meterDataExceptionQuerySchema.safeParse({ kinds: "gap" }).success).toBe(false);
  });
});
