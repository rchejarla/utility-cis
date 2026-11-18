import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { bearer, signIn } from "./support/dev-stack.js";

/**
 * A reading week, end to end: print the sheet, type the day in, code two
 * stops, post the route, correct the stop it refused, post again.
 *
 * **What this covers that nothing else can.** The api suites call
 * `openEntry`, `saveEntryRow` and `submitEntry` directly and the web
 * suites mock `apiClient`, so the two halves have never met — and what is
 * most likely wrong sits between them: whether `Enter` on a row really
 * reaches the server, whether a row the server refused is visible as
 * refused to the person holding the paper, and whether the correction path
 * posts the one row without re-posting the five that already landed. Those
 * are three places where both halves can be right on their own and wrong
 * together.
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
 * **If the stack is not on 4000/4001**, three things have to agree, not
 * two: `E2E_BASE_URL`, `E2E_API_URL`, and the web app's own
 * `NEXT_PUBLIC_API_URL` — which Next inlines at **compile** time and
 * re-reads from `.env.local` on every recompile, so a shell variable does
 * not survive and the browser goes quietly back to calling 4001. The
 * symptom is `ERR_CONNECTION_REFUSED` against a port nobody meant to use.
 *
 * ## Why it can be run more than once
 *
 * A sheet is one batch per `(route, day)` and nothing posts twice, so the
 * journey cannot repeat on a day it has already posted — `openEntry` hands
 * back the posted batch, `saveEntryRow` answers 409 `ENTRY_CLOSED` and
 * `reopen` answers 409 `ENTRY_NOTHING_TO_CORRECT`. That is the behaviour
 * under test, not a defect, so instead of resetting anything this picks
 * **the first day of the route's current reading window that has no posted
 * sheet**.
 *
 * Three things make that safe, and all three were wrong in the first
 * version of this file:
 *
 * - Every fact the scenario rests on is **window-scoped, not day-scoped**:
 *   the billed read and the read that came in off-route are judged against
 *   the window, and the closed assignment is dated the day *before* the
 *   window opens, so the stop with nothing to read has nothing to read on
 *   every day of it. The seeder used to close it mid-window, which made the
 *   row count 10 on some days and 9 on others — removal is inclusive, so a
 *   stop closed on the 16th still prints on the 16th.
 * - A run leaves the next day's run working: it posts a reading for the
 *   off-route meter, which keeps that stop's skip refused; it codes two
 *   meters that are never read, which keeps them codeable; and the billed
 *   read stays billed.
 * - **Each typed reading is derived from the row's own last reading**, not
 *   a constant. A constant means the second run types the same number, for
 *   a consumption of zero — which is outside the meter's own band, so the
 *   entry screen holds the row and `Enter` stages nothing. That is the
 *   screen being right, and it is why the readings move with the fixture.
 *
 * Which gives one run per unused day of the window, and a failure that says
 * what to do when they are gone.
 *
 * **So the suite is self-limiting, and that is intended rather than a
 * bug.** The ui stream ran it eight times and the ninth refused, naming all
 * eight posted days and printing the two deletes that free them. If you
 * meet that, read it as the journey declining to post a sheet twice — clear
 * the typed batches with the SQL it gives you, or come back in the next
 * window.
 *
 * ## Two windows, and a route's progress answers the reading one
 *
 * There are two periods in play on any day. The one a billing run will
 * bill is the last period already **closed** (`computeBillPeriod`), and the
 * one a reader is collecting for is the period **containing** the day
 * (`windowContaining`). For cycle R01 on 2026-11-17 those are
 * 2026-10-11..2026-11-10 and 2026-11-11..2026-12-10 — different months.
 * `recordSkips` and entry judge the second; `/meter-reads/progress` judges
 * the first, deliberately, because that screen exists to predict what a run
 * will do and shares the run's own call (design §5.9's "no second
 * implementation").
 *
 * **`/api/v1/read-routes/:id/progress` answers the reading window**, by
 * defaulting its `window` parameter to `reading` where the cycle-wide
 * screen defaults to `billing` — a route is a walk somebody is doing, so
 * its progress is about the window the reads land in. That is the one place
 * the two endpoints differ.
 *
 * This file used to derive the containing window by arithmetic on the
 * closed one, because the endpoint could not be asked for it. That was its
 * largest bug: the day scan ran over October, where none of the fixture's
 * facts hold, and nothing said so. Now it asks, and **asserts** that the
 * answer contains today — a default that moves should fail by name rather
 * than silently relocate the whole journey.
 *
 * ## The page contract
 *
 * Drafted before the screens existed, against the paths the coordinator
 * settled, then agreed with the UI stream on 2026-11-17 and corrected
 * against its first green run. Everything the spec reaches for is listed
 * here, so a later mismatch is a short conversation rather than a hunt:
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
 *  3. The sheet endpoint takes **`?onDate=YYYY-MM-DD`**, with
 *     `&format=json` for the data instead of the PDF. `onDate` is the
 *     parameter's name all the way through `buildRouteSheet` and
 *     `readableRowsForPremises`, and `date` would be a third word for one
 *     thing. The entry *page* URL is
 *     `/read-routes/:id/entry?date=YYYY-MM-DD`, defaulting to today when
 *     absent — that one is human-facing, so it stays short. The entry and
 *     reopen bodies take `{ readDate }`. The progress endpoint takes
 *     `?asOf=YYYY-MM-DD`, from the shared query schema.
 *  4. Each entry row carries `data-testid="entry-row-<rowIndex>"`, where
 *     `rowIndex` is the 1-based index `openEntry` returns — the route's
 *     walking order. The spec learns which meter is on which row from the
 *     API rather than assuming, so only the attribute is contractual.
 *  5. Within a row the reading field is the only **`spinbutton`** — an
 *     `<input type="number">`. A **notes** textbox appears in a row once a
 *     skip reason is set on it, offered only then because forty
 *     always-visible note fields are forty controls nobody uses. So a row
 *     that has been coded holds a textbox, and the reading field must never
 *     be reached as one.
 *  6. The skip reason is the only `combobox` in a row, and its option
 *     **values** are the `SKIP_REASONS` strings (`LOCKED_GATE`, `DOG`, …)
 *     while its labels are words.
 *  7. `Enter` in the reading field saves that row. There is no
 *     save-on-blur for readings at all, so `Enter` is the only path.
 *  8. A row the server refused shows the refusal as text **in** the row.
 *     Both cases this asserts: `READ_BILLED` the moment a number is typed
 *     into the billed row, and `METER_ALREADY_READ` after Submit, which
 *     the page reads back by re-opening the batch.
 *  9. The buttons are **"Post the route"** and **"Correct the refused
 *     rows"**. Neither is shortened on purpose — "Submit" says nothing
 *     about posting a whole route, and the correction button has to say
 *     what it corrects.
 * 10. A post reports itself as **"N readings posted"**, which is what this
 *     waits for rather than for a refusal to disappear.
 * 11. The entry page names the stops with nothing to read above the grid,
 *     from the sheet's `stopsWithNothingToRead`.
 * 12. An entry row carries `lastReading` — the figure the sheet prints
 *     beside it — so a typed number can be derived from the meter's own
 *     history instead of a constant.
 *
 * Row addressing is by `data-testid` rather than by reading the table,
 * because a reading sheet is a grid of numbers: nothing in a row is unique
 * text, two rows carry the same meter number when it has two registers,
 * and `nth()` over `getByRole("row")` breaks the first time a header or a
 * group row is added. (The fields also carry accessible names — `Reading
 * for <meterNumber>[ register <n>]` and `Why <meterNumber> was not
 * read` — which would address a row too; the index is kept because the
 * row-level assertions need the row itself, and one addressing scheme
 * beats two.)
 */

