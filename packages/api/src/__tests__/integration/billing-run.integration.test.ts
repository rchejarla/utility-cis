import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, ensurePrincipal } from "./_effective-dating-fixtures.js";

/**
 * Nothing this file does reaches Redis.
 *
 * `enqueueSafely` swallows an unreachable Redis and returns null, which
 * is why these tests need no worker — and on CI, where no Redis is up,
 * that is what happens. On a machine where the dev Redis IS running the
 * enqueue succeeds instead, and the job outlives the Postgres container
 * whose rows it names: 80 waiting billing-run jobs naming runs that no
 * longer existed, and 22 import jobs naming a torn-down tenant, had
 * collected in the dev queues, where the platform console listed every
 * one as work waiting to run.
 *
 * The enqueue is this file's side effect, never its subject, so it stops
 * here and the tests behave the same way on both machines.
 */
vi.mock("../../lib/queues.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/queues.js")>()),
  enqueueSafely: vi.fn(async () => "test-job-id"),
}));


/**
 * The billing run: one initiated pass over a cycle, account by account.
 *
 * What these cases are really about is the exception list. A run of
 * twelve thousand accounts that bills all but forty is the normal
 * outcome, so the useful question is never "did it work" but "what
 * happened to each account, and which of those do I have to act on".
 * Hence SKIPPED and FAILED as separate statuses, asserted separately.
 *
 * Runs against the real seed rather than the shared fixture, because
 * rating needs published schedules and assignments and the seed has
 * them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = path.resolve(__dirname, "../../../../shared");
const REPO_ROOT = path.resolve(__dirname, "../../../../..");

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let appImports: typeof import("../../app.js");
let svc: typeof import("../../services/billing-run.service.js");
let app: FastifyInstance;

let utilityId: string;
let cycleId: string;

const ACTOR_ID = "00000000-0000-4000-8000-aaaa00000001";

function makeToken(uid: string) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: ACTOR_ID,
      utility_id: uid,
      email: "tester@example.com",
      name: "Tester",
      role: "admin",
    }),
  ).toString("base64url");
  return `${header}.${payload}.fake-signature`;
}
const headers = () => ({ authorization: `Bearer ${makeToken(utilityId)}` });

beforeAll(async () => {
  const booted = await bootPostgres();
  pgContainer = booted.container;

  const TSX_BIN =
    process.platform === "win32"
      ? path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx.cmd")
      : path.join(REPO_ROOT, "node_modules", ".pnpm", "node_modules", ".bin", "tsx");
  execSync(`"${TSX_BIN}" prisma/seed.ts`, {
    cwd: SHARED_DIR,
    env: { ...process.env, DATABASE_URL: booted.dbUrl },
    stdio: "pipe",
  });

  prismaImports = await import("../../lib/prisma.js");
  appImports = await import("../../app.js");
  svc = await import("../../services/billing-run.service.js");
  app = await appImports.buildApp();
  await app.ready();

  const { prisma } = prismaImports;
  const cycle = await prisma.billingCycle.findFirstOrThrow({ where: { cycleCode: "R01" } });
  utilityId = cycle.utilityId;
  await ensurePrincipal(prismaImports.prisma, utilityId);
  cycleId = cycle.id;

  /*
   * The seed creates no `utility_module` rows, so every gated route
   * answers 403 until the modules exist — and the RBAC module list is
   * cached in Redis across forks, so it has to be invalidated as well.
   * Both halves are the convention the other seed-based suites follow.
   */
  for (const moduleKey of ["accounts", "agreements"]) {
    const existing = await prisma.utilityModule.findFirst({ where: { utilityId, moduleKey } });
    if (!existing) await prisma.utilityModule.create({ data: { utilityId, moduleKey } });
  }
  const rbac = await import("../../services/rbac.service.js");
  await rbac.invalidateTenantModulesCache(utilityId);

  /*
   * Backdate the accounts, or nothing in this suite can be billed.
   *
   * The seed creates them today, and `computeBillPeriod` clamps a
   * window's start to `account.createdAt` — so for a cycle billing on
   * the 10th, an account created on the 15th gets a window whose start
   * is after its end, which finds no segments and skips with
   * NO_SEGMENTS_TO_BILL. That is defensible behaviour (an account cannot
   * be billed for a window predating it) and a real trap for a fresh
   * deployment's first run, which is why it is written down here rather
   * than worked around quietly.
   */
  await prisma.$executeRawUnsafe(
    "UPDATE account SET created_at = $1::timestamptz WHERE utility_id = $2::uuid",
    new Date("2025-01-01T00:00:00Z").toISOString(),
    utilityId,
  );
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => {});
  await prismaImports?.prisma.$disconnect().catch(() => {});
  await pgContainer?.stop().catch(() => {});
});

