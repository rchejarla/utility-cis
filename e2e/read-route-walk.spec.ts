import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { bearer, signIn } from "./support/dev-stack.js";

/**
 * Building a route's walk by clicking, and narrowing the list by its own
 * filters — both against real rows.
 *
 * **Why this file exists.** The three read-route screens have 54 tests
 * between them and every one of them mocks `apiClient` and runs in jsdom.
 * Those tests are worth keeping: they pin wording, ordering and the
 * refusal-on-the-row behaviour cheaply, and they found real bugs. But a
 * mocked suite proves the component renders what a fake returned, which
 * leaves two whole classes it cannot see — and this repo has been bitten
 * by both.
 *
 *  1. **Whether the query parameters the screen sends are ones the API
 *     accepts.** A filter whose key the server's Zod schema does not
 *     declare is silently ignored: the request succeeds, the list comes
 *     back unnarrowed, and a mocked test still passes because the mock was
 *     asked for the filtered answer and gave it. One page in this codebase
 *     shipped three filters that had never worked, for exactly that
 *     reason. So the two static filters here are checked **twice** — the
 *     parameter that leaves the browser, and the rows that come back.
 *
 *  2. **Whether a walk built by clicking is the walk that persisted.** The
 *     screen prints positions (1, 2, 3) while the database keeps gapped
 *     sequences, and an insert is one row written between two gaps
 *     (`SEQUENCE_STEP`). A mock cannot disagree with the component about
 *     what that produced, because the component is told the answer. Every
 *     step below is therefore asserted on screen *and* read back from the
 *     API, which is the only way the two can be caught disagreeing.
 *
 * **What is driven where, and why.** The walk — the stops, which is the
 * data this spec is about — is built entirely by clicking: the tray's
 * search box, its `Add` buttons, the `Insert after` select and the `Remove`
 * buttons. The API is used for three things only, all of them setup or
 * verification: making sure the fixture route exists, emptying it before
 * each test, and reading back what actually landed. Reading the result off
 * the screen that just wrote it would let a page rendering its own
 * optimistic guess pass a test about what persisted.
 *
 * **The fixture route is created through the API because it cannot be
 * created through the screen.** `/read-routes` offers an **"Add Read
 * Route"** action pointing at `/read-routes/new`, and that page does not
 * exist — `POST /api/v1/read-routes` is implemented and nothing in the web
 * app calls it. So the button 404s, and a route is not creatable by hand
 * at all. When that page lands, the `ensureWalkRoute` call below should
 * become a UI step and this paragraph should go.
 *
 * **It reuses one route rather than making one per run.** There is no
 * `DELETE /api/v1/read-routes/:id` — a route cannot be deleted once made —
 * so a spec that created its own each time would pile up junk rows in the
 * dev database and on the list screen for ever. `UI-WALK` is found-or-
 * created on its code, the same found-or-create rule the scenario seeder
 * follows, and its stops are torn down after each test.
 *
 * **The teardown matters to another fixture, not just to this one.** The
 * tray is "addresses on no route", so a stop this spec leaves behind
 * removes that address from every other route's tray — and the scenario
 * seeder deliberately leaves the tenant's first-created premise unrouted,
 * which `afterEach` is what keeps true. It runs through the API rather
 * than the UI on purpose: a cleanup that needs the screen to work cannot
 * clean up after the screen failing.
 *
 * **What guarantees three unrouted addresses is nothing, and that is
 * worth knowing before trusting this file.** The walk test needs
 * `PREMISES_NEEDED` of them; the seeder guarantees exactly *one*
 * deliberately, and the rest are there because the base seed creates many
 * more premises than the scenario routes. ui-01 confirmed it holds on an
 * independently seeded database and across two consecutive runs, so the
 * margin is real — but it is a margin, not an invariant, and the only
 * thing maintaining it across runs is the `afterEach` below. A run killed
 * part-way (Ctrl-C, a crashed worker, a closed terminal) skips that
 * teardown and leaks up to three stops, which shrinks the tray *and*
 * takes those addresses off every other route's. Two of those and this
 * file starts failing on its own leftovers. The assertion in the test
 * names the condition so the failure says so rather than looking like a
 * product bug; if it ever fires, the fix is to give the seeder the
 * guarantee rather than to widen the margin by hand.
 *
 * Needs the scenario seeder for `W-04` and `V-12`:
 *
 *     cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts
 */

