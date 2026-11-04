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

/**
 * Configuration held thirteen entries spanning four unrelated kinds —
 * type-definition lists, tariff design, billing setup and delinquency
 * rules — which is the state Settings was in before it was split. These
 * pin the two groups that came out of it.
 */
describe("sidebar grouping (2026-11-03)", () => {
  it("gives the tariff screens a section of their own", () => {
    /*
     * In the order a tenant meets them: they come for time-of-use
     * pricing, find out seasons exist, and find out holidays do while
     * giving a calendar its hours.
     */
    expect(labelsIn("Tariffs")).toEqual([
      "Rate Schedules",
      "TOU Calendars",
      "Seasons",
      "Holidays",
    ]);
  });

  it("keeps the calendar next to the schedule that prices against it", () => {
    const tariffs = labelsIn("Tariffs");
    /*
     * Both named present first. Without it the adjacency check passes
     * when Rate Schedules is missing altogether — `indexOf` gives -1,
     * and -1 + 1 is the first position — which a mutation run proved.
     */
    expect(tariffs).toContain("Rate Schedules");
    expect(tariffs).toContain("TOU Calendars");
    expect(tariffs.indexOf("TOU Calendars")).toBe(tariffs.indexOf("Rate Schedules") + 1);
  });

  it("leaves the delinquency rules in Configuration, where the rule puts them", () => {
    /*
     * Tried in Collections on 2026-11-03 and reverted. "The two halves
     * of one job belong together" is workflow reasoning, and the
     * section rule above weighs subject instead — deliberately, because
     * the workflow version was found too loose to decide anything. A
     * rule list is a list the business maintains, like Bill Messages and
     * SLAs beside it; moving it by workflow would move those two as
     * well and leave Configuration holding nothing.
     *
     * It is also the only cross-section prefix pair left in the nav
     * (`/delinquency` in Collections against these two), which is what
     * `sidebar-active.test.ts` exercises.
     */
    expect(sectionOf("/delinquency/rules")).toBe("Configuration");
    expect(sectionOf("/delinquency/plan-terms")).toBe("Configuration");
    expect(sectionOf("/delinquency")).toBe("Collections");
  });

  it("leaves Configuration answering one question", () => {
    // What remains is reference data a clerk maintains — no tariffs.
    const config = labelsIn("Configuration");
    expect(config).not.toContain("Rate Schedules");
    expect(config).not.toContain("TOU Calendars");
    expect(config).not.toContain("Seasons");
    expect(config.length).toBeLessThan(13);
  });

  it("gives every item in a section a distinct icon", () => {
    /*
     * The section icons exist so a section is recognised by shape
     * rather than by reading each label, and two identical icons in one
     * section defeat that. Seasons and Billing Cycles were both
     * `faCalendarDays` the day Seasons shipped.
     */
    for (const section of navSections) {
      const icons = section.items.map((i) => i.icon);
      expect(new Set(icons).size).toBe(icons.length);
    }
  });
});

/**
 * Billing work answers to `billing`, not to `accounts`.
 *
 * `POST /billing-runs`, `/:id/post` and `/:id/send` required
 * `accounts:EDIT` until 2026-11-03 — the same verb that lets a CSR
 * correct a mailing address — so every CSR could bill a cycle and send
 * the bills. The menu entries follow the key.
 */
describe("billing is its own authority", () => {
  it("gates the cross-account bill list and the runs on billing", () => {
    const moduleOf = (href: string) =>
      navSections.flatMap((s) => s.items).find((i) => i.href === href)?.module;
    expect(moduleOf("/bills")).toBe("billing");
    expect(moduleOf("/billing-runs")).toBe("billing");
  });

  it("leaves the type-definition lists to whoever maintains the tenant", () => {
    // A Field Technician holds `premises:EDIT` for field work; that is
    // not a reason to let them rewrite the premise type list.
    const moduleOf = (href: string) =>
      navSections.flatMap((s) => s.items).find((i) => i.href === href)?.module;
    expect(moduleOf("/premise-types")).toBe("tenant_profile");
    expect(moduleOf("/account-types")).toBe("tenant_profile");
    expect(moduleOf("/measure-types")).toBe("tenant_profile");
  });
});
