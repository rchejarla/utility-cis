import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The theme is set before the first paint, not after hydration.
 *
 * The server cannot know which theme this person chose — it is in
 * `localStorage` — so the markup ships a default and a blocking script in
 * `<head>` corrects it before the body is parsed. Without the script,
 * `ThemeProvider` fixes it in an effect instead, and every load paints
 * dark and then flips, which is what anyone on the light theme saw on
 * every login.
 *
 * jsdom does not run `dangerouslySetInnerHTML` scripts, so this reads the
 * script out of the layout and executes it against a stubbed
 * `localStorage` — which tests the thing that actually ships rather than
 * a copy of it.
 */

const layout = fs.readFileSync(
  path.join(process.cwd(), "app/layout.tsx"),
  "utf8",
);

/** The bootstrap exactly as the layout will inline it. */
function bootstrapSource(): string {
  const match = /const THEME_BOOTSTRAP = `([\s\S]*?)`;/.exec(layout);
  if (!match) throw new Error("THEME_BOOTSTRAP not found in app/layout.tsx");
  return match[1];
}

function runBootstrap(saved: string | null, prefersLight: boolean): string | null {
  document.documentElement.removeAttribute("data-theme");
  const storage = {
    getItem: (k: string) => (k === "theme-mode" ? saved : null),
  };
  const matchMedia = (q: string) => ({ matches: q.includes("light") && prefersLight });

  // eslint-disable-next-line no-new-func
  new Function("localStorage", "matchMedia", "document", bootstrapSource())(
    storage,
    matchMedia,
    document,
  );
  return document.documentElement.getAttribute("data-theme");
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("the theme bootstrap", () => {
  it("is inlined in the document head, where it runs before the body", () => {
    // In <head> and not deferred: after the body is parsed is too late,
    // the first paint has already happened in the wrong theme.
    expect(layout).toMatch(/<head>[\s\S]*THEME_BOOTSTRAP[\s\S]*<\/head>/);
    expect(layout).not.toMatch(/defer|async/);
  });

  it("suppresses the hydration warning on the element it rewrites", () => {
    // The script's whole job is to make the DOM disagree with the HTML
    // the server sent: markup ships data-theme="dark", and anyone on the
    // light theme has data-theme="light" by the time React hydrates.
    // React reports that as a hydration mismatch on <html> — the error
    // this attribute exists for, and the standard answer for an
    // attribute mutated by a pre-hydration inline script.
    //
    // It is on <html> and nowhere else on purpose: the attribute covers
    // one element, not its subtree, so a real mismatch inside the app
    // still gets reported.
    expect(layout).toMatch(/<html[^>]*suppressHydrationWarning/);
  });

  it("honours a saved light theme, which is the case that flashed", () => {
    expect(runBootstrap("light", false)).toBe("light");
  });

  it("honours a saved dark theme", () => {
    expect(runBootstrap("dark", true)).toBe("dark");
  });

  it("follows the system preference when the choice is `system`", () => {
    expect(runBootstrap("system", true)).toBe("light");
    expect(runBootstrap("system", false)).toBe("dark");
  });

  it("falls back to dark when nothing is saved, matching the markup", () => {
    expect(runBootstrap(null, false)).toBe("dark");
  });

  it("ignores a junk value rather than setting it as a theme", () => {
    expect(runBootstrap("chartreuse", false)).toBe("dark");
  });
});
