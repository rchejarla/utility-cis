import { test, expect, type Page } from "@playwright/test";

/**
 * Importing a day of interval data, end to end, with the worker started
 * from the platform console.
 *
 * **What this covers that nothing else can.** The api suites drive
 * `processBatch` directly and the web suites mock `apiClient`, so the
 * two halves have never met: no test here had ever sent a real request
 * from a real page. And three separate things have to be true for an
 * interval file to land — the wizard maps and uploads it, the API
 * enqueues it because it is over the sync threshold, and a **worker
 * process** picks it up — of which the middle one is invisible to a
 * unit test and the last one is a process nothing else starts.
 *
 * So the journey is deliberately the awkward one:
 *
 *   1. stop every worker, so nothing is draining the queue
 *   2. import 300 intervals — enough to go async
 *   3. watch it sit there, unprocessed, which is the state a
 *      developer's stack is in by default
 *   4. start a worker from Cluster · Workers
 *   5. watch the batch finish
 *   6. stop the worker again
 *
 * **Two warnings about what this does to a machine.** The Start button
 * sends `queues: []`, a worker serving *every* queue — the API accepts
 * a subset and the page does not offer one — so for as long as step 5
 * runs, anything already waiting in the other nine queues runs too:
 * billing runs start, `notification-send` dispatches outward,
 * `audit-retention` deletes. And this imports real rows into whatever
 * database the stack is pointed at. It is a dev-stack test, run on
 * purpose, not something to put in front of a shared environment.
 */

const ADMIN = "System Admin";
const PLATFORM = "Platform Operator";

/** Enough rows to cross the 250-row threshold and enqueue. */
const ROWS = 300;
const METER = "TOU-AMI-001";

/**
 * A file the import has to work for, not a file built to pass.
 *
 * Hourly intervals from a fixed date well before any billing window,
 * so importing it cannot change a bill and the test can be run twice:
 * the handler replaces a re-imported interval rather than doubling it,
 * which is exactly what a second run exercises.
 */
function intervalCsv(): string {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const lines = ["meter_number,interval_start,length_minutes,quantity,quality"];
  for (let i = 0; i < ROWS; i += 1) {
    const at = new Date(start + i * 3_600_000).toISOString().replace(".000Z", "Z");
    const quantity = (0.3 + (i % 24) * 0.05).toFixed(4);
    lines.push(`${METER},${at},60,${quantity},actual`);
  }
  return lines.join("\n");
}

async function signIn(page: Page, who: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: who, exact: true }).click();
  // The login does a full navigation rather than a router push, so the
  // permission provider remounts with the new token.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/**
 * Stop every worker the console offers a Stop for.
 *
 * Returns how many it stopped. Stop is offered only where the pid is
 * this node's to signal, which on a developer's machine is all of them.
 */
async function stopAllWorkers(page: Page): Promise<number> {
  await page.goto("/platform/cluster/workers");
  let stopped = 0;
  for (;;) {
    const stop = page.getByRole("button", { name: /^Stop/ }).first();
    if ((await stop.count()) === 0) break;
    await stop.click();
    stopped += 1;
    // The page re-reads itself after a stop; wait for the button to go
    // rather than for a fixed time.
    await expect(stop).toHaveCount(0, { timeout: 30_000 });
  }
  return stopped;
}

test("a file too big to import inline waits for a worker, and lands when one starts", async ({
  browser,
}) => {
  /*
   * Two contexts, because the token lives in `localStorage` and the
   * platform actor is a different identity — not a role a tenant user
   * can hold. One context cannot be both.
   *
   * Created here rather than in a hook: a context built in `beforeAll`
   * belongs to the hook's lifetime, and this test opened its first page
   * on an already-closed one.
   */
  const platform = await browser.newContext();
  const admin = await browser.newContext();
  const platformPage = await platform.newPage();
  const adminPage = await admin.newPage();

  try {
    await signIn(platformPage, PLATFORM);
    await signIn(adminPage, ADMIN);

    // ── 1. Nothing draining the queues ───────────────────────────────
    await stopAllWorkers(platformPage);
    await expect(
      platformPage.getByRole("button", { name: /^Stop/ }),
      "no worker should be running before the import",
    ).toHaveCount(0);

    // ── 2. The import ────────────────────────────────────────────────
    await adminPage.goto("/meter-reads/intervals/import");
    await expect(adminPage.getByRole("heading", { name: /import/i }).first()).toBeVisible();

    await adminPage.setInputFiles('input[type="file"]', {
      name: "intervals.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(intervalCsv(), "utf8"),
    });

    // Mapping is by header alias, so the stage should arrive already
    // satisfied — if it does not, the aliases are wrong and that is
    // worth failing for.
    await adminPage.getByRole("button", { name: /Continue/ }).click();

    const commit = adminPage.getByRole("button", { name: new RegExp(`Commit ${ROWS} rows`) });
    await expect(commit, "the preview should offer to commit every row").toBeVisible();
    await commit.click();

    // ── 3. Queued, and going nowhere ─────────────────────────────────
    await expect(
      adminPage.getByText(/Importing in the background/i),
      "over the sync threshold, so the API should enqueue rather than import inline",
    ).toBeVisible({ timeout: 30_000 });

    /*
     * It must still be unfinished a moment later. This is the assertion
     * the whole test exists for: with no worker attached, the batch
     * sits in the queue — the ordinary state of a dev stack, and the
     * one the platform console was built to make visible.
     */
    await adminPage.waitForTimeout(5_000);
    await expect(
      adminPage.getByText(/Status: COMPLETE/i),
      "nothing is draining the queue, so it cannot have finished",
    ).toHaveCount(0);

    // ── 4. Start a worker from the cluster ───────────────────────────
    await platformPage.goto("/platform/cluster/workers");
    await platformPage.getByRole("button", { name: /^Start/ }).first().click();
    await expect(
      platformPage.getByText(/Started — pid \d+/),
      "the console should report the pid it started",
    ).toBeVisible({ timeout: 60_000 });

    // ── 5. The batch finishes ────────────────────────────────────────
    // The wizard polls, so no reload: what a person would see.
    await expect(
      adminPage.getByText(/Status: COMPLETE/i),
      "a worker is attached now, so the queued batch should drain",
    ).toBeVisible({ timeout: 90_000 });

    // ── 6. And the rows are really there ─────────────────────────────
    await adminPage.getByRole("link", { name: /View import details/i }).click();
    await expect(adminPage.getByText(String(ROWS)).first()).toBeVisible();
    await expect(adminPage.getByText(/COMPLETE/i).first()).toBeVisible();
  } finally {
    /*
     * Leave the machine as it was found, pass or fail. A worker started
     * by a test and left running serves every queue for ever, which is
     * worse than the test failing.
     */
    await stopAllWorkers(platformPage).catch(() => {});
    await platform.close().catch(() => {});
    await admin.close().catch(() => {});
  }
});
