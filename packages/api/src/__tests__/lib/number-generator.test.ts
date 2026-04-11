import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock tenant-config so we can toggle the tenant's numberFormats
// without hitting a real DB. The generator only reads; it never writes.
const getTenantConfigMock = vi.fn();
vi.mock("../../services/tenant-config.service.js", () => ({
  getTenantConfig: (utilityId: string) => getTenantConfigMock(utilityId),
}));

import {
  generateNumber,
  generateAndInsertWithRetry,
} from "../../lib/number-generator.js";

const UID = "00000000-0000-4000-8000-00000000000a";
const APRIL_10_2026 = new Date("2026-04-10T12:00:00Z");

// Helper to build a fake db object with a controllable $queryRawUnsafe.
function fakeDb(rows: Array<{ identifier: string }> = []) {
  const $queryRawUnsafe = vi.fn().mockResolvedValue(rows);
  return {
    db: { $queryRawUnsafe } as unknown as Parameters<typeof generateNumber>[0]["db"],
    queryMock: $queryRawUnsafe,
  };
}

/**
 * Default tenant config — no numberFormats set. Forces the generator
 * to use the caller-supplied defaultTemplate. Tests that want to
 * exercise a configured template override this in-test.
 */
function tenantConfigWithoutFormats() {
  return {
    utilityId: UID,
    requireHoldApproval: false,
    settings: {},
  };
}

function tenantConfigWithFormats(
  numberFormats: Record<string, { template: string; startAt?: number }>,
) {
  return {
    utilityId: UID,
    requireHoldApproval: false,
    settings: { numberFormats },
  };
}

describe("generateNumber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTenantConfigMock.mockResolvedValue(tenantConfigWithoutFormats());
  });

  describe("fresh tenant (no existing rows)", () => {
    it("returns the first number from the default template when nothing is configured", async () => {
      const { db } = fakeDb([]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-0001");
    });

    it("honors the tenant-configured template over the default", async () => {
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "AGR-{YYYY}-{seq:5}", startAt: 1 },
        }),
      );
      const { db } = fakeDb([]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("AGR-2026-00001");
    });

    it("uses the configured startAt when higher than 1", async () => {
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{seq:5}", startAt: 50000 },
        }),
      );
      const { db } = fakeDb([]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-50000");
    });
  });

  describe("existing rows present", () => {
    it("increments the highest matching sequence", async () => {
      const { db } = fakeDb([
        { identifier: "SA-0042" },
        { identifier: "SA-0041" },
        { identifier: "SA-0040" },
      ]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-0043");
    });

    it("returns startAt when every existing row is below startAt", async () => {
      // Tenant migrated from a legacy CIS and bumped startAt past
      // the imported history. Legacy rows must not pull the counter
      // backward.
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{seq:5}", startAt: 50000 },
        }),
      );
      const { db } = fakeDb([{ identifier: "SA-00042" }]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-50000");
    });

    it("uses existing+1 when it exceeds startAt", async () => {
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{seq:5}", startAt: 50000 },
        }),
      );
      const { db } = fakeDb([{ identifier: "SA-60000" }]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-60001");
    });

    it("parses numeric tails correctly even when string-ordering misleads", async () => {
      // Postgres ORDER BY column DESC on a string column returns
      // "SA-9" before "SA-10" because of lexical sort. The generator
      // must parse and compare numerically. The helper takes 50 rows
      // from the DB to give the numeric parse enough candidates.
      const { db } = fakeDb([
        { identifier: "SA-9" },
        { identifier: "SA-8" },
        { identifier: "SA-7" },
        { identifier: "SA-10" }, // the real max
      ]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-11");
    });
  });

  describe("date-token implicit reset", () => {
    it("starts fresh when a new year prefix has no matching rows", async () => {
      // Template contains {YYYY}. Today is April 2026. The DB
      // returns only 2026 rows — no legacy rows leak into the query
      // because the regex is built with the current year baked in.
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{YYYY}-{seq:4}", startAt: 1 },
        }),
      );
      const { db } = fakeDb([]); // fresh year, no matches
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-2026-0001");
    });

    it("builds the max query using a regex anchored to the current year", async () => {
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{YYYY}-{seq:4}", startAt: 1 },
        }),
      );
      const { db, queryMock } = fakeDb([]);
      await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      // Second arg to $queryRawUnsafe is the regex parameter bound
      // to $2 in the SQL. It must contain the literal 2026.
      const [, , regexParam] = queryMock.mock.calls[0];
      expect(regexParam).toBe("^SA-2026-\\d+$");
    });

    it("increments inside the current year when matching rows exist", async () => {
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{YYYY}-{seq:4}", startAt: 1 },
        }),
      );
      const { db } = fakeDb([
        { identifier: "SA-2026-0042" },
        { identifier: "SA-2026-0041" },
      ]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-2026-0043");
    });
  });

  describe("mid-stream format changes", () => {
    it("honors a new padding width even when legacy rows use a different width", async () => {
      // Admin changed {seq:4} → {seq:5} yesterday. The regex
      // buildMatchPattern uses \d+ rather than \d{5}, so legacy 4-digit
      // rows still match and contribute to the max. The new row is
      // formatted with the new width.
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "SA-{seq:5}", startAt: 1 },
        }),
      );
      const { db } = fakeDb([{ identifier: "SA-0042" }]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("SA-00043");
    });

    it("ignores legacy rows that don't match the current prefix", async () => {
      // Admin switched the prefix from SA- to AGR- today. Legacy SA-
      // rows exist but shouldn't be queried — and even if the fake db
      // returns them, the seqExtract regex won't match the AGR- prefix,
      // so they're filtered out at parse time. Simulate by having the
      // fake db return no rows (matching the real Postgres behavior).
      getTenantConfigMock.mockResolvedValue(
        tenantConfigWithFormats({
          agreement: { template: "AGR-{seq:4}", startAt: 1 },
        }),
      );
      const { db, queryMock } = fakeDb([]);
      const result = await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      expect(result).toBe("AGR-0001");
      // The regex bound to the query must target the new prefix.
      const [, , regexParam] = queryMock.mock.calls[0];
      expect(regexParam).toBe("^AGR-\\d+$");
    });
  });

  describe("tenant scoping", () => {
    it("passes the utilityId as the first SQL parameter", async () => {
      const { db, queryMock } = fakeDb([]);
      await generateNumber({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
      });
      const [, utilityParam] = queryMock.mock.calls[0];
      expect(utilityParam).toBe(UID);
    });

    it("uses the caller-supplied table and column names in the SQL", async () => {
      const { db, queryMock } = fakeDb([]);
      await generateNumber({
        utilityId: UID,
        entity: "account",
        defaultTemplate: "AC-{seq:5}",
        tableName: "account",
        columnName: "account_number",
        db,
        now: APRIL_10_2026,
      });
      const [sql] = queryMock.mock.calls[0];
      expect(sql).toContain("FROM account");
      expect(sql).toContain("account_number");
    });
  });
});

