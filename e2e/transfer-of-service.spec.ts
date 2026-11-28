import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { bearer, signIn } from "./support/dev-stack.js";
import { deleteAgreementsByPrefix, deleteMeterAndPremise } from "./support/dev-db.js";

/**
 * Transfer of service, and the tenant flag that decides what it carries
 * — both in a real browser against the running dev stack.
 *
 * **Why a browser test for this.** Two screens changed on 2026-11-18 and
 * neither had any browser coverage at all:
 *
 *  - `/settings/general` grew a **Transfer of Service** section with the
 *    `transferCarriesRateSchedule` toggle. A jsdom test of that component
 *    mocks `apiClient`, so it can only prove the checkbox calls the
 *    function it was handed. It cannot prove the PATCH body reaches a
 *    route that accepts the key — and this codebase has shipped three
 *    filters whose keys the server's Zod schema never declared, which
 *    failed exactly that way: request succeeds, nothing changes, mocked
 *    test still green. So the toggle is saved here and then **read back
 *    from the API**, not from the screen that just wrote it.
 *  - `/workflows/transfer` had never been driven by anything. The
 *    workflow behind it had no test of any kind in either vitest config
 *    until the same day (spec 05 open item 4), which is how three
 *    product decisions and a discarded input sat inside it unnoticed.
 *
 * `transfer-service.integration.test.ts` covers the row-level rules
 * against a container — the mirror, the carry, the three refusals. This
 * file covers the one thing that suite cannot: that the screens a person
 * actually uses reach those rules.
 *
 * ## It leaves nothing behind, which takes doing
 *
 * A transfer is **irreversible by design**: the source agreement goes
 * FINAL and a new one opens. There is no `DELETE
 * /api/v1/service-agreements/:id` — closing is the lifecycle, deleting is
 * not an operation — and none for meters or premises either, so this spec
 * cannot tidy up through the API the way `read-route-walk.spec.ts` empties
 * its walk. `support/dev-db.ts` does it with SQL as the schema owner, and
 * that file carries the argument for why teardown may do this while setup
 * may not.
 *
 * Everything it touches is **its own**: its premise, its meter, its
 * agreements, all marked `E2E-XFER`. It clears them in `beforeAll` as
 * well as `afterAll`, so a run killed part-way (Ctrl-C, a closed
 * terminal) poisons nothing — the next run starts from the same place
 * either way — and it confirms they are gone **through the API**, because
 * a teardown checked with the connection that performed it shares its
 * failure modes.
 *
 * **It creates its own premise rather than borrowing a seeded one**, and
 * that is not tidiness. The first version picked the first premise
 * serving water — 36 N Willson Ave, which the seed already gives a live
 * water agreement — so every run added a *second* live water service at
 * one address held by a different account. That is the double-billing
 * state spec 05's missing overlap constraint is supposed to prevent, and
 * the spec was manufacturing it.
 *
 * The tenant flag is forced back on in `afterEach` whether the test
 * passed or not: left off, every transfer anybody does on this database
 * afterwards silently produces an unrated agreement.
 *
 * Needs the base dev seed (`seed_db.bat`) for its two accounts, the water
 * commodity, a unit of measure and a published water rate schedule.
 */

const ADMIN = "System Admin";
/**
 * The address behind that pill (`app/login/page.tsx`), for the teardown.
 *
 * Teardown mints its own token straight from `/auth/dev-login` rather
 * than driving the browser, on the same principle `read-route-walk`
 * states: a cleanup that needs the screen to work cannot clean up after
 * the screen failing.
 */
const ADMIN_EMAIL = "sysadmin@utility.com";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4001";

/** This spec's own rows, recognisable in a database it shares. */
const FIXTURE_PREFIX = "E2E-XFER";
const FIXTURE_METER = "E2E-XFER-MTR";
/**
 * Its own address, so the service it transfers is at a premise nothing
 * else serves. See the note above about what borrowing a seeded premise
 * did.
 */
