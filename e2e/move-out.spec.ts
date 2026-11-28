import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { bearer, signIn } from "./support/dev-stack.js";
import { deleteAgreementsByPrefix, deleteMeterAndPremise } from "./support/dev-db.js";

/**
 * The move-out wizard, driven in a real browser against real rows.
 *
 * **This screen could not work at all until 2026-11-18**, and no test in
 * the repo could see it. Its `ServiceAgreement` interface declared a flat
 * `premise` and a flat `meters`, and `GET /api/v1/service-agreements`
 * sends neither — it sends `servicePoints[]`, each carrying its own
 * premise and its own meters. Three derived values read those absent
 * fields, so:
 *
 *  - step 2's **premise picker had no options**, so the wizard could not
 *    be completed by anybody;
 *  - **no meters were ever listed**, so no final reads could be entered;
 *  - `step3Valid` is `every()` over that empty list, which is **true**,
 *    so had the premise picker worked, Finish would have been live with
 *    no reads captured and the workflow posted an empty
 *    `finalMeterReadings` — a move-out with no closing reads, which is
 *    the one thing a move-out exists to capture.
 *
 * It had no jsdom test either, and a jsdom test would not have helped: a
 * mock built from that interface supplies exactly the fields the server
 * does not. Only a real response can disagree with the page about what it
 * contains. That is this file's reason to exist, and the premise-option
 * assertion below is the one that fails on the old code.
 *
 * ## Fixtures and teardown
 *
 * Everything is created through the API and marked `E2E-MOUT`: its own
 * premise, its own meter, its own agreement. **Its own premise** because
 * a move-out finalizes every live agreement on an account at a premise —
 * pointed at a seeded address it would close somebody else's fixture.
 *
 * A move-out cannot be undone and there is no delete endpoint for an
 * agreement, a meter or a premise, so `support/dev-db.ts` removes the
 * rows with SQL afterwards and the result is confirmed through the API.
 * It clears before as well as after, so an interrupted run poisons
 * nothing.
 *
 * `closeAccount` and `refundDeposit` are left off deliberately: both act
 * on a seeded account, and neither is this spec's subject.
 *
 * Needs the base dev seed (`seed_db.bat`) for an ACTIVE account, the
 * water commodity and a unit of measure.
 */

const ADMIN = "System Admin";
const ADMIN_EMAIL = "sysadmin@utility.com";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

const FIXTURE_PREFIX = "E2E-MOUT";
const FIXTURE_METER = "E2E-MOUT-MTR";
const FIXTURE_ADDRESS = "2 E2E MoveOut Way";
const COMMODITY_CODE = "WATER";

/** The closing read the test types in. */
const FINAL_READING = 8421;

interface Commodity {
  id: string;
  code: string;
}

interface Uom {
  id: string;
  code: string;
  commodityId: string;
}

interface Premise {
  id: string;
  addressLine1: string;
  city: string;
}

interface Account {
  id: string;
  accountNumber: string;
  status: string;
}

interface Meter {
  id: string;
  meterNumber: string;
}

interface ServicePoint {
  id: string;
  premiseId: string;
  endDate: string | null;
  meters?: { meterId: string; removedDate: string | null }[];
}

interface Agreement {
  id: string;
  agreementNumber: string;
  accountId: string;
  status: string;
  endDate: string | null;
  servicePoints?: ServicePoint[];
}

interface MeterRead {
  id: string;
  meterId: string;
  readDate: string;
  reading: string;
  readType: string;
}

/** A row of `GET /api/v1/meters/:id/assignment-history`. */
interface AssignmentHistoryRow {
  id: string;
  addedDate: string;
  removedDate: string | null;
  servicePoint: {
    id: string;
    serviceAgreement: { id: string; agreementNumber: string; status: string };
  };
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

  utilityId(): Promise<string> {
    return this.get<{ utilityId: string }>("/api/v1/tenant-config").then((c) => c.utilityId);
  }

  agreement(id: string): Promise<Agreement> {
    return this.get<Agreement>(`/api/v1/service-agreements/${id}`);
  }

  agreements(): Promise<Agreement[]> {
    return this.get<{ data: Agreement[] }>("/api/v1/service-agreements?limit=500").then(
      (r) => r.data,
    );
  }