const ADMIN = "System Admin";

/** The dev API. `baseURL` in the config is the web app; this is the other half. */
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

const ROUTE_CODE = "W-04";
const VENDOR_ROUTE_CODE = "V-12";
const SEEDER = "cd packages/api && npx tsx --env-file=.env scripts/seed-read-route-scenarios.ts";

/**
 * The two buttons, spelled out once.
 *
 * Neither is shortened: "Submit" says nothing about posting a whole route,
 * and the correction button has to say what it corrects. Anchored both
 * ends, so a second button whose name merely contains one of these cannot
 * be clicked by accident.
 */
const POST_THE_ROUTE = /^Post the route$/i;
const CORRECT_REFUSED = /^Correct the refused rows$/i;

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

/**
 * What to type where, as a **month's consumption** rather than a reading.
 *
 * The number is `lastReading + monthly`, so it lands where the meter's own
 * trailing history says the next read should be — inside the band the entry
 * screen computes, on the first run and on every run after it. `opening` is
 * only for a row with no history at all, which is every row here on a
 * freshly seeded database except the two the seeder gave three months to.
 *
 * A constant reading would be typed again on the next run for a consumption
 * of zero, which is *outside* the band, so the screen would hold the row
 * and `Enter` would stage nothing. Confirming the outlier instead would
 * make the band's coverage vacuous, so the readings move and the band stays
 * a real check. The step below that asserts every typed row staged a number
 * is what catches it if this drifts again.
 */
