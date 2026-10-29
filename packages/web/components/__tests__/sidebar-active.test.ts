import { describe, it, expect } from "vitest";
import { activeHrefFor, sectionTitleFor, navSections } from "../sidebar";

/**
 * Which nav item reads as "you are here".
 *
 * The answer has to be settled across every section at once. It used to
 * be settled inside each section, which worked only while competing
 * items shared a section: once the delinquency config pages moved to
 * Configuration, `/delinquency` in Collections had nothing longer beside
 * it to lose to, so opening Configuration → Payment Plan Terms lit up
 * Collections → Delinquency as well and swapped the open section out
 * from under the page being displayed.
 *
 * Decided over every declared item rather than the ones this operator
 * may see: a page hidden from someone's menu should light up nothing,
 * not hand the highlight to a shorter prefix they happen to hold.
 */

const active = (pathname: string) => activeHrefFor(pathname, navSections);

describe("which nav item is active", () => {
  it("does not light up a shorter prefix that lives in another section", () => {
    // Collections holds `/delinquency`; Configuration holds this page.
    expect(active("/delinquency/plan-terms")).toBe("/delinquency/plan-terms");
  });

  it("does the same for the rules page beside it", () => {
    expect(active("/delinquency/rules")).toBe("/delinquency/rules");
  });

  it("still lights up a section's own landing page", () => {
    expect(active("/delinquency")).toBe("/delinquency");
  });

  it("still prefers the longer match when both items share a section", () => {
    // The case the original per-section guard did handle, kept honest.
    expect(active("/delinquency/shutoff-eligible")).toBe("/delinquency/shutoff-eligible");
  });

  it("keeps a detail route on the list it belongs to", () => {
    expect(active("/delinquency/rules/a-rule-id")).toBe("/delinquency/rules");
  });

  it("answers nothing for a path no item claims", () => {
    expect(active("/nowhere")).toBeNull();
  });
});

/**
 * Which section the sidebar opens on arrival.
 *
 * A second copy of the matching rule lived here and had no longest-match
 * logic at all — it took the first section holding any prefix match.
 * Collections precedes Configuration, so opening Payment Plan Terms
 * closed the section the operator had just used and opened Collections
 * instead, on top of highlighting the wrong item.
 */
describe("which section opens for a route", () => {
  it("opens the section owning the active item, not the first prefix match", () => {
    expect(sectionTitleFor("/delinquency/plan-terms", navSections)).toBe("Configuration");
  });

  it("opens Configuration for the rules page beside it", () => {
    expect(sectionTitleFor("/delinquency/rules", navSections)).toBe("Configuration");
  });

  it("still opens Collections for the delinquency landing page", () => {
    expect(sectionTitleFor("/delinquency", navSections)).toBe("Collections");
  });

  it("still opens Collections for the shut-off queue", () => {
    expect(sectionTitleFor("/delinquency/shutoff-eligible", navSections)).toBe("Collections");
  });

  it("answers nothing when no item claims the path, so the stored choice stands", () => {
    expect(sectionTitleFor("/nowhere", navSections)).toBeNull();
  });
});
