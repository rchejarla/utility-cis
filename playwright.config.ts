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
 */
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
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000,
  },
  webServer: [
    {
      // Already running in normal use; started here when it is not.
      command: "pnpm --filter @utility-cis/api dev",
      url: "http://localhost:3001/health",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @utility-cis/web dev",
      url: "http://localhost:3000/login",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
