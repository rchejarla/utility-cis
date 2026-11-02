import { describe, it, expect } from "vitest";
import { navSections } from "../sidebar";

/**
 * Where a nav entry sits is the only clue a CSR has about what it
 * covers, so a misfiled one is a feature nobody finds.
 *
 * "Service Holds" sat under **Solid Waste**, beside Containers and
 * RAMS Events, because suspensions were built during the solid-waste
 * phase: the motivating case was a vacation hold on a cart, and spec 12
 * is where container billing lives. But `ServiceSuspension` hangs off a
 * `ServiceAgreement` and nothing on it is commodity-aware —
 * `suspensionType`, `billingSuspended`, `prorateOnStart/End`, the dates
 * — so it holds water, gas and electric exactly as readily as garbage.
 * Spec 12 admits as much in its own entity note.
 *
 * The consequence was specific: a CSR asked to hold a water account had
 * no reason to open Solid Waste, and the only general way to do it was
 * a URL. A hold is an event on an agreement, so it belongs beside
 * Agreements under Operations.
 *
 * `ramsNotified` / `ramsNotifiedAt` stay on the entity — solid-waste-only
 * fields on an otherwise general thing, and a real integration reads
 * them. Those are about the collection crew, not about where the screen
 * lives.
 */

function sectionOf(href: string): string | undefined {
  return navSections.find((s) => s.items.some((i) => i.href === href))?.title;
}

function labelsIn(title: string): string[] {
  return navSections.find((s) => s.title === title)?.items.map((i) => i.label) ?? [];
}

describe("sidebar placement", () => {
  it("files Service Holds under Operations, not Solid Waste", () => {
    expect(sectionOf("/service-suspensions")).toBe("Operations");
  });

  it("puts it next to Agreements, the noun it hangs off", () => {
    const ops = labelsIn("Operations");
    expect(ops).toContain("Service Holds");
    expect(ops.indexOf("Service Holds")).toBe(ops.indexOf("Agreements") + 1);
  });

  it("leaves the genuinely solid-waste screens where they are", () => {
    expect(sectionOf("/containers")).toBe("Solid Waste");
    expect(sectionOf("/service-events")).toBe("Solid Waste");
    // The section still has entries of its own, so it does not become a
    // header that opens onto nothing.
    expect(labelsIn("Solid Waste").length).toBeGreaterThan(0);
  });

  it("lists every entry exactly once across all sections", () => {
    // A move is a cut and a paste, and the failure mode is a paste
    // without the cut.
    const hrefs = navSections.flatMap((s) => s.items.map((i) => i.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