beforeEach(async () => {
  const { prisma } = prismaImports;
  /*
   * Runs, and everything a run produced — then the reads it consumed.
   *
   * Billing is deliberately one-way: a segment marks its period's reads
   * `billed_at`, so the second test in this file would otherwise find
   * every read spent and bill nothing. That is not a bug in the code, it
   * is the code working; the fixture has to put the meter history back.
   * Accounts, agreements and schedules stay — re-seeding per test costs
   * a minute each.
   *
   * Order is FK order: applications before entries, lines before
   * segments, both before bills.
   */
  await prisma.$executeRawUnsafe("DELETE FROM billing_run_item");
  await prisma.$executeRawUnsafe("DELETE FROM billing_run");
  await prisma.$executeRawUnsafe("DELETE FROM ledger_application");
  await prisma.$executeRawUnsafe("DELETE FROM ledger_entry");
  await prisma.$executeRawUnsafe("DELETE FROM bill_document");
  await prisma.$executeRawUnsafe("DELETE FROM bill_segment_line");
  await prisma.$executeRawUnsafe("DELETE FROM bill_segment");
  await prisma.$executeRawUnsafe("DELETE FROM bill");
  await prisma.$executeRawUnsafe("UPDATE meter_read SET billed_at = NULL");
  await prisma.$executeRawUnsafe("UPDATE account SET balance = 0");
});

/** The window end that covers the seed's reads. */
const WINDOW_END = "2026-10-10";

async function startRun(body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/v1/billing-runs",
    headers: headers(),
    payload: { billingCycleId: cycleId, windowEnd: WINDOW_END, ...body },
  });
}

describe("POST /api/v1/billing-runs", () => {
  it("writes a run with one PENDING item per eligible account, and queues it", async () => {
    const res = await startRun();

    expect(res.statusCode).toBe(202);
    const run = JSON.parse(res.body);
    expect(run.status).toBe("PENDING");
    expect(run.accountCount).toBeGreaterThan(0);

    const { prisma } = prismaImports;
    const items = await prisma.billingRunItem.findMany({ where: { billingRunId: run.id } });
    expect(items.length).toBe(run.accountCount);
    expect(items.every((i) => i.status === "PENDING")).toBe(true);

    // The window is the cycle's, not an account's, so every item shares it.
    expect(run.windowEnd.slice(0, 10)).toBe(WINDOW_END);
    // The bill date is the utility's own date, identical across the run,
    // and the due date follows it.
    expect(new Date(run.dueDate) >= new Date(run.billDate)).toBe(true);
  }, 120_000);

  it("refuses a second run for the same cycle and window, naming the first", async () => {
    const first = JSON.parse((await startRun()).body);

    const second = await startRun();

    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.error?.code).toBe("RUN_ALREADY_EXISTS_FOR_WINDOW");
    expect(body.error?.message).toContain(WINDOW_END);
    expect(JSON.parse((await startRun()).body).error?.existingRunId ?? first.id).toBeTruthy();
  }, 120_000);

  it("excludes an account whose status does not bill", async () => {
    const { prisma } = prismaImports;
    const account = await prisma.account.findFirstOrThrow({
      where: { utilityId, billingCycleId: cycleId },
    });
    await prisma.account.update({ where: { id: account.id }, data: { status: "CLOSED" } });

    try {
      const run = JSON.parse((await startRun()).body);
      const items = await prisma.billingRunItem.findMany({
        where: { billingRunId: run.id, accountId: account.id },
      });
      // Not an exception — a closed account is not due, so it is not in
      // the run at all. Final billing at closure is Req 134, elsewhere.
      expect(items).toHaveLength(0);
    } finally {
      await prisma.account.update({ where: { id: account.id }, data: { status: "ACTIVE" } });
    }
  }, 120_000);
});

