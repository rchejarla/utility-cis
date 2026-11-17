import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/**
 * A reading week, end to end: print the sheet, type the day in, code two
 * stops, post the route, correct the stop it refused, post again.
 *
 * **What this covers that nothing else can.** The api suites call
 * `openEntry`, `saveEntryRow` and `submitEntry` directly and the web
 * suites mock `apiClient`, so the two halves have never met — and the
 * thing most likely to be wrong is between them: whether `Enter` on a row
 * really reaches the server, whether a row the server refused is visible
 * as refused to the person holding the paper, and whether the correction
 * path posts the one row without re-posting the five that already landed.
 * Those are three places where both halves can be right on their own and
 * wrong together.
 *
 * It also exercises the one thing the design insists on and no unit test
 * can show: **the route posts as a whole.** Nine rows are typed and coded
 * across a dozen interactions and nothing reaches `meter_read` until
 * Submit.
 *
 * ## What it needs on the stack
 *
 * The scenario seeder, run once against the database the dev stack is
 * pointed at:
 *
 *     cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts
 *
 * It is additive and idempotent, so running it again costs nothing. Every
 * assertion below names a row from it, and the failures say so rather than
 * reporting a missing element.
 *
 * No worker process is needed: `submitEntry` runs `processBatch` inline,
 * which is the point of the route posting as a whole.
 *
 * ## Why it can be run more than once
 *
 * A sheet is one batch per `(route, day)` and nothing posts twice, so the
 * journey cannot repeat on a day it has already posted — `openEntry` hands
 * back the posted batch, `saveEntryRow` answers 409 `ENTRY_CLOSED` and
 * `reopen` answers 409 `ENTRY_NOTHING_TO_CORRECT`. That is the behaviour
 * under test, not a defect, so instead of resetting anything this picks
 * **the first day in the route's current window that has no posted sheet**
 * and reads for that day.
 *
 * Every fact the scenario rests on is window-scoped rather than day-scoped
 * — the billed read, the read that came in off-route — so they hold on
 * whichever day is picked. A run also leaves the next day's run working: it
 * posts a reading for the off-route meter, which keeps that stop's skip
 * refused; it codes two meters that are never read, which keeps them
 * codeable; and the billed read stays billed. Which gives one run per
 * unused day of the window, and a failure that says what to do when they
 * are gone.
 *
 * ## The page contract this assumes
 *
 * Written before the screens existed, against the paths the coordinator
 * settled. Everything the spec reaches for is listed here, so a mismatch
 * is a short conversation rather than a hunt:
 *
 *  1. `/read-routes` lists routes; each row links to the route by its
 *     **code** as the link text (`W-04`).
 *  2. `/read-routes/:id` shows the stops and offers the sheet as a control
 *     named **"Print sheet"**, which fetches
 *     `GET /api/v1/read-routes/:id/sheet` through `apiClient` — it has to
 *     go through the client rather than a bare `window.open`, because the
 *     endpoint wants the bearer token the browser would not send. For an
 *     `EXTERNAL` route the same page renders **no** such control and says
 *     somewhere that the route is the vendor's.
 *  3. `/read-routes/:id/entry?date=YYYY-MM-DD` is the entry screen for one
 *     day, defaulting to today when the parameter is absent. The spec's
 *     own calls assume `?date=` on the sheet endpoint and `{ readDate }`
 *     in the entry and reopen bodies — the two parameter names appear once
 *     each, in `Api.sheet` and `entryFor`, so a different spelling is a
 *     one-line correction.
 *  4. Each entry row carries `data-testid="entry-row-<rowIndex>"`, where
 *     `rowIndex` is the 1-based index `openEntry` returns — the route's
 *     walking order. The spec learns which meter is on which row from the
 *     API rather than assuming, so only the attribute is contractual.
 *  5. Within a row: the reading field is the only `spinbutton`/`textbox`,
 *     and the skip reason the only `combobox`, whose option values are the
 *     `SKIP_REASONS` strings (`LOCKED_GATE`, `DOG`, …).
 *  6. `Enter` in the reading field saves that row.
 *  7. A row the server refused shows the refusal as text in the row.
 *  8. A control named **"Submit"** posts the sheet, and one named
 *     **"Correct"** reopens it for the rows that were refused.
 *
 * Row addressing is by `data-testid` rather than by reading the table,
 * because a reading sheet is a grid of numbers: nothing in a row is unique
 * text, two rows carry the same meter number when it has two registers,
 * and `nth()` over `getByRole("row")` breaks the first time a header or a
 * group row is added.
 */