const FIXTURE_ADDRESS = "1 E2E Transfer Way";

/** The commodity the fixture premise and meter are on. */
const COMMODITY_CODE = "WATER";

interface Commodity {
  id: string;
  code: string;
}

interface Uom {
  id: string;
  code: string;
  commodityId: string;
}

interface RateSchedule {
  id: string;
  code: string;
  commodityId: string;
  publishedAt: string | null;
}

interface Premise {
  id: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  commodityIds: string[];
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

interface Assignment {
  id: string;
  serviceAgreementId: string;
  rateScheduleId: string;
  roleCode: string;
  effectiveDate: string;
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
  commodityId: string;
  rateServiceClassId: string;
  status: string;
  startDate: string;
  endDate: string | null;
  servicePoints?: ServicePoint[];
  rateScheduleAssignments?: Assignment[];
}

interface TenantConfig {
  /** Which tenant the token acts for — the teardown scopes its deletes on it. */
  utilityId: string;
  requireHoldApproval: boolean;
  transferCarriesRateSchedule: boolean;
}

interface AuditRow {
  entityType: string;
  entityId: string;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
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

  async patch<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request.patch(`${API_URL}${path}`, {
      headers: { authorization: this.authorization },
      data: body,
    });
    expect(response.ok(), `PATCH ${path} -> ${response.status()} ${await response.text()}`).toBe(
      true,
    );
    return (await response.json()) as T;
  }

  config(): Promise<TenantConfig> {
    return this.get<TenantConfig>("/api/v1/tenant-config");
  }

  setCarry(on: boolean): Promise<TenantConfig> {
    return this.patch<TenantConfig>("/api/v1/tenant-config", {
      transferCarriesRateSchedule: on,
    });
  }

  agreement(id: string): Promise<Agreement> {
    return this.get<Agreement>(`/api/v1/service-agreements/${id}`);
  }

  agreements(): Promise<Agreement[]> {
    return this.get<{ data: Agreement[] }>("/api/v1/service-agreements?limit=500").then(
      (r) => r.data,
    );
  }

  accounts(): Promise<Account[]> {
    return this.get<{ data: Account[] }>("/api/v1/accounts?status=ACTIVE&limit=500").then(
      (r) => r.data,
    );
  }

  auditFor(entityId: string): Promise<AuditRow[]> {
    return this.get<{ data: AuditRow[] }>(
      `/api/v1/audit-log?entityType=Workflow&entityId=${entityId}`,
    ).then((r) => r.data);
  }
}

/** A bearer token without a browser, for setup and teardown. */
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

/** Today, the way both the wizard's date field and the API want it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The address the wizard composes for its source panel, so an assertion
 * built from an API row matches the text on screen. Kept in step with
 * `premiseLine` in `app/workflows/transfer/page.tsx` — if that changes
 * this fails loudly rather than matching nothing.
 *
 * That assertion is the reason this file exists in the shape it does: it
 * is what caught the panel rendering `premise: ,` for every transfer
 * ever confirmed on that screen, because the page read an
 * `agreement.premise` the API has never sent.
 */
function addressOf(p: Premise): string {
  return [p.addressLine1, p.addressLine2].filter(Boolean).join(" ") + `, ${p.city}`;
}

interface Fixture {
  agreement: Agreement;
  premise: Premise;
  meterId: string;
  rateScheduleId: string;
  /** The account holding it now, and the one it will move to. */
  source: Account;
  target: Account;
}

/**
 * Build the whole fixture through the API: a premise of its own, a meter
 * on it, an ACTIVE water agreement holding that meter, and the tariff
 * whose carry the test is about.
 *
 * Created fresh each run rather than found-or-created, because
 * `beforeAll` has just removed the last run's and verified it. A
 * collision here should fail loudly, not be silently reused.
 */