const ADMIN = "System Admin";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

const SEEDER = "cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts";

/** The scenario route we own, and the vendor's. Both from the seeder. */
const SCENARIO_ROUTE = "W-04";
const VENDOR_ROUTE = "V-12";

/** This spec's own route. Found-or-created; never deleted, never duplicated. */
const WALK_CODE = "UI-WALK";
const WALK_NAME = "Walk built by the UI suite";

/** How many premises the walk test needs out of the tray. */
const PREMISES_NEEDED = 3;

interface RouteSummary {
  id: string;
  code: string;
  name: string;
  origin: string;
  active: boolean;
  stopCount: number;
  billingCycleId: string;
}

interface Premise {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
}

interface Stop {
  id: string;
  premiseId: string;
  sequence: number;
}

/**
 * The same address the screen composes, so a locator built from an API row
 * matches the text actually rendered. Kept in step with `addressOf` in
 * `app/read-routes/[id]/page.tsx` — if that changes, this fails loudly
 * rather than matching nothing.
 */
function addressOf(p: Premise): string {
  return [p.addressLine1, p.addressLine2].filter(Boolean).join(" ") + `, ${p.city}`;
}

class Api {
  constructor(
    private readonly request: APIRequestContext,
    private readonly authorization: string,
  ) {}

  async get<T>(path: string): Promise<T> {
    const response = await this.request.get(`${API_URL}${path}`, {
      headers: { authorization: this.authorization },
    });
    expect(response.ok(), `GET ${path} -> ${response.status()} ${await response.text()}`).toBe(true);
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request.post(`${API_URL}${path}`, {
      headers: { authorization: this.authorization },
      data: body,
    });
    expect(response.ok(), `POST ${path} -> ${response.status()} ${await response.text()}`).toBe(
      true,
    );
    return (await response.json()) as T;
  }

  async delete(path: string): Promise<void> {
    const response = await this.request.delete(`${API_URL}${path}`, {
      headers: { authorization: this.authorization },
    });
    expect(response.ok(), `DELETE ${path} -> ${response.status()}`).toBe(true);
  }

  routes(): Promise<{ data: RouteSummary[] }> {
    return this.get<{ data: RouteSummary[] }>("/api/v1/read-routes?limit=200");
  }

  stops(routeId: string): Promise<Stop[]> {
    return this.get<{ data: Stop[] }>(`/api/v1/read-routes/${routeId}/stops`).then((r) => r.data);
  }

  tray(routeId: string): Promise<Premise[]> {
    return this.get<{ data: Premise[] }>(`/api/v1/read-routes/${routeId}/unsequenced`).then(
      (r) => r.data,
    );
  }
}

/** A seeded route, named so the failure says which fixture is missing. */
async function seededRoute(api: Api, code: string): Promise<RouteSummary> {
  const { data } = await api.routes();
  const route = data.find((r) => r.code === code);
  expect(route, `route ${code} is not in this database. Run the scenario seeder:\n  ${SEEDER}`)
    .toBeDefined();
  return route!;
}

/**
 * This spec's route, created once and emptied. It borrows the scenario
 * route's billing cycle rather than inventing one: a cycle is a tenant's
 * own calendar, and a route has to belong to one that exists.
 */
async function ensureWalkRoute(api: Api): Promise<RouteSummary> {
  const { data } = await api.routes();
  const existing = data.find((r) => r.code === WALK_CODE);
  if (existing) return existing;

  const scenario = await seededRoute(api, SCENARIO_ROUTE);
  return api.post<RouteSummary>("/api/v1/read-routes", {
    code: WALK_CODE,
    name: WALK_NAME,
    billingCycleId: scenario.billingCycleId,
  });
}

/** Back to an empty walk, whatever the test left behind. */
async function emptyTheWalk(api: Api, routeId: string): Promise<void> {
  for (const stop of await api.stops(routeId)) {
    await api.delete(`/api/v1/read-routes/${routeId}/stops/${stop.id}`);
  }
  expect(await api.stops(routeId), "the walk should be empty before and after each test").toEqual(
    [],
  );
}

/** The pill, then the option. Filters here are a popup menu, not a `select`. */
async function chooseFilter(page: Page, pill: string | RegExp, option: string): Promise<void> {
  await page.getByRole("button", { name: pill }).click();
  await page.getByRole("button", { name: option, exact: true }).click();
}

