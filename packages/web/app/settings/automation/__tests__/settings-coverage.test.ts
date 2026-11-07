import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AutomationConfigSchema,
  AutomationConfigPatchSchema,
  SchedulerSettingPatchSchema,
  SCHEDULER_DEFINITIONS,
  SCHEDULER_SETTINGS_SCHEMAS,
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
     *
     * **The exception is a job with knobs of its own** (2026-11-07).
     * An enable switch and a run hour are the same control for every
     * job, so they come from the loop; `graceHours` belongs to one job
     * and means something only there, and a loop rendering it would
     * label two number boxes by their key names and explain neither. So
     * a scheduler in `SCHEDULER_SETTINGS_SCHEMAS` may be named here —
     * and the test below insists it is.
     */
    expect(source).toContain("SCHEDULER_DEFINITIONS");
    for (const def of SCHEDULER_DEFINITIONS) {
      if (def.key in SCHEDULER_SETTINGS_SCHEMAS) continue;
      expect(source).not.toContain(`"${def.key}"`);
    }
  });

  /**
   * The same drift, one level down.
   *
   * The interval-coverage sweep's `graceHours` and `lookbackDays`
   * shipped with a Zod schema, defaults, validation in the patch path
   * and a jsonb column to live in — and no control anywhere. The page
   * even sent `settings` with every scheduler patch; the object was
   * always empty, so the only way to change either value was SQL.
   * Nothing failed, because nothing compared the schema with the screen.
   */
  describe("every scheduler knob is reachable on the page", () => {
    const entries = Object.entries(SCHEDULER_SETTINGS_SCHEMAS) as Array<
      [string, { shape: Record<string, unknown> }]
    >;

    it("has schedulers with knobs to check", () => {
      // Guards the guard: an empty map would make the loop vacuous.
      expect(entries.length).toBeGreaterThan(0);
    });

    it.each(entries.flatMap(([key, schema]) =>
      Object.keys(schema.shape).map((field) => [key, field] as const),
    ))("renders %s's %s", (_key, field) => {
      expect(source).toContain(field);
    });
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
