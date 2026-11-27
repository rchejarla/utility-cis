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
 * **The retry must not race the bundler, which is the other way this
 * fails.** On a worktree with an empty `.next` cache the destination route
 * compiles for the first time *after* a login that worked, so the
 * navigation is slow for a reason that has nothing to do with the click.
 * A short inner wait turns that into a retry, and the retry re-clicks into
 * the in-flight navigation until the outer budget runs out — a test failing
 * sixty seconds after a successful login, which is the same misleading
 * shape as the bug it was added to fix. `dev_worktrees.bat up` produces
 * exactly that cache state, so it is a routine condition here and not a
 * rare one.
 *
 * Two defences, and the numbers below mean these two things:
 *
 * - **The inner `waitForURL` is generous (20s)** because it has to cover a
 *   cold route compile, not just a navigation. The outer budget is three
 *   times that, which is room for a swallowed click plus a cold compile and
 *   no more — the suite's own per-test timeout is 120s.
 *
 *   **Both numbers are ceilings a caller's own budget has to
 *   accommodate**, not costs it pays: on the success path a login is one
 *   click and one navigation. But a change here lands in a caller's
 *   arithmetic, and `interval-import.spec.ts` sizes its `test.setTimeout`
 *   partly on two of these. Raising the outer 60s means raising that.
 * - **The guard is the token, not the URL.** `setAuthToken` writes
 *   `cis_token` before the page navigates, and `page.url()` keeps saying
 *   `/login` until the new document commits, so a URL check cannot tell a
 *   swallowed click from one whose navigation is still in flight. A token
 *   present means the handler ran: wait, never click again.
 */
export async function signIn(page: Page, who: string): Promise<void> {
  await page.goto("/login");
  /*
   * So "a token exists" unambiguously means *this* click worked. A context
   * is fresh per test today, but signing in as somebody means signing in,
   * not inheriting whoever was here before.
   */
  await page.evaluate(() => window.localStorage.removeItem("cis_token"));

  const pill = page.getByRole("button", { name: who, exact: true });
  const offLogin = (url: URL): boolean => !url.pathname.startsWith("/login");

  await expect(async () => {
    if (!(await handlerRan(page))) {
      await pill.click({ timeout: 5_000 });
    }
    // A full navigation rather than a router push, so the permission
    // provider remounts with the new token.
    await page.waitForURL(offLogin, { timeout: 20_000 });
  }).toPass({ timeout: 60_000 });
}

/** Whether the login handler has already run, whatever the URL still says. */
async function handlerRan(page: Page): Promise<boolean> {
  try {
    return (await page.evaluate(() => window.localStorage.getItem("cis_token"))) !== null;
  } catch {
    /*
     * The execution context was destroyed, which happens because the page
     * is navigating — and it only navigates once the click took. Treat it
     * as done: clicking again is the thing to avoid.
     */
    return true;
  }
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