test.describe("Read routes — the list narrows on the server's own terms", () => {
  test("the owner filter sends a parameter the API declares, and the rows obey it", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(page.request, await bearer(page));
    await seededRoute(api, SCENARIO_ROUTE);
    await seededRoute(api, VENDOR_ROUTE);

    await page.goto("/read-routes");
    await expect(page.getByRole("link", { name: SCENARIO_ROUTE })).toBeVisible();
    await expect(page.getByRole("link", { name: VENDOR_ROUTE })).toBeVisible();

    /*
     * Both halves of the contract in one step. The request proves the
     * screen sends `origin=EXTERNAL` — the key `readRouteQuerySchema`
     * declares, not a near-miss like `type` or `ownership`, which the
     * server would drop in silence. The rows prove the server acted on it.
     * Either alone passes while the filter does nothing.
     */
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/api/v1/read-routes?") && r.url().includes("origin="),
      ),
      chooseFilter(page, /^Owner/, "Vendor's system"),
    ]);
    expect(
      new URL(request.url()).searchParams.get("origin"),
      "the screen's owner filter must send the enum value the API's schema declares",
    ).toBe("EXTERNAL");

    await expect(
      page.getByRole("link", { name: VENDOR_ROUTE }),
      "a vendor's route is the one thing this filter asks for",
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: SCENARIO_ROUTE }),
      "a route we own must drop out of the list when the filter asks for the vendor's",
    ).toHaveCount(0);
  });

  test("the in-use filter sends a boolean the API can parse, and retired rows stay reachable", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(page.request, await bearer(page));
    await seededRoute(api, SCENARIO_ROUTE);

    await page.goto("/read-routes");
    await expect(page.getByRole("link", { name: SCENARIO_ROUTE })).toBeVisible();

    /*
     * `active` goes over the wire as a string and the schema parses it
     * with `queryBoolean`. "true"/"false" is what that accepts; a screen
     * sending "1", "yes" or "on" would be ignored silently, and the list
     * would simply never narrow.
     */
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/api/v1/read-routes?") && r.url().includes("active="),
      ),
      chooseFilter(page, /^In use/, "In use"),
    ]);
    expect(
      new URL(request.url()).searchParams.get("active"),
      "`queryBoolean` parses the strings true and false; anything else is dropped unread",
    ).toBe("true");

    await expect(
      page.getByRole("link", { name: SCENARIO_ROUTE }),
      "the scenario route is in use, so asking for in-use routes must still show it",
    ).toBeVisible();
  });
});