const ADMIN = "System Admin";

/** The dev API. `baseURL` in the config is the web app; this is the other half. */
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

const ROUTE_CODE = "W-04";
const VENDOR_ROUTE_CODE = "V-12";
const SEEDER = "cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts";

/**
 * The scenario's rows, by meter number. Each is one fact the seeder
 * arranged; the comments are why the journey touches it.
 */
/** One active register, three months of history: an ordinary row to type. */
const ONE_REGISTER = "WM-101";
/** Read off-route earlier in this window, so a code here is refused and has to be corrected. */
const READ_OFF_ROUTE = "WM-102";
/** Its read in this window is billed, so a number typed here is refused at the keyboard. */
const BILLED = "WM-103";
/** Two meters at one address: one locked gate, two skip rows. */
const BEHIND_THE_GATE = ["WM-105", "WM-106"];
/** Two active registers, so this address is two rows and not one. */
const TWO_REGISTER = "EM-003";
/** Ordinary rows at the reused premises, which the sheet must also carry. */
const PLAIN_ROWS = ["WM-005", "WM-004"];

/** Every row the sheet should have for the scenario route. */
const EXPECTED_ROWS = 9;
/** Stops, one of which produces no row at all — the service that ended mid-window. */
const EXPECTED_STOPS = 8;

interface EntryRow {
  rowId: string;
  rowIndex: number;
  sequence: number;
  meterId: string;
  meterNumber: string;
  registerNumber: string | null;
  reading: string | null;
  skipReason: string | null;
  status: "PENDING" | "IMPORTED" | "ERROR" | "SKIPPED";
  errorCode: string | null;
}