interface Target {
  meter: string;
  register?: string;
  opening: number;
  monthly: number;
}

const READINGS: Target[] = [
  { meter: ONE_REGISTER, register: "1", opening: 133_000, monthly: 3_500 },
  // Energy and demand are different magnitudes; a shared delta would be
  // absurd on one of them.
  { meter: TWO_REGISTER, register: "1", opening: 52_400, monthly: 700 },
  { meter: TWO_REGISTER, register: "2", opening: 310, monthly: 20 },
  { meter: "WM-005", opening: 41_250, monthly: 3_500 },
  { meter: "WM-004", opening: 88_900, monthly: 3_500 },
];

/** The correction: the number the reader actually wrote down at the stop with the dog. */
const CORRECTION: Target = { meter: READ_OFF_ROUTE, opening: 188_400, monthly: 3_500 };

/** Every row the sheet should have for the scenario route. */
const EXPECTED_ROWS = 9;
/** Stops, one of which produces no row at all — the service that ended before the window. */
const EXPECTED_STOPS = 8;

interface EntryRow {
  rowId: string;
  rowIndex: number;
  sequence: number;
  meterId: string;
  meterNumber: string;
  registerNumber: string | null;
  reading: string | null;
  /** What the sheet prints beside the row: the last reading before this date. */
  lastReading: string | null;
  skipReason: string | null;
  status: "PENDING" | "IMPORTED" | "ERROR" | "SKIPPED";
  errorCode: string | null;
}

interface Progress {
  windowStart: string;
  windowEnd: string;
  expected: number;
  read: number;
  outstanding: number;
  data: { meterNumber: string; skipReason: string | null }[];
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

