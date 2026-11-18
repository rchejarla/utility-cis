import { defineConfig } from "@playwright/test";

/**
 * Browser tests, for the things no other suite here can see.
 *
 * The web package has 824 tests and every one of them mocks
 * `apiClient` and runs in jsdom, so nothing in this repo had ever
 * exercised a real request from a real page, and nothing had ever
 * rendered one. That is not a gap these tests close by themselves —
 * layout, wording and missing features all need a person — but it is
 * the one class they close completely: **a journey that crosses the
 * browser, the API, the database, a queue and a worker process.**
 *
 * Against the running dev stack, deliberately. `webServer` could start
 * its own, but the API, the web app, Postgres and Redis are four
 * processes and a container each, and a suite that boots them is a
 * suite nobody runs locally. `reuseExistingServer` means these go
 * against whatever is already up, and say so clearly when it is not.
 *
 * **Playwright's own Chromium**, installed with
 * `npx playwright install chromium`, and not `channel: "chrome"`.
 *
 * The first attempt used the installed Chrome to avoid the 123 MB
 * download. It launched — Playwright reported its version — and then
 * every page closed before a navigation could finish, with the useless
 * "Target page, context or browser has been closed". The cause showed
 * up on the desktop, not in the log: **Chrome is managed by enterprise
 * policy here, and the policy blocks launching it with the
 * command-line flags automation uses** ("This application has been
 * blocked. Command-line that bypass managed extension is restricted").
 *
 * So a managed Chrome cannot be driven by Playwright at all on this
 * machine, whatever the version, and the downloaded browser is not an
 * optimisation to argue about — it is the only one that works. It is
 * also what the runner is tested against, which is the better default
 * anyway.
 *
 * ## An unhydrated page impersonates a broken one
 *
 * **Playwright's actionability checks do not cover "React has attached
 * the handler."** They cover visible, enabled, stable and
 * receives-events, and a server-rendered control passes all four before
 * any of its JavaScript has run. A click delivered in that gap is
 * swallowed in total silence: no request, no error, nothing in the
 * console, nothing different on the page. Whatever the click was supposed
 * to cause then times out tens of seconds later, pointing nowhere near
 * the cause — a swallowed sign-in reads as a broken login or a CORS
 * problem.
 *
 * **On an idle machine the handler always wins the race**, so a spec with
 * this bug passes indefinitely and starts failing the day something else
 * is using the CPU. That is the worst available shape for a flake: it
 * arrives long after the code that caused it, and it arrives as a
 * different problem.
 *
 * Measured rather than inferred, on 2026-11-18 with the machine down to
 * ~7 GB free and 18 node processes: a click issued immediately after
 * `goto` produced **no POST to `/auth/dev-login` at all**, left
 * `cis_token` null and stayed on `/login`, with React's own DevTools
 * console banner arriving *after* the click; the same script with a
 * six-second wait signed in. `support/dev-stack.ts`'s `signIn` therefore
 * **retries the click until it takes** rather than waiting a fixed time,
 * which would be wasted on a fast machine and still a guess on a slow
 * one.
 *
 * **It is not specific to sign-in, and not specific to automation.** Any
 * spec here that clicks a React control straight after navigating has the
 * same latent flake. And it caught a second session the same day from the
 * other direction: driving the merged tree by hand, three screenshots in
 * a row came back blank, were reported as a page that "renders chrome but
 * the content area is empty", and a diagnosis was begun — on a page that
 * had simply not hydrated yet. The accessibility tree showed the content
 * was all there. So before concluding a page is broken, confirm it has
 * hydrated: read the tree, or wait for something only the client could
 * have produced.
 */
/**
 * Both halves of the stack, derived once.
 *
 * **`webServer` used to name 4001 and 4000 outright while `baseURL` was
 * overridable**, which made a `reuseExistingServer` health check prove
 * nothing: a run pointed elsewhere by `E2E_BASE_URL` checked one stack and
 * tested another, and reported success for finding the wrong one. That is
 * not hypothetical — every early run of the read-routes journey satisfied
 * this block from the coordinator's stack on 4000/4001 while testing
 * against its own on 4010/4011. The outcome was harmless and the evidence
 * was worthless, which is the problem: ruling out "this passed against a
 * stack nobody meant to exercise" is most of why a browser suite exists.
 *
 * Two stacks on non-default ports is now an ordinary state here —
 * `dev_worktrees.bat` makes worktrees that expect exactly that — so the
 * API's health URL comes from its own variable rather than assuming it sits
 * one port above the web app.
 *
 * The `command`s below only ever start a stack on whatever ports the
 * packages' own env says, so **a run pointed elsewhere must already have
 * its stack up**. It will now fail naming the URL it waited for instead of
 * passing against a different one.
 */
const WEB_URL = process.env.E2E_BASE_URL ?? "http://localhost:4000";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

export default defineConfig({
  testDir: "./e2e",
  /*
   * One worker. These tests start and stop a **real worker process**
   * and import into a shared dev database — two of them running at
   * once would fight over both.
   */
  workers: 1,
  fullyParallel: false,
  /*
   * No retries. A retried browser test hides exactly the flakiness
   * worth knowing about, and these drive a queue whose timing is the
   * thing under test.
   */
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
  webServer: [
    {
      // Already running in normal use; started here when it is not.
      command: "pnpm --filter @utility-cis/api dev",
      url: `${API_URL}/health`,
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @utility-cis/web dev",
      url: `${WEB_URL}/login`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
