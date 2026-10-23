import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { bootPostgres } from "./_effective-dating-fixtures.js";

/**
 * The four ways a service request is read, against a real database.
 *
 * They all share one `include`, and a wrong `include` is not a wrong
 * answer — it is a 400 before the query runs, so every one of them fails
 * together and the whole feature is dark. That is what happened: the
 * shared shape selected `serviceAgreement.premise`, and an agreement has
 * no premise. It reaches one through a **service point**, which is the
 * per-place anchor between an agreement and an address — one agreement
 * can have several, and a closed one is a place it used to be served.
 *
 * Nothing caught it, and the reason is worth keeping:
 *
 *   - `service-requests.test.ts` sits in this directory and reads like
 *     the coverage for this, but it is gated behind
 *     `RUN_REAL_DB_INTEGRATION_TESTS=true` **and** matches neither
 *     vitest config's integration glob, so it runs in the unit suite and
 *     is skipped there. It has never executed.
 *   - `formatAgreementLabel` has three unit tests and all of them pass:
 *     they hand-build `{agreementNumber, commodity, premise}`. The
 *     formatter was never wrong. The query feeding it was, and no test
 *     joined the two.
 *
 * So these run against real Postgres, through the services rather than
 * the routes, because the fault is in the query and nowhere else.
 */

const utilityId = "00000000-0000-4000-8000-0000000000aa";
const otherUtility = "00000000-0000-4000-8000-0000000000bb";

let pgContainer: StartedPostgreSqlContainer;
let prismaImports: typeof import("../../lib/prisma.js");
let srs: typeof import("../../services/service-request.service.js");

let accountId: string;
let premiseId: string;
let agreementId: string;
let requestId: string;

const SERVED_AT = "412 N 7th Ave";

beforeAll(async () => {
  const booted = await bootPostgres({ utilities: [utilityId, otherUtility] });
  pgContainer = booted.container;
  prismaImports = await import("../../lib/prisma.js");
  srs = await import("../../services/service-request.service.js");

  const { prisma } = prismaImports;

  const customer = await prisma.customer.create({
    data: { utilityId, customerType: "INDIVIDUAL", firstName: "Ada", lastName: "Lovelace" },
  });
  const cycle = await prisma.billingCycle.create({
    data: {
      utilityId,
      name: "Residential 1",
      cycleCode: "R01",
      readDayOfMonth: 1,
      billDayOfMonth: 15,
      frequency: "MONTHLY",
    },
  });
  const account = await prisma.account.create({
    data: {
      utilityId,
      accountNumber: "SR-001",
      accountType: "RESIDENTIAL",
      status: "ACTIVE",
      billingCycleId: cycle.id,
      customerId: customer.id,
    },
  });
  accountId = account.id;

  const premise = await prisma.premise.create({
    data: {
      utilityId,
      addressLine1: SERVED_AT,
      city: "Bozeman",
      state: "MT",
      zip: "59715",
      premiseType: "RESIDENTIAL",
    },
  });
  premiseId = premise.id;

  const commodity = await prisma.commodity.create({
    data: { utilityId, code: "WATER", name: "Potable Water" },
  });
  const agreement = await prisma.serviceAgreement.create({
    data: {
      utilityId,
      accountId,
      commodityId: commodity.id,
      agreementNumber: "SA-0421",
      status: "ACTIVE",
      startDate: new Date("2026-01-01"),
    },
  });
  agreementId = agreement.id;

  /*
   * Two service points on one agreement, and only the open one is the
   * place it is served now. A `take: 1` without the `endDate` filter
   * could return either, so the premise on the label would depend on
   * insertion order — this closed point is here to catch that.
   */
  await prisma.servicePoint.create({
    data: {
      utilityId,
      serviceAgreementId: agreementId,
      premiseId: (
        await prisma.premise.create({
          data: {
            utilityId,
            addressLine1: "99 Old Mill Rd",
            city: "Bozeman",
            state: "MT",
            zip: "59715",
            premiseType: "RESIDENTIAL",
          },
        })
      ).id,
      startDate: new Date("2025-01-01"),
      endDate: new Date("2025-12-31"),
    },
  });
  await prisma.servicePoint.create({
    data: {
      utilityId,
      serviceAgreementId: agreementId,
      premiseId,
      startDate: new Date("2026-01-01"),
    },
  });

  const request = await prisma.serviceRequest.create({
    data: {
      utilityId,
      requestNumber: "SR-0001",
      accountId,
      premiseId,
      serviceAgreementId: agreementId,
      requestType: "LEAK",
      priority: "HIGH",
      description: "Water pooling at the kerb",
    },
  });
  requestId = request.id;
}, 240_000);

afterAll(async () => {
  await prismaImports?.prisma.$disconnect();
  await pgContainer?.stop();
});

describe("service request reads", () => {
  it("lists an account's requests", async () => {
    const rows = await srs.listByAccount(utilityId, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestNumber).toBe("SR-0001");
  });

  it("lists a premise's requests", async () => {
    const rows = await srs.listByPremise(utilityId, premiseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestNumber).toBe("SR-0001");
  });

  it("lists the tenant's requests", async () => {
    const { data } = await srs.listServiceRequests(utilityId, {});
    expect(data).toHaveLength(1);
  });

  it("reads one request", async () => {
    const sr = await srs.getServiceRequest(requestId, utilityId);
    expect(sr.requestNumber).toBe("SR-0001");
  });

  /*
   * The address is what the fault actually cost: `formatAgreementLabel`
   * renders "SA-0421 · Potable Water · 412 N 7th Ave", and it drops the
   * third segment silently when `premise` is absent. So asserting the
   * read merely succeeds would pass against an agreement carrying no
   * address at all.
   */
  it("carries the premise the agreement is served at, flattened for the caller", async () => {
    const rows = await srs.listByAccount(utilityId, accountId);
    expect(rows[0]!.serviceAgreement).toMatchObject({
      agreementNumber: "SA-0421",
      commodity: { name: "Potable Water" },
      premise: { addressLine1: SERVED_AT },
    });
  });

  it("gives the same agreement shape on every read path", async () => {
    const byPremise = await srs.listByPremise(utilityId, premiseId);
    const tenantWide = await srs.listServiceRequests(utilityId, {});
    const one = await srs.getServiceRequest(requestId, utilityId);
    for (const sr of [byPremise[0]!, tenantWide.data[0]!, one]) {
      expect(sr.serviceAgreement?.premise).toEqual({ addressLine1: SERVED_AT });
    }
  });

  it("reads no other tenant's requests", async () => {
    expect(await srs.listByAccount(otherUtility, accountId)).toEqual([]);
    await expect(srs.getServiceRequest(requestId, otherUtility)).rejects.toThrow();
  });
});