  /**
   * The sheet's bytes, so "it rendered a PDF" is checked against the file
   * and not the page. `onDate`, not `date`: that is the parameter's name
   * all the way through `buildRouteSheet`.
   */
  async sheet(routeId: string, onDate: string): Promise<Buffer> {
    const response = await this.request.get(
      `${API_URL}/api/v1/read-routes/${routeId}/sheet?onDate=${onDate}`,
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

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * DAY_MS);
function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The window a read taken today belongs to.
 *
 * One call, because a **route's** progress answers for `window: "reading"`
 * by default — the period containing the day, which is the week somebody is
 * out walking. (`/meter-reads/progress` still defaults to `billing`, the
 * last period a run closed; that is the one place the two endpoints differ
 * and it is the question, not an oversight.)
 *
 * **Asserted, not assumed.** This file previously derived the containing
 * window by arithmetic because the endpoint would not answer for it, and
 * got it wrong: the scan ran over a month in which none of the fixture's
 * facts hold, and said nothing. One assertion is the difference between
 * that happening again and a named failure.
 */
async function readingWindow(api: Api, routeId: string): Promise<{ start: Date; end: Date }> {
  const progress = await api.get<Progress>(`/api/v1/read-routes/${routeId}/progress`);
  const start = new Date(progress.windowStart);
  const end = new Date(progress.windowEnd);
  const today = utcToday();
  expect(
    start <= today && today <= end,
    `a route's progress window should contain today — got ${isoDay(start)}..${isoDay(end)} for ` +
      `${isoDay(today)}. Either the \`window\` default on ` +
      `/api/v1/read-routes/:id/progress moved off "reading", or the cycle is not monthly. ` +
      `Readings placed outside this window do not mean what this spec says they mean.`,
  ).toBe(true);
  return { start, end };
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

/**
 * The first day of the reading window with no posted sheet.
 *
 * Days already posted are left exactly as they are. The probe creates a
 * batch only for the day it settles on, because `openEntry` returns an
 * existing batch for every day it has to pass over. A batch that is still
 * `PENDING` is usable even if a previous run typed into it: this types
 * every row it cares about, so a half-finished attempt converges on the
 * same sheet.
 */
async function firstUnpostedDay(
  api: Api,
  routeId: string,
  readWindow: { start: Date; end: Date },
): Promise<string> {
  // Never past today: a reading is something somebody took, and a read
  // dated in the future is not a thing this journey should invent.
  const last = new Date(Math.min(readWindow.end.getTime(), utcToday().getTime()));

  const tried: string[] = [];
  for (let day = new Date(readWindow.start); day <= last; day = addDays(day, 1)) {
    const date = isoDay(day);
    const rows = await entryFor(api, routeId, date);
    if (rows.length > 0 && rows.every((r) => r.status === "PENDING")) return date;
    tried.push(date);
  }
  throw new Error(
    `Every day from ${isoDay(readWindow.start)} to ${isoDay(last)} already has a posted sheet ` +
      `for route ${ROUTE_CODE} (${tried.join(", ")}). Nothing posts twice, so this journey needs a ` +
      `day of its own. Either wait for the next window, or clear the typed sheets on the dev ` +
      `database:\n` +
      `  delete from import_row where import_batch_id in (select id from import_batch where ` +
      `mapping->>'kind' = 'read-route-entry');\n` +
      `  delete from import_batch where mapping->>'kind' = 'read-route-entry';`,
  );
}

/**
 * The staged row for a meter, and its register when the meter has more
 * than one.
 *
 * An omitted register means "this meter's only row" and **fails if there
 * are several** rather than silently taking the first — a meter that grew a
 * second register would otherwise quietly change which row every assertion
 * about it was talking about. It used to mean "the row whose register is
 * null", which was wrong for `WM-101`: the seeder gives it one active
 * register, so its row carries `"1"`.
 */
function staged(rows: EntryRow[], meter: string, register?: string): EntryRow {
  const matches = rows.filter(
    (r) => r.meterNumber === meter && (register === undefined || r.registerNumber === register),
  );
  const label = `${meter}${register ? `/r${register}` : ""}`;
  expect(
    matches.length,
    `${label} should be exactly one row of this sheet, found ${matches.length}` +
      (matches.length === 0 ? `. Run the scenario seeder:\n  ${SEEDER}` : ""),
  ).toBe(1);
  return matches[0]!;
}

/** A row on the entry screen, addressed by the walking order the API reported. */
function rowFor(page: Page, rows: EntryRow[], meter: string, register?: string): Locator {
  return page.getByTestId(`entry-row-${staged(rows, meter, register).rowIndex}`);
}

/**
 * The reading field: a `spinbutton` and only that.
 *
 * Never also a `textbox`. A row that has been given a skip reason grows a
 * **notes** textbox, so accepting either role would match the wrong
 * control on a coded row — or two controls, and fail strict mode. The
 * correction step types a number into a row that still carries its code,
 * which is exactly where that would have bitten.
 */
function readingField(row: Locator): Locator {
  return row.getByRole("spinbutton");
}

/** Where the meter's history says its next read should land. */
function nextReading(rows: EntryRow[], target: Target): number {
  const row = staged(rows, target.meter, target.register);
  return row.lastReading === null ? target.opening : Number(row.lastReading) + target.monthly;
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
  const pdf = await api.sheet(route.id, isoDay(utcToday()));
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
  // Not `window`: that is the DOM global, and this file also reaches for
  // `window.localStorage` inside the page.
  const readWindow = await readingWindow(api, route.id);
  const readDate = await firstUnpostedDay(api, route.id, readWindow);

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
  /*
   * The stop whose service closed before the window produces no row at
   * all, and the screen has to say so. A stop that vanishes from a sheet
   * without a trace is the silent failure design §5.1 forbids — the one
   * outcome here that nothing else reports.
   */
  await expect(
    page.getByText(/nothing to read/i),
    "the stop whose service ended should be named, not silently absent",
  ).toBeVisible();

  // ── 1. The frozen period refuses a number at the keyboard ──────────
  /*
   * Design §5.3 and the entry service's `READ_BILLED`: typing a reading
   * behind a posted bill is a mistake to catch at the row, not at submit.
   * The person must see it on the row they typed.
   */
  const billedRow = rowFor(page, rows, BILLED);
  await typeReading(billedRow, nextReading(rows, { meter: BILLED, opening: 101_500, monthly: 3_500 }));
  await expect(billedRow, "the billed row should say why it will not take a number").toContainText(
    /billed/i,
  );

  // ── 2. The readings ────────────────────────────────────────────────
  // Two registers, two rows, two numbers — one address, not one line.
  for (const target of READINGS) {
    await typeReading(rowFor(page, rows, target.meter, target.register), nextReading(rows, target));
  }

  // ── 3. Two stops coded, for one locked gate and one dog ────────────
  /*
   * The gate is in front of two meters, so one physical fact becomes two
   * rows here and two `read_skip` rows at submit (§5.3). The dog is at the
   * stop somebody already read off-route, and that code cannot stand: a
   * skip says no number exists, and one does.
   */
  for (const meter of BEHIND_THE_GATE) {
    await codeSkip(rowFor(page, rows, meter), "LOCKED_GATE");
  }
  await codeSkip(rowFor(page, rows, READ_OFF_ROUTE), "DOG");

  // Nothing has posted yet: the route posts as a whole.
  const beforeSubmit = await entryFor(api, route.id, readDate);
  expect(
    beforeSubmit.every((r) => r.status === "PENDING"),
    "a half-typed sheet is not a reading event — nothing may post before Submit",
  ).toBe(true);
  /*
   * And every number typed above really staged, which is not a formality:
   * when a reading falls outside the meter's own band the screen holds the
   * row and a single `Enter` writes nothing. That is the screen being
   * right, and this is what tells the difference between it and a broken
   * save — without it the symptom is a count three steps later.
   */
  for (const target of READINGS) {
    const row = staged(beforeSubmit, target.meter, target.register);
    expect(
      row.reading,
      `${target.meter}${target.register ? `/r${target.register}` : ""} should have staged a ` +
        `reading on Enter; a null here means the row was held as an outlier`,
    ).not.toBeNull();
  }
  expect(
    staged(beforeSubmit, BILLED).reading,
    "the refused row should have staged nothing",
  ).toBeNull();

  // ── 4. Post the route ──────────────────────────────────────────────
  await page.getByRole("button", { name: POST_THE_ROUTE }).click();

  const refusedRow = rowFor(page, rows, READ_OFF_ROUTE);
  await expect(
    refusedRow,
    "the stop whose meter was already read should show its refusal on the row",
  ).toContainText(/already has a read|METER_ALREADY_READ/i, { timeout: 60_000 });

  const posted = await entryFor(api, route.id, readDate);
  for (const target of READINGS) {
    expect(
      staged(posted, target.meter, target.register).status,
      `${target.meter} should have posted`,
    ).toBe("IMPORTED");
  }
  // Coded and accepted: a skip, not a read of zero.
  for (const meter of BEHIND_THE_GATE) {
    expect(staged(posted, meter).status).toBe("SKIPPED");
  }
  // Nothing was typed here, so nothing was posted and nothing was invented.
  expect(staged(posted, BILLED).status).toBe("SKIPPED");
  expect(staged(posted, BILLED).errorCode).toBe("NOT_ENTERED");
  // And the one the server would not take.
  expect(staged(posted, READ_OFF_ROUTE).status).toBe("ERROR");
  expect(staged(posted, READ_OFF_ROUTE).errorCode).toBe("METER_ALREADY_READ");

  /*
   * The two skip rows reach the outstanding list with their reason, which
   * is the whole point of recording one: the screen can say *why* instead
   * of just *missing*.
   *
   * Asked with `asOf` the **sheet's own day**, not today's. §5.12's
   * property is that the count matches the sheet printed for that date, and
   * the service now expands the stops at the day for a reading question
   * rather than at the window's last day — which for a reading window is
   * the next bill day, weeks ahead.
   */
  const afterSubmit = await api.get<Progress>(
    `/api/v1/read-routes/${route.id}/progress?asOf=${readDate}`,
  );
  for (const meter of BEHIND_THE_GATE) {
    const row = afterSubmit.data.find((r) => r.meterNumber === meter);
    expect(row, `${meter} should still be outstanding`).toBeTruthy();
    expect(row!.skipReason, `${meter} should say why it was not read`).toBe("LOCKED_GATE");
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
  await page.getByRole("button", { name: CORRECT_REFUSED }).click();
  /*
   * The number is typed over a row that still carries its `DOG` code:
   * reopening clears a row's error, not its staged `skipReason`. So the
   * row must send the reading **alone** — `saveEntryRow` then clears the
   * code, and refuses the pair with `ENTRY_ROW_AMBIGUOUS` if both are
   * sent. The only symptom would be this row coming back SKIPPED instead
   * of IMPORTED, which the assertion below is.
   */
  await typeReading(rowFor(page, rows, READ_OFF_ROUTE), nextReading(posted, CORRECTION));
  await page.getByRole("button", { name: POST_THE_ROUTE }).click();

  /*
   * Waited for **positively**. The obvious assertion — that the refusal is
   * gone from the row — is already true before this click, because
   * reopening cleared it, so it waits for nothing and the read-back below
   * races the post. The page says what it posted; that is the event.
   */
  await expect(
    page.getByText(/readings? posted/i),
    "the post should report what it posted",
  ).toBeVisible({ timeout: 60_000 });

  const corrected = await entryFor(api, route.id, readDate);
  expect(staged(corrected, READ_OFF_ROUTE).status).toBe("IMPORTED");
  expect(
    corrected.filter((r) => r.status === "IMPORTED").length,
    "the correction should add one posted row, not re-post the five that already landed",
  ).toBe(READINGS.length + 1);
  expect(corrected.filter((r) => r.status === "ERROR").length).toBe(0);
});