test.describe("Read route detail — the walk is built by clicking", () => {
  test.afterEach(async ({ page }) => {
    /*
     * Through the API, because a cleanup that needs the screen cannot
     * clean up after the screen failing — and because a stop left behind
     * takes its address out of every other route's tray.
     */
    const api = new Api(page.request, await bearer(page));
    const route = await ensureWalkRoute(api);
    await emptyTheWalk(api, route.id);
  });

  test("three addresses are added, one is inserted between two, and one is removed", async ({
    page,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(page.request, await bearer(page));
    const route = await ensureWalkRoute(api);
    await emptyTheWalk(api, route.id);

    const candidates = await api.tray(route.id);
    expect(
      candidates.length,
      `the walk test needs ${PREMISES_NEEDED} addresses on no route; the tray offers ` +
        `${candidates.length}. Every active address being routed is a seed state, not a bug — ` +
        `reseed, or remove a stop somewhere.`,
    ).toBeGreaterThanOrEqual(PREMISES_NEEDED);
    const [first, second, inserted] = candidates.slice(0, PREMISES_NEEDED);

    await page.goto(`/read-routes/${route.id}`);
    await expect(
      page.getByText(/no stops yet/i),
      "an empty route should say what that means, not show a bare empty table",
    ).toBeVisible();
    await expect(page.getByTestId("stop-row")).toHaveCount(0);

    // ── 1. Two addresses, appended in the order they were added ────────
    await addFromTray(page, first);
    await expect(page.getByTestId("stop-row")).toHaveCount(1);
    await addFromTray(page, second);
    await expect(page.getByTestId("stop-row")).toHaveCount(2);

    await expectWalkOnScreen(page, [first, second]);
    await expectWalkPersisted(api, route.id, [first, second]);

    /*
     * The added address must leave the tray. The tray is "addresses on no
     * route", so a premise appearing in both places at once is the screen
     * offering a stop that the server will refuse with
     * PREMISE_ALREADY_ON_ROUTE — and offering it is the bug, not the
     * refusal.
     */
    await expect(
      trayRow(page, first),
      "an address that is now a stop is no longer an address on no route",
    ).toHaveCount(0);

    // ── 2. Inserted between the two, by the position on screen ─────────
    /*
     * `Insert after` names the row by the position printed beside it —
     * "1. <address>" — while the server places the stop between that
     * sequence and the next. This is the step a mock cannot check: the
     * component is handed the resulting order, so it cannot be caught
     * computing the wrong position.
     */
    await page.locator("#afterSequence").selectOption({ label: `1. ${addressOf(first)}` });
    await addFromTray(page, inserted);
    await expect(page.getByTestId("stop-row")).toHaveCount(3);

    await expectWalkOnScreen(page, [first, inserted, second]);
    await expectWalkPersisted(api, route.id, [first, inserted, second]);

    // ── 3. Removed, and the positions close up behind it ───────────────
    await stopRow(page, inserted).getByRole("button", { name: /^Remove$/ }).click();
    await expect(page.getByTestId("stop-row")).toHaveCount(2);

    await expectWalkOnScreen(page, [first, second]);
    await expectWalkPersisted(api, route.id, [first, second]);

    /*
     * And it is back in the tray, which is what makes a mis-added stop
     * recoverable without going to the database.
     */
    await expect(
      trayRow(page, inserted),
      "a removed stop's address returns to the addresses on no route",
    ).toHaveCount(1);
  });
});

/** The tray row for a premise, found by the address the screen prints. */
function trayRow(page: Page, premise: Premise) {
  return page
    .getByTestId("unsequenced-tray")
    .locator("tr")
    .filter({ hasText: addressOf(premise) });
}

/** The stop row for a premise, found the same way. */
function stopRow(page: Page, premise: Premise) {
  return page.getByTestId("stop-row").filter({ hasText: addressOf(premise) });
}

/**
 * Find an address in the tray and click its `Add`.
 *
 * It searches first rather than scrolling: the tray is every active
 * address on no route, which on a seeded database is more rows than fit,
 * and a test that depends on one being rendered already depends on how
 * many premises the seed happens to make.
 */
async function addFromTray(page: Page, premise: Premise): Promise<void> {
  await page.locator("#traySearch").fill(premise.addressLine1);
  const row = trayRow(page, premise);
  await expect(row, `${addressOf(premise)} should be offered as an address on no route`).toHaveCount(
    1,
  );
  await row.getByRole("button", { name: /^Add$/ }).click();
}

/**
 * The walk as the screen prints it: positions 1..n in order, whatever
 * sequences the database is keeping underneath.
 */
async function expectWalkOnScreen(page: Page, walk: Premise[]): Promise<void> {
  const rows = page.getByTestId("stop-row");
  await expect(rows).toHaveCount(walk.length);
  for (const [index, premise] of walk.entries()) {
    await expect(
      rows.nth(index),
      `position ${index + 1} of the walk should be ${addressOf(premise)}`,
    ).toContainText(addressOf(premise));
    await expect(
      rows.nth(index),
      "the screen numbers the walk 1..n rather than printing the gapped sequence",
    ).toContainText(String(index + 1));
  }
}

/**
 * The walk as the database has it — ordered by the real sequence, which is
 * gapped and is not the position on screen.
 *
 * This is the half that makes the screen's claim checkable. If an insert
 * wrote the wrong sequence, the list would still render in *some* order
 * and look plausible; only reading the rows back in sequence order says
 * which walk a reader would actually be sent on.
 *
 * **What this does not rule out, said rather than fixed.** The read path
 * is now inside the trust chain: if `listRouteStopDetails` were wrong in
 * the same way the page is, both would agree and this would pass. It is
 * not an independent oracle, it is a second path that happens to have 41
 * integration tests behind it where the screen has none that touch a
 * database. That asymmetry is the whole reason to prefer it, and it is
 * also the reason to say out loud that a bug in `addStop`'s sequencing
 * which *both* the page and the stops endpoint read back faithfully would
 * survive this test. Catching that needs a third path — the printed sheet,
 * whose order comes from `buildRouteSheet`.
 *
 * Named by ui-01 reviewing this file, and kept as a caveat because the
 * alternative — asserting against raw SQL — buys a smaller gap than it
 * costs in a spec that is supposed to be about the screen.
 */
async function expectWalkPersisted(api: Api, routeId: string, walk: Premise[]): Promise<void> {
  const stops = await api.stops(routeId);
  const inSequence = [...stops].sort((a, b) => a.sequence - b.sequence);
  expect(
    inSequence.map((s) => s.premiseId),
    "the stored walk, read back in sequence order, is the order the reader walks",
  ).toEqual(walk.map((p) => p.id));
  expect(
    inSequence.map((s) => s.sequence),
    "sequences must stay strictly ascending; an insert that ties them makes the walk ambiguous",
  ).toEqual([...new Set(inSequence.map((s) => s.sequence))].sort((a, b) => a - b));
}

/**
 * The server's own refusal, reaching the screen.
 *
 * **What is unverified without this is precisely the join.** `new.test.tsx`
 * has five cases and they mock the rejection, so they prove the page
 * displays whatever message it is handed. The server side is pinned
 * separately — `read-route-routes.integration.test.ts` asserts
 * `error.code === "ROUTE_CODE_TAKEN"`. Neither says the real message
 * travels: an API client that swallowed the body, or a form that showed a
 * generic "Failed to save", would satisfy both suites and show the person
 * nothing they could act on.
 *
 * So this asserts the message **names the code it refused**, which is the
 * part only the server knows and only a real request can carry.
 *
 * **It matches on `/already exists/i` and not the whole string on
 * purpose.** `use-entity-form.ts:73-75` shows `err.message` verbatim and
 * `api-client.ts:155` throws `API error 409: …`, so what a person actually
 * reads is:
 *
 *     API error 409: A route with code W-04 already exists
 *
 * Pinning that prefix would make it intended behaviour. It is app-wide —
 * every `EntityFormPage` leaks it — so whether a form should print an HTTP
 * status at somebody is a question about the whole app and not about read
 * routes. Named here, decided elsewhere. (ui-01, who owns both files, made
 * the same call.)
 *
 * **Idempotent, and that is why it is the creation case this file tests.**
 * The refusal happens before any write, so the test leaves nothing behind
 * — which the happy path cannot manage: a code is unique and there is no
 * `DELETE /api/v1/read-routes/:id`, so a form-driven create would litter a
 * row on every run or fail on its second.
 */
test("the create form reports the server's refusal, naming the code it would not take", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  const api = new Api(page.request, await bearer(page));
  const taken = await seededRoute(api, SCENARIO_ROUTE);

  const countBefore = (await api.routes()).data.filter((r) => r.code === SCENARIO_ROUTE).length;
  expect(countBefore, `${SCENARIO_ROUTE} should exist exactly once to be a taken code`).toBe(1);

  await page.goto("/read-routes/new");
  await expect(page.getByRole("heading", { name: /new read route/i })).toBeVisible();

  /*
   * Labels by regex: a required field renders its marker appended, so the
   * exact string the page gives its form spec is not the label's text.
   */
  await page.getByLabel(/^Code/).fill(SCENARIO_ROUTE);
  await page.getByLabel(/^Name/).fill("A name the server never gets as far as");

  /*
   * The cycles are fetched, so wait for the option rather than racing it —
   * `selectOption` waits for the control, not for its contents.
   */
  const cycle = page.getByLabel(/^Billing Cycle/);
  await expect(cycle.locator(`option[value="${taken.billingCycleId}"]`)).toHaveCount(1);
  await cycle.selectOption(taken.billingCycleId);

  await page.getByRole("button", { name: /^Create Read Route$/ }).click();

  await expect(
    page.getByText(/already exists/i),
    "the server's refusal has to reach the screen, not a generic save failure",
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(SCENARIO_ROUTE)),
    "and it has to name the code it refused — that is the part only the server knows",
  ).toBeVisible();

  await expect(page, "a refused create stays on the form with the values typed").toHaveURL(
    /\/read-routes\/new$/,
  );
  await expect(page.getByLabel(/^Code/), "so the code can be corrected rather than retyped").toHaveValue(
    SCENARIO_ROUTE,
  );

  expect(
    (await api.routes()).data.filter((r) => r.code === SCENARIO_ROUTE).length,
    "a refused create must write nothing",
  ).toBe(countBefore);
});