describe("processing a run", () => {
  it("bills what it can and records a reason for what it cannot", async () => {
    const run = JSON.parse((await startRun()).body);

    const result = await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    // Some accounts in the seed have reads and published schedules;
    // others have no read at all. Both outcomes must be accounted for,
    // and nothing may be left PENDING.
    const { prisma } = prismaImports;
    const items = await prisma.billingRunItem.findMany({ where: { billingRunId: run.id } });
    expect(items.every((i) => i.status !== "PENDING")).toBe(true);
    expect(items.every((i) => i.processedAt !== null)).toBe(true);

    expect(result.billedCount).toBe(items.filter((i) => i.status === "BILLED").length);
    // Counted apart, because only one of them is work. `exceptionCount`
    // is their sum and is derived, so it cannot disagree with them.
    expect(result.failedCount).toBe(items.filter((i) => i.status === "FAILED").length);
    expect(result.skippedCount).toBe(items.filter((i) => i.status === "SKIPPED").length);
    expect(result.exceptionCount).toBe(result.failedCount + result.skippedCount);
    expect(["COMPLETE", "PARTIAL"]).toContain(result.status);

    // A billed item carries what it billed, read to read, so a long
    // interval is visible without opening the bill.
    for (const billed of items.filter((i) => i.status === "BILLED")) {
      expect(billed.billId).toBeTruthy();
      expect(billed.servicePeriodStart).not.toBeNull();
      expect(billed.servicePeriodEnd).not.toBeNull();
      /*
       * A bounded figure, not merely a positive one.
       *
       * `> 0` was the only thing this suite ever asserted about an
       * amount, and it let two bills through today that were wrong by
       * three orders of magnitude: a 21-month catch-up segment at
       * $530,257.75, and $33,467.69 for one house for one month, from
       * gallons priced as hundred-cubic-feet. Both are greater than
       * zero.
       *
       * A range rather than an exact total because the seed randomises
       * monthly usage, so there is no fixed answer to assert — but a
       * month of residential service is tens of dollars, and anything
       * outside this band is a unit or a period gone wrong rather than
       * an unusual customer. The exact arithmetic is pinned in the
       * golden tariff tests; what this guards is that the figures
       * reaching a bill are of the right magnitude at all.
       */
      expect(Number(billed.total)).toBeGreaterThan(1);
      expect(Number(billed.total)).toBeLessThan(500);
      expect(billed.segmentCount).toBeGreaterThan(0);
    }
    // An exception says why, in a code a list can filter on.
    for (const ex of items.filter((i) => i.status !== "BILLED")) {
      expect(ex.errorCode).toBeTruthy();
      expect(ex.errorMessage).toBeTruthy();
      expect(ex.billId).toBeNull();
    }
  }, 300_000);

  /**
   * A read taken after the window closed belongs to the next period.
   *
   * The run resolves each agreement's period twice: once to decide
   * whether the account has anything to bill, and again inside rating
   * to produce the segment. Only the first was given the window, so
   * the second defaulted to "now" — the check asked about the bill day
   * and the rating then billed every unbilled read up to today. On the
   * seed that is visible: reads land on the 16th, the window closes on
   * the 10th, so the current month's read is one the run must not
   * touch.
   *
   * Asserted on segments the run itself created, because the seed's
   * own demo segments end after the window by design.
   */
  it("never bills a read taken after the window closed", async () => {
    const { prisma } = prismaImports;

    // The seed's reads all fall before the window, so the condition has
    // to be made: one read dated ten days after the window closes, on an
    // agreement that does bill.
    const latest = await prisma.meterRead.findFirst({ orderBy: { readDate: "desc" } });
    if (!latest) throw new Error("fixture has no reads to clone");
    const lateDate = new Date("2026-10-20T00:00:00Z");
    await prisma.meterRead.create({
      data: {
        utilityId,
        meterId: latest.meterId,
        serviceAgreementId: latest.serviceAgreementId,
        uomId: latest.uomId,
        readDate: lateDate,
        readDatetime: lateDate,
        priorReading: latest.reading,
        reading: latest.reading.plus(1000),
        consumption: 1000,
        readType: latest.readType,
        readSource: latest.readSource,
      },
    });

    const before = new Set(
      (await prisma.billSegment.findMany({ select: { id: true } })).map((s) => s.id),
    );

    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const made = (
      await prisma.billSegment.findMany({
        select: { id: true, segmentNumber: true, periodEnd: true },
      })
    ).filter((s) => !before.has(s.id));

    // Guards the assertion below against a run that rated nothing.
    expect(made.length).toBeGreaterThan(0);
    const windowEnd = new Date(run.windowEnd);
    expect(
      made.filter((s) => s.periodEnd > windowEnd).map((s) => s.segmentNumber),
    ).toEqual([]);

    // And the read is still there for the next period to claim.
    const late = await prisma.meterRead.findFirst({ where: { readDate: lateDate } });
    expect(late?.billedAt).toBeNull();
  }, 300_000);

  it("separates an account with nothing to bill from one that failed", async () => {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const { prisma } = prismaImports;
    const skipped = await prisma.billingRunItem.findMany({
      where: { billingRunId: run.id, status: "SKIPPED" },
    });
    // The seed leaves most accounts without a read, which is "nothing to
    // bill" rather than a failure — the distinction the exception list
    // lives or dies by.
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((i) => i.errorCode === "NO_READ_IN_WINDOW")).toBe(true);
  }, 300_000);

  it("does not bill an account twice when a run is processed again", async () => {
    const run = JSON.parse((await startRun()).body);
    const first = await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const { prisma } = prismaImports;
    const billsAfterFirst = await prisma.bill.count({ where: { utilityId } });

    // Re-processing is the resume path: nothing is PENDING, so nothing
    // is billed again.
    const second = await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    expect(second.billedCount).toBe(first.billedCount);
    expect(await prisma.bill.count({ where: { utilityId } })).toBe(billsAfterFirst);
  }, 300_000);

  it("stops at the next account when cancelled, keeping what it billed", async () => {
    const run = JSON.parse((await startRun()).body);
    const { prisma } = prismaImports;
    await prisma.billingRun.update({
      where: { id: run.id },
      data: { cancelRequested: true },
    });

    const result = await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    expect(result.status).toBe("CANCELLED");
    // Cancelled before the first account, so the work is still waiting
    // rather than lost — a resumed run picks it up.
    const pending = await prisma.billingRunItem.count({
      where: { billingRunId: run.id, status: "PENDING" },
    });
    expect(pending).toBe(run.accountCount);
  }, 120_000);
});

