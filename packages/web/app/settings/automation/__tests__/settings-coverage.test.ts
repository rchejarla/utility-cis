import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AutomationConfigSchema } from "@utility-cis/shared";

/**
 * Drift guard: every tenant-editable automation setting must be rendered
 * by the Automation page.
 *
 * This exists because `autoPostBills` shipped as an orphan field — the
 * service returned it, `AutomationConfigPatchSchema` accepted it, and the
 * one screen that renders that exact payload never drew a control for it.
 * The result was a fully tested backend capability (manual bill posting)
 * that no tenant could reach except by SQL. Nothing failed, because
 * nothing compared the two.
 *
 * The keys come from the schema rather than a hardcoded list, so a
 * setting added to `AutomationConfigSchema` is covered the day it lands
 * instead of the day someone remembers this file.
 *
 * What this cannot prove: that the control is wired to the right field,
 * is reachable, or saves. It proves only that the key is mentioned in the
 * page source — enough to catch a field nobody rendered at all, which is
 * the mistake that actually happened.
 */

const PAGE = path.resolve(__dirname, "../page.tsx");

/**
 * `delinquencyLastRunAt` is written by the delinquency worker and omitted
 * from the patch schema, so it is deliberately not editable. The page is
 * expected to display it, not offer a control.
 */
const WORKER_OWNED = "delinquencyLastRunAt";

describe("Automation settings page covers the whole config", () => {
  const source = readFileSync(PAGE, "utf8");
  const editableKeys = Object.keys(AutomationConfigSchema.shape).filter(
    (k) => k !== WORKER_OWNED,
  );

  it("derives a non-trivial key list from the schema", () => {
    // Guards the guard: if the import or `.shape` ever yields nothing,
    // every assertion below would vacuously pass.
    expect(editableKeys.length).toBeGreaterThan(5);
    expect(editableKeys).toContain("autoPostBills");
  });

  it.each(
    Object.keys(AutomationConfigSchema.shape).filter((k) => k !== WORKER_OWNED),
  )("renders a control for %s", (key) => {
    expect(source).toContain(key);
  });

  it("does not offer an editable control for the worker-owned field", () => {
    // The page may show the timestamp; it must not patch it. The save
    // path skips it explicitly, and that skip is the thing worth pinning.
    expect(source).toMatch(/delinquencyLastRunAt"?\s*\)?\s*return/);
  });
});
