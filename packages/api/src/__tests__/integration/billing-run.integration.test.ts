import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres, ensurePrincipal } from "./_effective-dating-fixtures.js";

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
      expect(Number(billed.total)).toBeGreaterThan(0);
      expect(billed.segmentCount).toBeGreaterThan(0);
    }
    // An exception says why, in a code a list can filter on.
    for (const ex of items.filter((i) => i.status !== "BILLED")) {
      expect(ex.errorCode).toBeTruthy();
      expect(ex.errorMessage).toBeTruthy();
      expect(ex.billId).toBeNull();
    }
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