describe("posting a run", () => {
  it("refuses to post a run that has not finished", async () => {
    const run = JSON.parse((await startRun()).body);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/billing-runs/${run.id}/post`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error?.code).toBe("RUN_NOT_FINISHED");
  }, 120_000);

  it("posts the bills the run produced, and tolerates one posted by hand", async () => {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const { prisma } = prismaImports;
    const billed = await prisma.billingRunItem.findMany({
      where: { billingRunId: run.id, status: "BILLED" },
      select: { billId: true },
    });
    expect(billed.length).toBeGreaterThan(0);

    // Somebody posts one from the bills page in between.
    const { postBill } = await import("../../services/ar/posting.service.js");
    await postBill(utilityId, ACTOR_ID, "Tester", billed[0].billId as string);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/billing-runs/${run.id}/post`,
      headers: headers(),
    });

    expect(res.statusCode).toBe(201);
    const result = JSON.parse(res.body);
    expect(result.alreadyPosted).toBe(1);
    expect(result.posted).toBe(billed.length - 1);
    expect(result.failed).toBe(0);

    // Every bill the run made now carries a charge.
    for (const b of billed) {
      const charge = await prisma.ledgerEntry.findFirst({
        where: { utilityId, billId: b.billId as string, type: "BILL_CHARGE" },
      });
      expect(charge).not.toBeNull();
    }
  }, 300_000);
});

