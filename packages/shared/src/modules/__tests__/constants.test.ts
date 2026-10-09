import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES, MODULE_META } from "../constants";

/**
 * The module list exists twice and must agree.
 *
 * `seed.js` at the repo root keeps its own `allModules` array, because it
 * is deliberately runnable as plain `node seed.js` with no tsx and so
 * cannot import this TypeScript constant. That duplication is the
 * problem these tests exist for: a module present in MODULES but absent
 * from the seeder is enabled for no tenant, so its routes answer 403
 * MODULE_DISABLED on every seeded database — while the routes' own tests
 * pass, because integration fixtures create their tenant_module rows by
 * hand. That is exactly how `payments` shipped unreachable in AR slice 2
 * until this test was written.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_JS = path.resolve(__dirname, "../../../../../seed.js");

function seederModuleKeys(): string[] {
  const src = readFileSync(SEED_JS, "utf8");
  const block = /const allModules = \[([\s\S]*?)\];/.exec(src);
  // If the shape of seed.js changes so this no longer matches, fail
  // loudly rather than comparing against an empty list and passing.
  expect(block, `could not find allModules in ${SEED_JS}`).not.toBeNull();
  const keys = [...block![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  expect(keys.length).toBeGreaterThan(20);
  return keys;
}

describe("MODULES and seed.js agree", () => {
  it("seeds every module key, so no module ships unreachable", () => {
    const seeded = seederModuleKeys();
    const missing = MODULES.filter((m) => !seeded.includes(m));
    expect(missing).toEqual([]);
  });

  it("seeds no key that is not a real module", () => {
    const seeded = seederModuleKeys();
    const unknown = seeded.filter((m) => !(MODULES as readonly string[]).includes(m));
    expect(unknown).toEqual([]);
  });
});

describe("MODULE_META", () => {
  it("has an entry for every module, so nothing renders unlabelled", () => {
    const missing = MODULES.filter((m) => !(m in MODULE_META));
    expect(missing).toEqual([]);
  });

  it("gives every module a non-empty label and icon", () => {
    for (const m of MODULES) {
      const meta = MODULE_META[m];
      expect(meta.label.length, `${m} label`).toBeGreaterThan(0);
      expect(meta.icon.length, `${m} icon`).toBeGreaterThan(0);
    }
  });
});