async function signIn(page: Page, who: string): Promise<void> {
  await page.goto("/login");
  await page.getByRole("button", { name: who, exact: true }).click();
  // A full navigation rather than a router push, so the permission
  // provider remounts with the new token.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/**
 * The page's own token, for the spec's own calls.
 *
 * The journey is in the browser; these calls are setup and verification —
 * which day is free, and what actually landed in the database. Reading the
 * result off the screen that just wrote it would let a page that renders
 * its own optimistic guess pass a test about what posted.
 */
async function bearer(page: Page): Promise<string> {
  const token = await page.evaluate(() => window.localStorage.getItem("cis_token"));
  expect(token, "signing in should leave a token in localStorage").toBeTruthy();
  return `Bearer ${token}`;
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

  async post<T>(path: string, data: unknown): Promise<T> {
    const response = await this.request.post(`${API_URL}${path}`, {
      headers: { authorization: this.authorization },
      data: data as Record<string, unknown>,
    });
    expect(response.ok(), `POST ${path} -> ${response.status()} ${await response.text()}`).toBe(
      true,
    );
    return (await response.json()) as T;
  }

  /** The sheet's bytes, so "it rendered a PDF" is checked against the file and not the page. */
  async sheet(routeId: string, date: string): Promise<Buffer> {
    const response = await this.request.get(
      `${API_URL}/api/v1/read-routes/${routeId}/sheet?date=${date}`,
      { headers: { authorization: this.authorization } },
    );
    expect(response.ok(), `sheet -> ${response.status()}`).toBe(true);
    expect(response.headers()["content-type"]).toContain("application/pdf");
    return Buffer.from(await response.body());
  }
}

interface RouteSummary {
  id: string;
  code: string;
  name: string;
  origin: string;
  stopCount: number;
}

async function routes(api: Api): Promise<RouteSummary[]> {
  const list = await api.get<{ data: RouteSummary[] }>("/api/v1/read-routes?limit=100");
  return list.data;
}

/** The scenario route, named by its code so the failure says what is missing. */
async function scenarioRoute(api: Api): Promise<RouteSummary> {
  const route = (await routes(api)).find((r) => r.code === ROUTE_CODE);
  expect(route, `route ${ROUTE_CODE} is not in this database. Run the scenario seeder:\n  ${SEEDER}`)
    .toBeTruthy();
  expect(route!.stopCount, `route ${ROUTE_CODE} should have ${EXPECTED_STOPS} stops`).toBe(
    EXPECTED_STOPS,
  );
  return route!;
}

/** The vendor's route, which exists so reads can point at it and for no other reason. */
async function vendorRoute(api: Api): Promise<RouteSummary> {
  const route = (await routes(api)).find((r) => r.code === VENDOR_ROUTE_CODE);
  expect(
    route,
    `route ${VENDOR_ROUTE_CODE} is not in this database. Run the scenario seeder:\n  ${SEEDER}`,
  ).toBeTruthy();
  expect(route!.origin, `${VENDOR_ROUTE_CODE} is the EXTERNAL half of this fixture`).toBe(
    "EXTERNAL",
  );
  return route!;
}

/**
 * Open (or re-open) the entry for a day and return its rows. Idempotent on
 * the server, so asking is free and tells us the day's state.
 */
async function entryFor(api: Api, routeId: string, readDate: string): Promise<EntryRow[]> {
  const opened = await api.post<{ batchId: string; rows: EntryRow[] }>(
    `/api/v1/read-routes/${routeId}/entry`,
    { readDate },
  );
  return opened.rows;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The first day of the route's current window with no posted sheet.
 *
 * Days already posted are left exactly as they are. The probe creates a
 * batch only for the day it settles on, because `openEntry` returns an
 * existing batch for every day it has to pass over.
 */
async function firstUnpostedDay(api: Api, routeId: string): Promise<string> {
  const progress = await api.get<{ windowStart: string; windowEnd: string }>(
    `/api/v1/read-routes/${routeId}/progress`,
  );
  const start = new Date(progress.windowStart);
  const today = new Date();
  // Never past today: a reading is something somebody took, and a read
  // dated in the future is not a thing this journey should invent.
  const last = new Date(Math.min(new Date(progress.windowEnd).getTime(), Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  )));

  const tried: string[] = [];
  for (let day = new Date(start); day <= last; day = new Date(day.getTime() + 86_400_000)) {
    const date = isoDay(day);
    const rows = await entryFor(api, routeId, date);
    if (rows.length > 0 && rows.every((r) => r.status === "PENDING")) return date;
    tried.push(date);
  }
  throw new Error(
    `Every day from ${isoDay(start)} to ${isoDay(last)} already has a posted sheet for route ` +
      `${ROUTE_CODE} (${tried.join(", ")}). Nothing posts twice, so this journey needs a day of ` +
      `its own. Either wait for the next window, or clear the typed sheets on the dev database:\n` +
      `  delete from import_row where import_batch_id in (select id from import_batch where ` +
      `mapping->>'kind' = 'read-route-entry');\n` +
      `  delete from import_batch where mapping->>'kind' = 'read-route-entry';`,
  );
}

/** A row on the entry screen, addressed by the walking order the API reported. */
function rowFor(page: Page, rows: EntryRow[], meterNumber: string, registerNumber?: string): Locator {
  const row = rows.find(
    (r) => r.meterNumber === meterNumber && (registerNumber ?? null) === r.registerNumber,
  );
  expect(
    row,
    `${meterNumber}${registerNumber ? `/r${registerNumber}` : ""} is not a row of this sheet. ` +
      `Run the scenario seeder:\n  ${SEEDER}`,
  ).toBeTruthy();
  return page.getByTestId(`entry-row-${row!.rowIndex}`);
}

/** The reading field, whether the page made it a number input or a text one. */
function readingField(row: Locator): Locator {
  return row.getByRole("spinbutton").or(row.getByRole("textbox"));
}

/** Type a reading and commit it with the key a clerk would use. */
async function typeReading(row: Locator, reading: number): Promise<void> {
  const field = readingField(row);
  await field.click();
  await field.fill(String(reading));
  await field.press("Enter");
}

async function codeSkip(row: Locator, reason: string): Promise<void> {
  await row.getByRole("combobox").selectOption(reason);
}

function statusOf(rows: EntryRow[], meterNumber: string, registerNumber?: string): EntryRow {
  const row = rows.find(
    (r) => r.meterNumber === meterNumber && (registerNumber ?? null) === r.registerNumber,
  );
  expect(row, `${meterNumber} should be a row of this sheet`).toBeTruthy();
  return row!;
}

test("the route list offers a sheet for the route we own and none for the vendor's", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  const api = new Api(page.request, await bearer(page));
  const route = await scenarioRoute(api);

  const vendor = await vendorRoute(api);

  await page.goto("/read-routes");
  await expect(page.getByRole("link", { name: ROUTE_CODE })).toBeVisible();
  await expect(page.getByRole("link", { name: VENDOR_ROUTE_CODE })).toBeVisible();

  await page.getByRole("link", { name: ROUTE_CODE }).click();
  await expect(page.getByRole("heading", { name: new RegExp(route.name, "i") })).toBeVisible();

  /*
   * The sheet comes back through `apiClient`, so the click is a fetch on
   * this page and not a navigation. Waiting on the response rather than on
   * a download event leaves the page free to hand the blob to the browser
   * however it likes.
   */
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/read-routes/${route.id}/sheet`)),
    page.getByRole("button", { name: /print sheet/i }).click(),
  ]);
  expect(response.status(), "the sheet should render for a LOCAL route").toBe(200);

  // And it is really a PDF, checked against the bytes rather than the page.
  const pdf = await api.sheet(route.id, isoDay(new Date()));
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  expect(pdf.length, "a nine-row sheet should not be an empty document").toBeGreaterThan(1_000);

  /*
   * The vendor's route must offer no sheet at all. Its itinerary belongs
   * to somebody else, so a sheet for it would print an empty page and
   * imply we knew the stops. `origin` is the only thing keeping the two
   * modes from contaminating each other, and this screen is the first
   * place it would stop being visible.
   */
  await page.goto(`/read-routes/${vendor.id}`);
  await expect(
    page.getByText(/external|vendor/i).first(),
    "a vendor's route should say so on its own page",
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /print sheet/i }),
    "there is no sheet to print for a route whose stops a vendor decides",
  ).toHaveCount(0);
});

test("a day's sheet is typed in, two stops are coded, and the one refused stop is corrected", async ({
  page,
}) => {
  await signIn(page, ADMIN);
  const api = new Api(page.request, await bearer(page));
  const route = await scenarioRoute(api);
  const readDate = await firstUnpostedDay(api, route.id);

  const rows = await entryFor(api, route.id, readDate);
  expect(
    rows.length,
    `the scenario route should produce ${EXPECTED_ROWS} rows; got ${rows.length}. Run:\n  ${SEEDER}`,
  ).toBe(EXPECTED_ROWS);
  // The walking order is the route's, not the premises' or the meters'.
  expect([...rows].sort((a, b) => a.rowIndex - b.rowIndex).map((r) => r.sequence)).toEqual(
    [...rows].map((r) => r.sequence).sort((a, b) => a - b),
  );

  await page.goto(`/read-routes/${route.id}/entry?date=${readDate}`);
  await expect(
    page.getByTestId(`entry-row-${rows.length}`),
    "every row of the sheet should be on the screen",
  ).toBeVisible();

  // ── 1. The frozen period refuses a number at the keyboard ──────────
  /*
   * Design §5.3 and the entry service's `READ_BILLED`: typing a reading
   * behind a posted bill is a mistake to catch at the row, not at submit.
   * The person must see it on the row they typed.
   */
  const billedRow = rowFor(page, rows, BILLED);
  await typeReading(billedRow, 101_500);
  await expect(billedRow, "the billed row should say why it will not take a number").toContainText(
    /billed/i,
  );

  // ── 2. The readings ────────────────────────────────────────────────
  await typeReading(rowFor(page, rows, ONE_REGISTER), 133_000);
  // Two registers, two rows, two numbers — one address, not one line.
  await typeReading(rowFor(page, rows, TWO_REGISTER, "1"), 52_400);
  await typeReading(rowFor(page, rows, TWO_REGISTER, "2"), 310);
  await typeReading(rowFor(page, rows, PLAIN_ROWS[0]!), 41_250);
  await typeReading(rowFor(page, rows, PLAIN_ROWS[1]!), 88_900);

  // ── 3. Two stops coded, for one locked gate and one dog ────────────
  /*
   * The gate is in front of two meters, so one physical fact becomes two
   * rows here and two `read_skip` rows at submit (§5.3). The dog is at the
   * stop somebody already read off-route, and that code cannot stand: a
   * skip says no number exists, and one does.
   */
  for (const meterNumber of BEHIND_THE_GATE) {
    await codeSkip(rowFor(page, rows, meterNumber), "LOCKED_GATE");
  }
  await codeSkip(rowFor(page, rows, READ_OFF_ROUTE), "DOG");

  // Nothing has posted yet: the route posts as a whole.
  const beforeSubmit = await entryFor(api, route.id, readDate);
  expect(
    beforeSubmit.every((r) => r.status === "PENDING"),
    "a half-typed sheet is not a reading event — nothing may post before Submit",
  ).toBe(true);
  expect(statusOf(beforeSubmit, ONE_REGISTER).reading, "the typed row should be staged").toBe(
    "133000",
  );
  expect(statusOf(beforeSubmit, BILLED).reading, "the refused row should have staged nothing").toBe(
    null,
  );

  // ── 4. Submit ──────────────────────────────────────────────────────
  await page.getByRole("button", { name: /^Submit/i }).click();

  const refusedRow = rowFor(page, rows, READ_OFF_ROUTE);
  await expect(
    refusedRow,
    "the stop whose meter was already read should show its refusal on the row",
  ).toContainText(/already has a read|METER_ALREADY_READ/i, { timeout: 60_000 });

  const posted = await entryFor(api, route.id, readDate);
  expect(statusOf(posted, ONE_REGISTER).status).toBe("IMPORTED");
  expect(statusOf(posted, TWO_REGISTER, "1").status).toBe("IMPORTED");
  expect(statusOf(posted, TWO_REGISTER, "2").status).toBe("IMPORTED");
  expect(statusOf(posted, PLAIN_ROWS[0]!).status).toBe("IMPORTED");
  expect(statusOf(posted, PLAIN_ROWS[1]!).status).toBe("IMPORTED");
  // Coded and accepted: a skip, not a read of zero.
  for (const meterNumber of BEHIND_THE_GATE) {
    expect(statusOf(posted, meterNumber).status).toBe("SKIPPED");
  }
  // Nothing was typed here, so nothing was posted and nothing was invented.
  expect(statusOf(posted, BILLED).status).toBe("SKIPPED");
  expect(statusOf(posted, BILLED).errorCode).toBe("NOT_ENTERED");
  // And the one the server would not take.
  expect(statusOf(posted, READ_OFF_ROUTE).status).toBe("ERROR");
  expect(statusOf(posted, READ_OFF_ROUTE).errorCode).toBe("METER_ALREADY_READ");

  /*
   * The two skip rows reach the outstanding list with their reason, which
   * is the whole point of recording one: the screen can say *why* instead
   * of just *missing*.
   */
  const afterSubmit = await api.get<{
    expected: number;
    read: number;
    outstanding: number;
    data: { meterNumber: string; skipReason: string | null }[];
  }>(`/api/v1/read-routes/${route.id}/progress`);
  for (const meterNumber of BEHIND_THE_GATE) {
    const row = afterSubmit.data.find((r) => r.meterNumber === meterNumber);
    expect(row, `${meterNumber} should still be outstanding`).toBeTruthy();
    expect(row!.skipReason, `${meterNumber} should say why it was not read`).toBe("LOCKED_GATE");
  }
  /*
   * The denominator is the route's stops, and the sheet and the count have
   * to be the same set (§5.12): nine, counting EM-003's two registers
   * separately, excluding the AMI meter at that same address, and
   * excluding the stop whose service ended — which is on the route and
   * expected of nobody.
   */
  expect(
    afterSubmit.expected,
    "per-route expected is one per readable register across the stops, not one per stop",
  ).toBe(EXPECTED_ROWS);
  expect(
    afterSubmit.outstanding,
    "only the two meters behind the gate are unread: a skip does not make a meter read",
  ).toBe(BEHIND_THE_GATE.length);

  // ── 5. Correct the refused row, and post again ─────────────────────
  /*
   * One rejected row on a 48-stop route must not mean retyping the route,
   * which is the whole reason `reopenEntryForCorrections` exists — and the
   * five rows that already posted must not post a second time.
   */
  await page.getByRole("button", { name: /^Correct/i }).click();
  await typeReading(rowFor(page, rows, READ_OFF_ROUTE), 188_400);
  await page.getByRole("button", { name: /^Submit/i }).click();

  await expect(
    refusedRow,
    "the corrected row should post, and say so",
  ).not.toContainText(/already has a read|METER_ALREADY_READ/i, { timeout: 60_000 });

  const corrected = await entryFor(api, route.id, readDate);
  expect(statusOf(corrected, READ_OFF_ROUTE).status).toBe("IMPORTED");
  expect(
    corrected.filter((r) => r.status === "IMPORTED").length,
    "the correction should add one posted row, not re-post the five that already landed",
  ).toBe(6);
  expect(corrected.filter((r) => r.status === "ERROR").length).toBe(0);
});