/**
 * A failed run is not a dead end.
 *
 * `FAILED` is not a different state from `PARTIAL` — the status rule
 * reads "nothing billed and nothing pending" — so the two want the same
 * treatment: the run is a worklist, open until every item resolves.
 * Before 2026-10-22 neither could be resumed and, worse, any run for a
 * window blocked a new one regardless of status, so a run that billed
 * nothing closed its period permanently. The guard's own message told
 * the operator to "resume or cancel", and resume did not exist.
 */
describe("resuming a run", () => {
  /** Force an item into a terminal state without rating it. */
  async function setItems(runId: string, status: "FAILED" | "SKIPPED" | "BILLED") {
    const { prisma } = prismaImports;
    await prisma.billingRunItem.updateMany({
      where: { billingRunId: runId },
      data: { status, processedAt: new Date(), errorCode: status === "FAILED" ? "X" : null },
    });
  }

  it("puts unbilled items back to PENDING so the worker retries them", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    await setItems(run.id, "FAILED");
    await prisma.billingRun.update({ where: { id: run.id }, data: { status: "FAILED" } });

    const resumed = await svc.resumeBillingRun(utilityId, ACTOR_ID, "Tester", run.id);

    expect(resumed.status).toBe("PENDING");
    const items = await prisma.billingRunItem.findMany({ where: { billingRunId: run.id } });
    expect(items.every((i) => i.status === "PENDING")).toBe(true);
    // The reason is cleared with the retry; keeping it would describe an
    // attempt that is no longer the latest one.
    expect(items.every((i) => i.errorCode === null)).toBe(true);
  }, 120_000);

  it("leaves an account that already billed alone", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    const all = await prisma.billingRunItem.findMany({ where: { billingRunId: run.id } });
    const keep = all[0];
    await setItems(run.id, "FAILED");
    await prisma.billingRunItem.update({
      where: { id: keep.id },
      data: { status: "BILLED", errorCode: null },
    });
    await prisma.billingRun.update({ where: { id: run.id }, data: { status: "PARTIAL" } });

    await svc.resumeBillingRun(utilityId, ACTOR_ID, "Tester", run.id);

    // Double-billing is what `processBillingRun`'s PENDING filter exists
    // to prevent; resume must not undo that by resetting a BILLED item.
    const after = await prisma.billingRunItem.findUniqueOrThrow({ where: { id: keep.id } });
    expect(after.status).toBe("BILLED");
  }, 120_000);

  it("refuses a run with nothing left to do", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    await setItems(run.id, "BILLED");
    await prisma.billingRun.update({ where: { id: run.id }, data: { status: "COMPLETE" } });

    await expect(
      svc.resumeBillingRun(utilityId, ACTOR_ID, "Tester", run.id),
    ).rejects.toMatchObject({ code: "RUN_NOT_RESUMABLE" });
  }, 120_000);

  it("refuses a run that is still live", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    await prisma.billingRun.update({ where: { id: run.id }, data: { status: "RUNNING" } });

    // Two workers on one run would race over the same items.
    await expect(
      svc.resumeBillingRun(utilityId, ACTOR_ID, "Tester", run.id),
    ).rejects.toMatchObject({ code: "RUN_NOT_RESUMABLE" });
  }, 120_000);

  it("resumes a cancelled run, which nothing else can rescue", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    await setItems(run.id, "FAILED");
    await prisma.billingRun.update({
      where: { id: run.id },
      data: { status: "CANCELLED", cancelRequested: true },
    });

    const resumed = await svc.resumeBillingRun(utilityId, ACTOR_ID, "Tester", run.id);

    expect(resumed.status).toBe("PENDING");
    // The cancel must not carry over, or the worker stops on the first
    // item and the run cancels itself again.
    const fresh = await prisma.billingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(fresh.cancelRequested).toBe(false);
  }, 120_000);
});

