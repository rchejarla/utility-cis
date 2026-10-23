import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Every `var(--token)` the interface asks for has to be defined.
 *
 * This exists because a misspelled token fails silently and looks like a
 * design choice. CSS drops a declaration whose `var()` cannot be
 * substituted, and what it falls back to depends on the property: an
 * inherited one like `color` takes the parent's value, so an accent link
 * renders as body text; anything else takes its initial value, so
 * `background: var(--nope)` is **transparent** — a filled button becomes
 * white text on the card behind it.
 *
 * Two phantoms had been in the tree since they were first written.
 * `--primary` (15 sites, 11 files) was never defined anywhere: not in
 * globals.css, not in the theme a tenant can override. Nor was
 * `--accent-danger`, whose four sites all carried `, #b00` — so the
 * fallback always won and the AR dialogs reported errors in a hardcoded
 * maroon that is close to unreadable on the dark theme.
 *
 * globals.css is the authority rather than the theme payload, because
 * `theme.service.ts` injects a strict subset of the same names: a token
 * a tenant can override is first a token this file declares.
 */

const WEB = path.resolve(__dirname, "..");
const GLOBALS = path.join(WEB, "app", "globals.css");

/** Directories with no authored CSS in them, or none of ours. */
const SKIP = new Set(["node_modules", ".next", ".turbo", "coverage", "dist"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** The custom properties globals.css declares, in any of its blocks. */
function definedTokens(): Set<string> {
  const css = readFileSync(GLOBALS, "utf8");
  const names = new Set<string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]!);
  return names;
}

describe("CSS custom properties", () => {
  it("defines every token the interface references", () => {
    const defined = definedTokens();
    // Sanity: the regex above found the real file, not an empty match set.
    expect(defined.has("--accent-primary")).toBe(true);
    expect(defined.has("--danger")).toBe(true);

    const undefinedUses: string[] = [];
    for (const file of sourceFiles(WEB)) {
      // This file names the phantoms in its own prose and would
      // otherwise report itself.
      if (file === __filename) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const token = m[1]!;
        if (defined.has(token)) continue;
        undefinedUses.push(`${path.relative(WEB, file)} → ${token}`);
      }
    }

    expect(undefinedUses).toEqual([]);
  });
});