async function makeFixture(api: Api): Promise<Fixture> {
  const commodities = await api.get<Commodity[]>("/api/v1/commodities");
  const commodity = commodities.find((c) => c.code === COMMODITY_CODE);
  expect(commodity, `no ${COMMODITY_CODE} commodity — run seed_db.bat`).toBeDefined();

  const { data: schedules } = await api.get<{ data: RateSchedule[] }>(
    "/api/v1/rate-schedules?limit=200",
  );
  const schedule = schedules.find((s) => s.commodityId === commodity!.id && s.publishedAt);
  expect(schedule, `no published ${COMMODITY_CODE} rate schedule — run seed_db.bat`).toBeDefined();

  const uoms = await api.get<Uom[]>("/api/v1/uom");
  const uom = uoms.find((u) => u.commodityId === commodity!.id);
  expect(uom, `no unit of measure for ${COMMODITY_CODE} — run seed_db.bat`).toBeDefined();

  const accounts = await api.accounts();
  expect(
    accounts.length,
    "a transfer needs two ACTIVE accounts — run seed_db.bat",
  ).toBeGreaterThanOrEqual(2);
  // Sorted, so a failure names the same two accounts every run.
  const [source, target] = [...accounts]
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber))
    .slice(0, 2);

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
  // 2026-11-28). Whichever the commodity offers first, as the screen does;
  // the transfer must carry it to the new agreement.
  const { data: classes } = await api.get<{ data: { id: string }[] }>(
    `/api/v1/service-agreements/service-classes?commodityId=${commodity!.id}`,
  );
  expect(classes.length, `no service class for ${COMMODITY_CODE} — run seed_db.bat`).toBeGreaterThan(0);

  const agreement = await api.post<Agreement>("/api/v1/service-agreements", {
    agreementNumber: `${FIXTURE_PREFIX}-SRC`,
    accountId: source.id,
    premiseId: premise.id,
    commodityId: commodity!.id,
    rateServiceClassId: classes[0]!.id,
    startDate: today(),
    status: "ACTIVE",
    meters: [{ meterId: meter.id, isPrimary: true }],
  });

  await api.post<Assignment>("/api/v1/sa-rate-schedule-assignments", {
    serviceAgreementId: agreement.id,
    rateScheduleId: schedule!.id,
    roleCode: "primary",
    effectiveDate: today(),
  });

  return {
    agreement: await api.agreement(agreement.id),
    premise,
    meterId: meter.id,
    rateScheduleId: schedule!.id,
    source,
    target,
  };
}

/**
 * Remove everything this spec's marks name, and prove it through the API.
 *
 * Runs before as well as after: an interrupted run leaves rows that would
 * otherwise collide with the next one's `create`, and a spec that only
 * tidies up on the way out depends on having got there.
 */
async function clearFixtures(api: Api): Promise<void> {
  const { utilityId } = await api.config();
  deleteAgreementsByPrefix(utilityId, FIXTURE_PREFIX);
  deleteMeterAndPremise(utilityId, FIXTURE_METER, FIXTURE_ADDRESS);

  // Through the API, not the connection that just did the deleting.
  const left = (await api.agreements()).filter((a) =>
    a.agreementNumber.startsWith(FIXTURE_PREFIX),
  );
  expect(
    left.map((a) => `${a.agreementNumber} (${a.status})`),
    "every E2E-XFER agreement should be gone after teardown",
  ).toEqual([]);
  const { data: meters } = await api.get<{ data: Meter[] }>(
    `/api/v1/meters?limit=200&search=${FIXTURE_METER}`,
  );
  expect(
    meters.filter((m) => m.meterNumber === FIXTURE_METER),
    "the fixture meter should be gone after teardown",
  ).toEqual([]);
}

/** The `<select>` offering this option — the form's controls carry no labels. */
function selectOffering(page: Page, optionValue: string) {
  return page.locator("select").filter({ has: page.locator(`option[value="${optionValue}"]`) });
}