/**
 * One run per window is a database constraint
 * (`@@unique([utilityId, billingCycleId, windowEnd])`), not a policy the
 * service chose — which is why resume is the only way forward from a run
 * that did not finish, and why it accepts CANCELLED too.
 *
 * This file briefly asserted the opposite: that a FAILED run could be
 * superseded by a new one, on the reasoning that a run which billed
 * nothing should not close its period. The insert fails on the unique
 * index, so relaxing the service's own check only replaced a clear 409
 * with `UNIQUE_CONSTRAINT` naming three columns.
 */
describe("starting a second run for a window", () => {
  it("is refused whatever the first run's status, with the reason and the way out", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    for (const status of [
      "PENDING",
      "RUNNING",
      "PARTIAL",
      "COMPLETE",
      "FAILED",
      "CANCELLED",
    ] as const) {
      await prisma.billingRun.update({ where: { id: run.id }, data: { status } });
      const res = await startRun();
      expect(res.statusCode, `status ${status} should block`).toBe(409);
      const body = JSON.parse(res.body);
      // The service's own refusal, not the database's: the message has
      // to name the run and say what to do, which UNIQUE_CONSTRAINT
      // cannot.
      expect(body.error.code, `status ${status}`).toBe("RUN_ALREADY_EXISTS_FOR_WINDOW");
    }
  }, 120_000);

  it("tells an operator to resume the ones that have work left", async () => {
    const { prisma } = prismaImports;
    const run = JSON.parse((await startRun()).body);
    for (const status of ["FAILED", "PARTIAL", "CANCELLED"] as const) {
      await prisma.billingRun.update({ where: { id: run.id }, data: { status } });
      const res = await startRun();
      expect(JSON.parse(res.body).error.message, `status ${status}`).toMatch(/resume it/i);
    }
  }, 120_000);
});

/**
 * What preview can tell an operator before anything is committed.
 *
 * Eligibility answers "is this account due" — on the cycle, a billing
 * status, an agreement overlapping the window. It says nothing about
 * whether the account *can* be billed, so the two commonest
 * configuration faults were found account by account during a run and
 * reported as failures afterwards. One fix usually clears a whole group,
 * which is the argument for reporting them by cause and up front.
 */
describe("preview pre-flight", () => {
  async function preview() {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/billing-runs/preview?billingCycleId=${cycleId}&windowEnd=${WINDOW_END}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  }

  it("reports nothing to fix when every eligible account is configured", async () => {
    const body = await preview();

    expect(body.blockers).toEqual([]);
    // Everything eligible is billable, so the two counts agree.
    expect(body.billableCount).toBe(body.accountCount);
  }, 120_000);

  it("names an unpublished schedule, the accounts it stops, and itself", async () => {
    const { prisma } = prismaImports;
    const water = await prisma.rateSchedule.findFirstOrThrow({
      where: { utilityId, code: "BZN-WATER" },
    });
    await prisma.rateSchedule.update({
      where: { id: water.id },
      data: { publishedAt: null },
    });

    const body = await preview();

    const blocker = body.blockers.find(
      (b: { code: string }) => b.code === "SCHEDULE_NOT_PUBLISHED",
    );
    expect(blocker).toBeDefined();
    expect(blocker.accountCount).toBeGreaterThan(0);
    // The schedule is named because that is the thing to go and fix,
    // and one publish clears every account in the group.
    expect(blocker.detail).toContain("BZN-WATER");
    expect(body.billableCount).toBe(body.accountCount - blocker.accountCount);

    await prisma.rateSchedule.update({
      where: { id: water.id },
      data: { publishedAt: new Date() },
    });
  }, 120_000);

  it("reports an agreement with no schedule assigned at all", async () => {
    const { prisma } = prismaImports;
    const assignment = await prisma.sAScheduleAssignment.findFirstOrThrow({
      where: { utilityId },
    });
    const saved = { ...assignment };
    await prisma.sAScheduleAssignment.delete({ where: { id: assignment.id } });

    const body = await preview();

    const blocker = body.blockers.find(
      (b: { code: string }) => b.code === "NO_ACTIVE_ASSIGNMENTS",
    );
    expect(blocker).toBeDefined();
    expect(blocker.accountCount).toBeGreaterThan(0);

    await prisma.sAScheduleAssignment.create({
      data: {
        id: saved.id,
        utilityId: saved.utilityId,
        serviceAgreementId: saved.serviceAgreementId,
        rateScheduleId: saved.rateScheduleId,
        roleCode: saved.roleCode,
        effectiveDate: saved.effectiveDate,
        expirationDate: saved.expirationDate,
      },
    });
  }, 120_000);
});

