import { vi } from "vitest";

// Mock ioredis so RBAC cache has no real connection. Individual tests can
// re-mock redis if they need to assert specific cache behavior.
vi.mock("../lib/cache-redis.js", () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

// Mock the prisma module before any tests run.
// IMPORTANT: this must include every model the middleware layer touches
// (tenantModule, cisUser, role) so authorization middleware can run to
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

  return {
    prisma: {
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockResolvedValue([]),
      $queryRawUnsafe: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn((fn: any) =>
        typeof fn === "function" ? fn({}) : Promise.resolve([])
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
      serviceAgreement: crud(),
      serviceAgreementMeter: crud(),
      rateSchedule: crud(),
      billingCycle: crud(),
      attachment: crud(),
      auditLog: crud(),
      tenantTheme: crud(),
      utilityTheme: crud(),
      userPreference: crud(),
      tenantModule: crud(),
      tenantConfig: crud(),
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
    },
    setTenantContext: vi.fn().mockResolvedValue(undefined),
    withTenant: vi.fn((_utilityId: string, fn: any) => fn({})),
  };
});
