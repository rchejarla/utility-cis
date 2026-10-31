import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AutomationConfigSchema,
  AutomationConfigPatchSchema,
  SchedulerSettingPatchSchema,
  SCHEDULER_DEFINITIONS,
} from "@utility-cis/shared";

/**
 * Drift guard: every tenant-editable automation setting must be
 * reachable from the Automation page.
 *
 * This exists because `autoPostBills` shipped as an orphan field — the
 * service returned it, the patch schema accepted it, and the one screen
 * that renders that exact payload never drew a control for it. A fully
 * tested backend capability no tenant could reach except by SQL, and
 * nothing failed, because nothing compared the two.
 *
 * **What it guards changed on 2026-10-31.** Per-scheduler settings moved
 * from a column group per job to a row per job, and the page renders
 * them by looping over `SCHEDULER_DEFINITIONS`. A scheduler added to
 * that catalogue therefore gets its control without the page being
 * touched — the drift this file was written to catch is now structurally
 * impossible for schedulers, so the assertions below pin the *loop*
 * rather than the field names. What remains driftable is the
 * tenant-wide settings, which are still rendered one by one.
 */

const PAGE = path.resolve(__dirname, "../page.tsx");

describe("Automation settings page covers the whole config", () => {
  const source = readFileSync(PAGE, "utf8");
  const tenantWideKeys = Object.keys(AutomationConfigSchema.shape).filter(
    (k) => k !== "schedulers",
  );

  it("derives a non-trivial key list from the schema", () => {
    // Guards the guard: if the import or `.shape` ever yields nothing,
    // every assertion below would vacuously pass.
    expect(tenantWideKeys.length).toBeGreaterThan(3);
    expect(tenantWideKeys).toContain("autoPostBills");
    expect(SCHEDULER_DEFINITIONS.length).toBeGreaterThan(3);
  });

  it.each(tenantWideKeys)("renders a control for %s", (key) => {
    expect(source).toContain(key);
  });

  it("renders schedulers from the catalogue rather than naming them one by one", () => {
    /*
     * The assertion that keeps the new shape honest. If someone goes
     * back to a hand-written block per job, adding a scheduler silently
     * stops appearing on screen again — which is exactly the failure
     * this file was created for, in its new form.
     */
    expect(source).toContain("SCHEDULER_DEFINITIONS");
    for (const def of SCHEDULER_DEFINITIONS) {
      expect(source).not.toContain(`"${def.key}"`);
    }
  });

  it("gives a dispatcher's own timestamp no way in, by construction", () => {
    /*
     * `lastRunAt` used to be omitted from the patch schema by name, and
     * the page had to remember to skip it — a rule in two places. It is
     * now absent from the patch shape entirely, so a tenant cannot
     * rewrite the record that missed-tick recovery reads even if the
     * page sent it. Asserted against the schema rather than the page
     * source, because that is where the guarantee now lives.
     */
    expect(Object.keys(SchedulerSettingPatchSchema.shape)).not.toContain("lastRunAt");
    expect(Object.keys(AutomationConfigPatchSchema._def.schema.shape)).not.toContain("lastRunAt");
  });
});
