import { vi } from "vitest";

// Mock ioredis so RBAC cache has no real connection. Individual tests can
// re-mock redis if they need to assert specific cache behavior.
vi.mock("../lib/cache-redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
    // The real client's connection state, which /health reports and the
    // cache helpers consult before calling. A mock without it reports
    // `undefined`, which JSON drops — so the endpoint would look correct
    // in tests while saying nothing.
    status: "ready",
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// Mock the prisma module before any tests run.
// IMPORTANT: this must include every model the middleware layer touches
// (utilityModule, cisUser, role) so authorization middleware can run to
// completion and request validation tests can reach the Zod parser.
vi.mock("../lib/prisma.js", () => {
  const crud = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findFirstOrThrow: vi.fn().mockRejectedValue(new Error("Not found")),
    findUnique: vi.fn().mockResolvedValue(null),
    findUniqueOrThrow: vi.fn().mockRejectedValue(new Error("Not found")),
    create: vi.fn().mockResolvedValue({}),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    count: vi.fn().mockResolvedValue(0),
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    // Hands the mocked client itself to the callback, so a service
    // writing through `prisma.$transaction(tx => tx.model...)` — which
    // every audit-wrapped service does — reaches the same model mocks
    // the test configured. Passing `{}` made any audited create or
    // update throw inside the transaction and surface as a 500, which
    // reads as a route bug rather than a missing mock.
    $transaction: vi.fn((fn: any) =>
      typeof fn === "function" ? fn(client) : Promise.resolve([])
    ),
    commodity: crud(),
    unitOfMeasure: crud(),
    uom: crud(),
    premise: crud(),
    meter: crud(),
    meterRegister: crud(),
    meterRead: crud(),
    account: crud(),
    customer: crud(),
    contact: crud(),
    billingAddress: crud(),
    bill: crud(),
    billSegment: crud(),
    billSegmentLine: crud(),
    billMessage: crud(),
    billDocument: crud(),
    // The bill's presentation reads these to print what has been paid
    // against it. Absent, every presentation test failed on
    // `ledgerEntry.findFirst` of undefined rather than on anything it
    // was testing.
    ledgerEntry: crud(),
    ledgerApplication: crud(),
    serviceAgreement: crud(),
    servicePoint: crud(),
    servicePointMeter: crud(),
    rateSchedule: crud(),
    billingCycle: crud(),
    attachment: crud(),
    auditLog: crud(),
    utilityTheme: crud(),
    userPreference: crud(),
    // The tenant itself. Added 2026-10-18 with the Utility entity;
    // omitting it made `prisma.utility` undefined for every unit test,
    // which surfaces as "Cannot read properties of undefined" rather
    // than as a missing mock.
    utility: crud(),
    utilityModule: crud(),
    utilityConfig: crud(),
    customFieldSchema: crud(),
    notificationTemplate: crud(),
    notification: crud(),
    delinquencyRule: crud(),
    delinquencyAction: crud(),
    serviceSuspension: crud(),
    suspensionTypeDef: crud(),
    meterEvent: crud(),
    container: crud(),
    serviceEvent: crud(),
    importBatch: crud(),
    // The two records a queue payload names (`runId`, `batchId`), which
    // the platform job list checks still exist before calling a parked
    // job merely "waiting".
    billingRun: crud(),
    role: crud(),
    cisUser: crud(),
    cisRole: crud(),
    userRole: crud(),
    premiseTypeDef: crud(),
    accountTypeDef: crud(),
    inAppNotification: crud(),
    importRow: crud(),
    serviceRequestTypeDef: crud(),
    sla: crud(),
    serviceRequest: crud(),
    serviceRequestCounter: crud(),
  };

  return {
    prisma: client,
    withTenant: vi.fn((_utilityId: string, fn: any) => fn({})),
  };
});