describe("generateAndInsertWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTenantConfigMock.mockResolvedValue(tenantConfigWithoutFormats());
  });

  it("returns the createFn result on first attempt when nothing collides", async () => {
    const { db } = fakeDb([]);
    const createFn = vi.fn().mockResolvedValue({ id: "row-1", agreementNumber: "SA-0001" });

    const result = await generateAndInsertWithRetry({
      utilityId: UID,
      entity: "agreement",
      defaultTemplate: "SA-{seq:4}",
      tableName: "service_agreement",
      columnName: "agreement_number",
      db,
      now: APRIL_10_2026,
      createFn,
    });

    expect(result).toEqual({ id: "row-1", agreementNumber: "SA-0001" });
    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn).toHaveBeenCalledWith("SA-0001");
  });

  it("regenerates and retries on P2002 unique-constraint conflicts", async () => {
    // First attempt: DB reports P2002 (simulating a concurrent insert
    // that grabbed the same number). Second attempt: the generator
    // re-queries, gets a newer max, and the createFn succeeds.
    const { db, queryMock } = fakeDb([]);
    // Second call returns an existing row at position 1, so the
    // generator's second attempt picks up SA-0002.
    queryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ identifier: "SA-0001" }]);

    const createFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Unique violation"), { code: "P2002" }))
      .mockResolvedValueOnce({ id: "row-2" });

    const result = await generateAndInsertWithRetry({
      utilityId: UID,
      entity: "agreement",
      defaultTemplate: "SA-{seq:4}",
      tableName: "service_agreement",
      columnName: "agreement_number",
      db,
      now: APRIL_10_2026,
      createFn,
    });

    expect(result).toEqual({ id: "row-2" });
    expect(createFn).toHaveBeenCalledTimes(2);
    expect(createFn.mock.calls[0][0]).toBe("SA-0001");
    expect(createFn.mock.calls[1][0]).toBe("SA-0002");
  });

  it("throws NUMBER_GENERATION_FAILED after exhausting retry attempts", async () => {
    const { db } = fakeDb([]);
    const err = Object.assign(new Error("Unique violation"), { code: "P2002" });
    const createFn = vi.fn().mockRejectedValue(err);

    await expect(
      generateAndInsertWithRetry({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
        createFn,
        maxAttempts: 3,
      }),
    ).rejects.toMatchObject({
      statusCode: 500,
      code: "NUMBER_GENERATION_FAILED",
    });

    expect(createFn).toHaveBeenCalledTimes(3);
  });

  it("immediately rethrows non-P2002 errors without retrying", async () => {
    const { db } = fakeDb([]);
    const fatal = Object.assign(new Error("Something else"), { code: "P1000" });
    const createFn = vi.fn().mockRejectedValue(fatal);

    await expect(
      generateAndInsertWithRetry({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
        createFn,
      }),
    ).rejects.toMatchObject({ code: "P1000" });

    // Non-retryable error short-circuits the retry loop: exactly one
    // createFn call, no further attempts.
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it("respects a custom maxAttempts value", async () => {
    const { db } = fakeDb([]);
    const err = Object.assign(new Error("P2002"), { code: "P2002" });
    const createFn = vi.fn().mockRejectedValue(err);

    await expect(
      generateAndInsertWithRetry({
        utilityId: UID,
        entity: "agreement",
        defaultTemplate: "SA-{seq:4}",
        tableName: "service_agreement",
        columnName: "agreement_number",
        db,
        now: APRIL_10_2026,
        createFn,
        maxAttempts: 5,
      }),
    ).rejects.toMatchObject({ code: "NUMBER_GENERATION_FAILED" });

    expect(createFn).toHaveBeenCalledTimes(5);
  });
});
