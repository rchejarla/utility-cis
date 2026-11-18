import { expect, type Page } from "@playwright/test";

/**
 * Signing in to the dev stack, and getting the token the page was given.
 *
 * Shared by every browser spec, because `signIn` carries a correctness
 * requirement that is not visible in its five lines — and two copies of
 * that is how one of them gets fixed and the other does not. It lived in
 * `interval-import.spec.ts` and was copied into the read-routes journey;
 * the hydration bug below was in both.
 */

/**
 * Click the dev-login pill for `who` and wait to leave `/login`.
 *
 * **The click is retried until it takes, and that is the whole point.**
 * Playwright's actionability checks cover visible, enabled, stable and
 * receives-events; **none of them covers "React has attached the
 * handler"**. A click that lands on a server-rendered button before
 * hydration is swallowed in silence: no error, no request, no change on
 * the page — and then `waitForURL` times out thirty seconds later, which
 * reads exactly like a broken login or a CORS problem. The ui stream lost
 * time to that reading before measuring it.
 *
 * It is not hypothetical and it is not a fixed-delay problem. Measured on
 * 2026-11-18 against a machine down to ~7 GB free with 18 node processes:
 * a click issued immediately after `goto` produced **no POST to
 * `/auth/dev-login` at all**, left `cis_token` null and stayed on
 * `/login`, with React's own console banner arriving after the click; the
 * same script with a six-second wait signed in. On a fast machine the
 * handler is always there first, which is why this had never failed.
 *
 * So: retry, rather than sleep. A sleep long enough for a loaded machine
 * is wasted on every run on an idle one, and still guesses.
 *
 * The URL is checked **before** clicking on each attempt, so a first click
 * that worked but navigated slowly is not followed by a second one
 * hunting for a button that has gone.
 */
export async function signIn(page: Page, who: string): Promise<void> {
  await page.goto("/login");
  const pill = page.getByRole("button", { name: who, exact: true });
  const offLogin = (url: URL): boolean => !url.pathname.startsWith("/login");

  await expect(async () => {
    if (!offLogin(new URL(page.url()))) {
      await pill.click({ timeout: 5_000 });
    }
    // A full navigation rather than a router push, so the permission
    // provider remounts with the new token.
    await page.waitForURL(offLogin, { timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/**
 * The token the page is holding, for a spec's own API calls.
 *
 * A journey belongs in the browser; calls made with this are setup and
 * verification — what is already in the database, and what actually landed.
 * Reading a result off the screen that just wrote it would let a page
 * rendering its own optimistic guess pass a test about what posted.
 */
export async function bearer(page: Page): Promise<string> {
  const token = await page.evaluate(() => window.localStorage.getItem("cis_token"));
  expect(token, "signing in should leave a token in localStorage").toBeTruthy();
  return `Bearer ${token}`;
}