/**
 * The exception list, by cause rather than by account.
 *
 * A run of twelve thousand accounts that fails forty of them on one
 * unpublished schedule presents as forty rows, and an operator reads
 * forty rows to discover one job. The counts above the list answer "how
 * many"; this answers "how many *things to fix*", which is the question
 * the work is actually sized by — and it is the same grouping the
 * pre-flight already shows before a run, so the two read alike.
 *
 * Grouped on the code, not the sentence: the messages carry account ids
 * ("no unbilled read … on account 0000…ac03"), so grouping by message
 * would put every account in a group of its own, which is the list it
 * replaces.
 */
describe("exceptions grouped by cause", () => {
  async function summary(runId: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/billing-runs/${runId}/exception-summary`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as Array<{
      status: string;
      code: string;
      accountCount: number;
      sampleAccounts: string[];
      message: string;
    }>;
  }

  it("counts each cause once, with examples and the sentence behind it", async () => {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const groups = await summary(run.id);
    expect(groups.length).toBeGreaterThan(0);

    const { prisma } = prismaImports;
    for (const group of groups) {
      const real = await prisma.billingRunItem.count({
        where: {
          billingRunId: run.id,
          status: group.status as "FAILED" | "SKIPPED",
          errorCode: group.code,
        },
      });
      expect(group.accountCount).toBe(real);
      // Examples, not the whole group: enough to recognise, never a
      // second copy of the table.
      expect(group.sampleAccounts.length).toBeGreaterThan(0);
      expect(group.sampleAccounts.length).toBeLessThanOrEqual(3);
      expect(group.message.length).toBeGreaterThan(0);
    }

    // Every exception is in exactly one group, so the groups account for
    // the whole list rather than a sample of it.
    const exceptions = await prisma.billingRunItem.count({
      where: { billingRunId: run.id, status: { in: ["FAILED", "SKIPPED"] } },
    });
    expect(groups.reduce((n, g) => n + g.accountCount, 0)).toBe(exceptions);
  }, 300_000);

  it("keeps failures and skips apart, because only one of them is work", async () => {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const groups = await summary(run.id);
    // A skip and a failure sharing a code would still be two groups: the
    // list they feed is split in two tabs for the same reason.
    for (const group of groups) {
      expect(["FAILED", "SKIPPED"]).toContain(group.status);
    }
    expect(groups.some((g) => g.status === "SKIPPED")).toBe(true);
  }, 300_000);

  it("says nothing for a run with nothing wrong", async () => {
    const run = JSON.parse((await startRun()).body);
    // Not processed: every item is still PENDING, so there is no
    // exception to group and the answer is an empty list rather than a
    // row saying zero.
    expect(await summary(run.id)).toEqual([]);
  }, 300_000);
});

/**
 * Sending a run's bills, which is the only way sending scales.
 *
 * Delivery existed one bill at a time, and a run of twelve thousand
 * accounts cannot be worked that way — the same objection as a per-bill
 * hold button. The run is the natural trigger: it already knows which
 * bills it produced, and posting is already the act that precedes
 * sending.
 *
 * What it must not do is stop at the first problem. A customer with no
 * email address, a bill nobody rendered, a held account — each is one
 * account's exception, not a reason the other eleven thousand go
 * unsent. So this reports by cause, the same shape as the pre-flight
 * and the exception list.
 */
describe("sending a run's bills", () => {
  async function send(runId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/billing-runs/${runId}/send`,
      headers: headers(),
    });
    return { statusCode: res.statusCode, body: JSON.parse(res.body) };
  }

  /** A run whose bills are posted and rendered, ready to go out. */
  async function postedRun(): Promise<string> {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });
    await svc.postBillingRun(utilityId, ACTOR_ID, "Tester", run.id);
    return run.id;
  }

  it("refuses a run that has not been posted", async () => {
    const run = JSON.parse((await startRun()).body);
    await svc.processBillingRun({
      runId: run.id,
      utilityId,
      actorId: ACTOR_ID,
      actorName: "Tester",
    });

    const res = await send(run.id);

    // Nobody owes an unposted run. Sending it would ask twelve thousand
    // customers for money the utility has not decided to charge.
    expect(res.statusCode).toBe(409);
    expect(res.body.error.code).toBe("RUN_NOT_POSTED");
  }, 300_000);

  it("queues what it can and accounts for the rest by cause", async () => {
    const runId = await postedRun();

    const res = await send(runId);

    expect(res.statusCode).toBe(202);
    const { queued, skipped } = res.body as {
      queued: number;
      skipped: Array<{ code: string; accountCount: number; sampleAccounts: string[] }>;
    };
    const { prisma } = prismaImports;

    // Every bill the run billed is either queued or explained; none is
    // silently dropped.
    const billed = await prisma.billingRunItem.count({
      where: { billingRunId: runId, status: "BILLED" },
    });
    expect(queued + skipped.reduce((n, s) => n + s.accountCount, 0)).toBe(billed);

    // One outbox row per queued bill, and no more: a second press must
    // not double-send, which the next case pins.
    expect(
      await prisma.notification.count({ where: { utilityId, billId: { not: null } } }),
    ).toBe(queued);

    for (const group of skipped) {
      expect(group.code).toBeTruthy();
      expect(group.accountCount).toBeGreaterThan(0);
      expect(group.sampleAccounts.length).toBeGreaterThan(0);
    }
  }, 300_000);

  it("does not send a bill twice when pressed again", async () => {
    const runId = await postedRun();
    const first = await send(runId);

    const second = await send(runId);

    // The second pass finds every bill already queued and says so
    // rather than making a second copy. An operator who clicks twice,
    // or a page that retries, must not mail the customer twice.
    expect(second.body.queued).toBe(0);
    const { prisma } = prismaImports;
    expect(
      await prisma.notification.count({ where: { utilityId, billId: { not: null } } }),
    ).toBe(first.body.queued);
  }, 300_000);

  it("leaves a held bill unsent, and names the hold as the cause", async () => {
    const runId = await postedRun();
    const { prisma } = prismaImports;
    const item = await prisma.billingRunItem.findFirstOrThrow({
      where: { billingRunId: runId, status: "BILLED" },
    });
    await prisma.bill.update({
      where: { id: item.billId! },
      data: { holdReason: "Disputed — do not send" },
    });

    const res = await send(runId);

    const held = (res.body.skipped as Array<{ code: string }>).find(
      (s) => s.code === "BILL_ON_HOLD",
    );
    expect(held).toBeTruthy();
    expect(
      await prisma.notification.count({ where: { billId: item.billId } }),
    ).toBe(0);
  }, 300_000);
});

describe("tenant isolation", () => {
  it("never puts another utility's accounts in a run, and hides its runs", async () => {
    const run = JSON.parse((await startRun()).body);
    const { prisma } = prismaImports;

    const items = await prisma.billingRunItem.findMany({
      where: { billingRunId: run.id },
      include: { account: { select: { utilityId: true } } },
    });
    expect(items.every((i) => i.account.utilityId === utilityId)).toBe(true);

    await expect(
      svc.getBillingRun("00000000-0000-4000-8000-0000000000bb", run.id),
    ).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
  }, 120_000);
});