  readsFor(meterId: string): Promise<MeterRead[]> {
    return this.get<{ data: MeterRead[] }>(
      `/api/v1/meter-reads?limit=50&meterId=${meterId}`,
    ).then((r) => r.data);
  }

  /** A bare array, not a paginated envelope. */
  assignmentHistory(meterId: string): Promise<AssignmentHistoryRow[]> {
    return this.get<AssignmentHistoryRow[]>(`/api/v1/meters/${meterId}/assignment-history`);
  }
}

async function devToken(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_URL}/api/v1/auth/dev-login`, {
    data: { email: ADMIN_EMAIL },
  });
  expect(
    response.ok(),
    `dev-login -> ${response.status()}; is the dev stack up on ${API_URL}?`,
  ).toBe(true);
  const { token } = (await response.json()) as { token: string };
  return `Bearer ${token}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Fixture {
  account: Account;
  premise: Premise;
  meter: Meter;
  agreement: Agreement;
}

async function makeFixture(api: Api): Promise<Fixture> {
  const commodities = await api.get<Commodity[]>("/api/v1/commodities");
  const commodity = commodities.find((c) => c.code === COMMODITY_CODE);
  expect(commodity, `no ${COMMODITY_CODE} commodity — run seed_db.bat`).toBeDefined();

  const uoms = await api.get<Uom[]>("/api/v1/uom");
  const uom = uoms.find((u) => u.commodityId === commodity!.id);
  expect(uom, `no unit of measure for ${COMMODITY_CODE} — run seed_db.bat`).toBeDefined();

  const { data: accounts } = await api.get<{ data: Account[] }>(
    "/api/v1/accounts?status=ACTIVE&limit=500",
  );
  expect(accounts.length, "needs an ACTIVE account — run seed_db.bat").toBeGreaterThan(0);
  // Sorted, so a failure names the same account every run.
  const account = [...accounts].sort((a, b) =>
    a.accountNumber.localeCompare(b.accountNumber),
  )[0];

  const premise = await api.post<Premise>("/api/v1/premises", {
    addressLine1: FIXTURE_ADDRESS,
    city: "Testville",
    state: "MT",
    zip: "59715",
    premiseType: "RESIDENTIAL",
    commodityIds: [commodity!.id],
    status: "ACTIVE",
  });

  const meter = await api.post<Meter>("/api/v1/meters", {
    premiseId: premise.id,
    meterNumber: FIXTURE_METER,
    commodityId: commodity!.id,
    meterType: "MANUAL",
    uomId: uom!.id,
    installDate: today(),
    status: "ACTIVE",
  });

  // Every agreement is in a service class (spec 05, required since
  // 2026-11-28). Whichever the commodity offers first, as the screen does.
  const { data: classes } = await api.get<{ data: { id: string }[] }>(
    `/api/v1/service-agreements/service-classes?commodityId=${commodity!.id}`,
  );
  expect(classes.length, `no service class for ${COMMODITY_CODE} — run seed_db.bat`).toBeGreaterThan(0);

  const agreement = await api.post<Agreement>("/api/v1/service-agreements", {
    agreementNumber: `${FIXTURE_PREFIX}-SRC`,
    accountId: account.id,
    premiseId: premise.id,
    commodityId: commodity!.id,
    rateServiceClassId: classes[0]!.id,
    startDate: today(),
    status: "ACTIVE",
    meters: [{ meterId: meter.id, isPrimary: true }],
  });

  return { account, premise, meter, agreement: await api.agreement(agreement.id) };
}

/** Remove this spec's rows, and prove it through the API. */
async function clearFixtures(api: Api): Promise<void> {
  const utilityId = await api.utilityId();
  deleteAgreementsByPrefix(utilityId, FIXTURE_PREFIX);
  deleteMeterAndPremise(utilityId, FIXTURE_METER, FIXTURE_ADDRESS);

  const left = (await api.agreements()).filter((a) =>
    a.agreementNumber.startsWith(FIXTURE_PREFIX),
  );
  expect(
    left.map((a) => `${a.agreementNumber} (${a.status})`),
    "every E2E-MOUT agreement should be gone after teardown",
  ).toEqual([]);
}

/** Pick a value in a `SearchableEntitySelect` the way a person does. */
async function pickFromCombobox(page: Page, label: string, query: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("textbox", { name: `Search ${label}` }).fill(query);
  // The listbox is populated by a debounced fetch, so the option is not
  // there on the keystroke.
  await page.getByRole("option", { name: new RegExp(query) }).first().click();
}

