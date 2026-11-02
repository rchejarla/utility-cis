import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import { VARIABLE_NAMESPACES } from "../grammar-introspection.js";
import { buildRegistry } from "../../rate-engine-registry.js";

/**
 * The variable namespaces the rate-schedule editor offers must be the
 * ones the loaders can actually answer.
 *
 * Two hand-maintained lists describe the same thing: each loader's
 * `capabilities()`, which is what the registry routes a key by, and
 * `VARIABLE_NAMESPACES`, which `rate-grammar.service.ts` serves to the
 * editor. Nothing kept them in step, and they drift in both directions
 * with the same symptom — silence:
 *
 * - a loader gains a capability and the editor never offers it, so the
 *   feature is built and unreachable;
 * - a namespace is listed that no loader answers, so an author picks it,
 *   saves a schedule, and the failure arrives at the first bill.
 *
 * Written after adding `meter:tou:<meter_id>:<peak_code>` for spec 26
 * meant hand-editing the second list, with nothing to say it was
 * needed.
 */

/*
 * A registry built for its *shape*. `capabilities()` is a pure method on
 * every loader — it returns declared patterns and touches neither the
 * client nor the ids — so this needs no database and no container, which
 * is what keeps the guard in the unit suite where it will actually be
 * run.
 */
const registry = buildRegistry(null as unknown as PrismaClient, {
  utilityId: "00000000-0000-4000-8000-000000000001",
  saId: "sa-1",
  accountId: "a-1",
  premiseId: "p-1",
  period: { startDate: new Date(Date.UTC(2026, 0, 1)), endDate: new Date(Date.UTC(2026, 0, 31)) },
});

/**
 * Every pattern a loader can actually answer.
 *
 * `unsupported` capabilities are excluded: they are declared so the
 * registry gives a recognised key a clear error instead of "no
 * registered loader", and documenting them would have the editor offer
 * an author a variable that always fails.
 */
const loaderPatterns = new Set(
  registry
    .describeAll()
    .filter((c) => !c.unsupported)
    .map((c) => c.pattern),
);

// Widened to `string`: `VARIABLE_NAMESPACES` is `as const`, so its
// patterns carry a literal union type and a set of them would not accept
// a loader's plain string.
const documentedPatterns = new Set<string>(VARIABLE_NAMESPACES.map((v) => v.pattern));

describe("VARIABLE_NAMESPACES against the loaders", () => {
  it("documents every pattern a loader can answer", () => {
    const undocumented = [...loaderPatterns].filter((p) => !documentedPatterns.has(p)).sort();
    expect(undocumented).toEqual([]);
  });

  it("documents nothing no loader answers", () => {
    /*
     * The worse direction of the two. An editor offering a variable
     * nothing supplies produces a schedule that saves cleanly and fails
     * at rating — by which time somebody has published it.
     */
    const unanswerable = [...documentedPatterns].filter((p) => !loaderPatterns.has(p)).sort();
    expect(unanswerable).toEqual([]);
  });

  it("includes the TOU bucket namespace", () => {
    // The one that prompted this file: a TOU component cannot be
    // authored without it.
    expect(documentedPatterns.has("meter:tou:<meter_id>:<peak_code>")).toBe(true);
  });
});
