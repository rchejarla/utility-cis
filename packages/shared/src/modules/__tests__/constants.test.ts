import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES, MODULE_META } from "../constants";

/**
 * The module list exists once.
 *
 * It used to exist twice: `seed.js` kept its own `allModules` array,
 * because it is runnable as plain `node seed.js` with no tsx and so could
 * not import this TypeScript constant. That duplication is how
 * `payments` shipped unreachable in AR slice 2 — present in MODULES,
 * absent from the seeder, so its routes answered 403 MODULE_DISABLED on
 * every seeded database while the routes' own tests passed, because
 * integration fixtures create their `utility_module` rows by hand.
 *
 * The tests that compared the two lists are gone with the second list:
 * since 2026-10-18 the seed shells out to `provisionTenant`, which reads
 * MODULES directly, so agreement is structural rather than something to
 * check. `provisioning.integration.test.ts` asserts the remaining
 * guarantee — that provisioning enables exactly MODULES and nothing it
 * no longer has.
 *
 * What is still worth policing is that the duplication does not come
 * back, which is what this test does. It was itself red from the moment
 * the seed changed until 2026-10-19, because nothing ran this package's
 * suite in between.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_JS = path.resolve(__dirname, "../../../../../seed.js");

describe("the module list is not duplicated", () => {
  it("keeps no second list of module keys in seed.js", () => {
    const src = readFileSync(SEED_JS, "utf8");
    expect(src).not.toMatch(/const allModules\s*=\s*\[/);
  });

  it("provisions the tenant through the script that owns MODULES", () => {
    // If this goes, the seed has started creating utility_module rows
    // itself again and the comparison tests above should come back.
    const src = readFileSync(SEED_JS, "utf8");
    expect(src).toMatch(/provision-tenant\.ts/);
    expect(MODULES.length).toBeGreaterThan(20);
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