test.describe("Transfer of service", () => {
  test.beforeAll(async ({ request }) => {
    await clearFixtures(new Api(request, await devToken(request)));
  });

  test.afterAll(async ({ request }) => {
    await clearFixtures(new Api(request, await devToken(request)));
  });

  test.afterEach(async ({ request }) => {
    /*
     * The carry goes back on however the test ended.
     *
     * It is a tenant-wide flag on the shared dev database: left off by
     * an interrupted run, every transfer anybody does afterwards
     * silently produces an unrated agreement, and nothing on the
     * transfer screen says why. That is a worse thing to leave behind
     * than the row this spec cannot help leaving.
     *
     * Through the API with its own token, not through the signed-in
     * page: a test that failed may have failed at sign-in, and a
     * teardown that needs the screen cannot clean up after the screen.
     */
    const api = new Api(request, await devToken(request));
    await api.setCarry(true);
    expect((await api.config()).transferCarriesRateSchedule).toBe(true);
  });

  test("the rate-schedule carry can be switched off from Settings and read back off the API", async ({
    page,
    request,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(request, await bearer(page));
    await api.setCarry(true);

    await page.goto("/settings/general");

    const toggle = page.getByRole("checkbox", { name: /Carry the rate schedule/i });
    await expect(toggle).toBeVisible();
    // On, because the column default and the service's own default both
    // say so — a utility that does nothing gets the tariff following the
    // service.
    await expect(toggle).toBeChecked();

    const save = page.getByRole("button", { name: /Save Changes/i });
    // Nothing has changed yet, so there is nothing to save. A Save that
    // is live on arrival means the screen's dirty check is wrong.
    await expect(save).toBeDisabled();

    await toggle.uncheck();
    await expect(save).toBeEnabled();
    await save.click();

    /*
     * Read the server, not the screen.
     *
     * The component holds its own state, so an assertion on the checkbox
     * here would pass whether or not the PATCH body carried a key the
     * route declares — which is the exact way three filters in this
     * codebase shipped broken.
     */
    await expect(async () => {
      expect((await api.config()).transferCarriesRateSchedule).toBe(false);
    }).toPass({ timeout: 10_000 });

    // And the screen reads it back: a reload is served from the API, so
    // this is the round trip rather than the same state object.
    await page.reload();
    await expect(page.getByRole("checkbox", { name: /Carry the rate schedule/i })).not.toBeChecked();

    // Back on through the UI, which is also the second half of the
    // round trip.
    await page.getByRole("checkbox", { name: /Carry the rate schedule/i }).check();
    await page.getByRole("button", { name: /Save Changes/i }).click();
    await expect(async () => {
      expect((await api.config()).transferCarriesRateSchedule).toBe(true);
    }).toPass({ timeout: 10_000 });

    // The other flag on this tab is untouched. The two share one PATCH
    // body and one dirty check, so a save of either must not move the
    // other.
    expect((await api.config()).requireHoldApproval).toBe(false);
  });

  test("a transfer committed in the wizard moves the service, carries the tariff, and keeps the reason", async ({
    page,
    request,
  }) => {
    await signIn(page, ADMIN);
    const api = new Api(request, await bearer(page));
    await api.setCarry(true);

    const fixture = await makeFixture(api);
    const source = fixture.agreement;
    const target = fixture.target;
    expect(target.id, "source and target must be different accounts").not.toBe(source.accountId);

    const sourcePoints = (source.servicePoints ?? []).filter((sp) => sp.endDate === null);
    expect(sourcePoints, "the fixture agreement should have one open service point").toHaveLength(1);
    const newNumber = `${FIXTURE_PREFIX}-${Date.now().toString(36).toUpperCase()}`;
    const reason = `e2e ping-pong ${newNumber}`;

    await page.goto("/workflows/transfer");
    await expect(page.getByRole("heading", { name: "Transfer Service" })).toBeVisible();

    await selectOffering(page, source.id).selectOption(source.id);
    // The screen agrees about what was picked. The source panel is
    // rendered from the list row, so this is the page's own reading of
    // the agreement, not an echo of the value just set.
    await expect(page.getByText(addressOf(fixture.premise), { exact: false })).toBeVisible();

    await selectOffering(page, target.id).selectOption(target.id);
    /*
     * The `<strong>` in the target panel, not `getByText`.
     *
     * The account number is also the text of the `<option>` that was
     * just chosen, and an option inside a collapsed `<select>` is
     * `hidden` — so a plain text locator resolves to the option and
     * never becomes visible. The panel is the page's own confirmation of
     * the choice, which is the thing worth asserting.
     */
    await expect(page.locator("strong").filter({ hasText: target.accountNumber })).toBeVisible();

    await page.locator('input[type="date"]').fill(today());
    await page.getByPlaceholder("Auto-generate").fill(newNumber);
    await page.getByPlaceholder(/Sale of property/).fill(reason);

    await page.getByRole("button", { name: /COMMIT TRANSFER/ }).click();

    // The wizard sends the operator to the new agreement, which is where
    // the id comes from — no other screen hands it over.
    await page.waitForURL(/\/service-agreements\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const newId = new URL(page.url()).pathname.split("/").pop()!;
    expect(newId).not.toBe(source.id);

    // ── Everything below is read from the API, because the page that
    // ── just wrote it is not evidence about what landed.
    const closed = await api.agreement(source.id);
    expect(closed.status).toBe("FINAL");
    expect(closed.endDate?.slice(0, 10)).toBe(today());

    const opened = await api.agreement(newId);
    expect(opened.agreementNumber).toBe(newNumber);
    expect(opened.accountId).toBe(target.id);
    expect(opened.status).toBe("ACTIVE");
    expect(opened.commodityId).toBe(source.commodityId);
    // The service class followed too: the new account is billed as the
    // same kind of customer until someone says otherwise.
    expect(opened.rateServiceClassId).toBe(source.rateServiceClassId);

    // One point, at the same premise, holding the same meter: the
    // mirror's one-premise case end to end.
    const openedPoints = (opened.servicePoints ?? []).filter((sp) => sp.endDate === null);
    expect(openedPoints).toHaveLength(1);
    expect(openedPoints[0].premiseId).toBe(fixture.premise.id);
    expect(
      (openedPoints[0].meters ?? []).filter((m) => m.removedDate === null).map((m) => m.meterId),
    ).toEqual([fixture.meterId]);

    // The tariff followed, dated from the transfer rather than from the
    // source's own effective date.
    const carried = opened.rateScheduleAssignments ?? [];
    expect(carried.map((a) => a.rateScheduleId)).toContain(fixture.rateScheduleId);
    const primary = carried.find((a) => a.rateScheduleId === fixture.rateScheduleId)!;
    expect(primary.roleCode).toBe("primary");
    expect(primary.effectiveDate.slice(0, 10)).toBe(today());

    /*
     * The operator's reason survived.
     *
     * The wizard has offered this field since it shipped and the
     * workflow read it nowhere — it passed a constructed string to the
     * close and recorded nothing — so a CSR's "sale of property" went
     * into a 2000-character box and was dropped on submit. Asserted
     * through the audit log because that is where it now lives; there
     * is no column for it on the agreement.
     */
    const audit = await api.auditFor(newId);
    expect(audit.length, "the transfer should have written one Workflow audit row").toBe(1);
    expect(audit[0].metadata?.eventType).toBe("workflow.transfer_service");
    expect(audit[0].afterState?.reason).toBe(reason);
    expect(audit[0].afterState?.servicePointsMirrored).toBe(1);
    expect(audit[0].afterState?.rateScheduleAssignmentsCarried).toBe(1);
  });
});