test.describe("Move out", () => {
  test.beforeAll(async ({ request }) => {
    await clearFixtures(new Api(request, await devToken(request)));
  });

  test.afterAll(async ({ request }) => {
    await clearFixtures(new Api(request, await devToken(request)));
  });

  test("finalizes the agreement at the chosen premise and records the closing read", async ({
    page,
    request,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(request, await bearer(page));
    const fixture = await makeFixture(api);

    await page.goto("/workflows/move-out");
    await expect(page.getByRole("heading", { name: "Move Out" })).toBeVisible();

    // ── Step 1: the account
    await pickFromCombobox(page, "Account", fixture.account.accountNumber);
    await page.getByRole("button", { name: /NEXT/ }).click();

    /*
     * ── Step 2: the premise.
     *
     * **This is the assertion the old code fails.** `premisesAtAccount`
     * was derived from an `agreement.premise` the API never sends, so
     * this select held only its placeholder and `selectOption` finds
     * nothing — whatever else the page did. Selecting by value, because
     * that is the id the page must have put there.
     */
    const premiseSelect = page.locator("select").filter({
      has: page.locator(`option[value="${fixture.premise.id}"]`),
    });
    await expect(
      premiseSelect,
      "step 2 should offer the premise the fixture agreement serves",
    ).toBeVisible();
    await premiseSelect.selectOption(fixture.premise.id);

    await page.locator('input[type="date"]').fill(today());

    // The page's own count of what it is about to do. One agreement, one
    // meter — and both were 0 before the fix, which is what made the
    // screen look merely empty rather than broken.
    await expect(page.getByText(/agreements_to_finalize:/)).toContainText("1");
    await expect(page.getByText(/meters_to_read:/)).toContainText("1");

    await page.getByRole("button", { name: /NEXT/ }).click();

    // ── Step 3: the closing read
    await expect(page.getByText(FIXTURE_METER)).toBeVisible();
    const readingBox = page.getByPlaceholder("Final reading");
    await expect(readingBox).toHaveCount(1);
    await readingBox.fill(String(FINAL_READING));

    const commit = page.getByRole("button", { name: /COMMIT MOVE-OUT/ });
    await expect(commit).toBeEnabled();
    await commit.click();

    // The wizard returns to the account it acted on.
    await page.waitForURL(new RegExp(`/accounts/${fixture.account.id}$`), { timeout: 30_000 });

    // ── Everything below is read from the API: the page that just wrote
    // ── this is not evidence about what landed.
    const closed = await api.agreement(fixture.agreement.id);
    expect(closed.status).toBe("FINAL");
    expect(closed.endDate?.slice(0, 10)).toBe(today());

    /*
     * The meter is detached, so it is free to be installed elsewhere —
     * `closeServiceAgreement`'s cascade.
     *
     * Through `assignment-history` rather than the agreement's
     * `servicePoints`, which cannot answer this: `fullInclude` filters
     * points to `endDate: null` and their meters to `removedDate: null`,
     * so a finalized agreement reports **no** points and an assertion
     * there would be about an empty array either way. The history
     * endpoint exists precisely to show closed assignments.
     */
    const history = await api.assignmentHistory(fixture.meter.id);
    const mine = history.filter(
      (h) => h.servicePoint.serviceAgreement.id === fixture.agreement.id,
    );
    expect(mine, "the meter should have one assignment, to the agreement just closed").toHaveLength(
      1,
    );
    expect(mine[0].removedDate?.slice(0, 10)).toBe(today());
    expect(mine[0].servicePoint.serviceAgreement.status).toBe("FINAL");

    /*
     * The closing read exists, with the number that was typed.
     *
     * This is the assertion that would have caught the vacuous
     * `step3Valid`: with no meters listed, the wizard posted
     * `finalMeterReadings: []` and no read was written, while every
     * agreement still went FINAL.
     */
    const reads = await api.readsFor(fixture.meter.id);
    const final = reads.filter((r) => r.readType === "FINAL");
    expect(final, "a move-out should write one FINAL read for the meter").toHaveLength(1);
    expect(Number(final[0].reading)).toBe(FINAL_READING);
    expect(final[0].readDate.slice(0, 10)).toBe(today());
  });
});
