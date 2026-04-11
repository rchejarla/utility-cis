import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listSuspensionTypes,
  assertSuspensionTypeCode,
} from "../../services/suspension-type-def.service.js";
import { prisma } from "../../lib/prisma.js";

// Global prisma mock lives in vitest.setup.ts. Each test re-stubs the
// specific methods it exercises so behavior is explicit per-case.

const UID_A = "00000000-0000-4000-8000-00000000000a";

type FakeRow = {
  id: string;
  utilityId: string | null;
  code: string;
  label: string;
  description: string | null;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
  defaultBillingSuspended: boolean;
};

function row(partial: Partial<FakeRow>): FakeRow {
  return {
    id: partial.id ?? "id-" + (partial.code ?? "x"),
    utilityId: partial.utilityId ?? null,
    code: partial.code ?? "CODE",
    label: partial.label ?? "Label",
    description: partial.description ?? null,
    category: partial.category ?? null,
    sortOrder: partial.sortOrder ?? 100,
    isActive: partial.isActive ?? true,
    defaultBillingSuspended: partial.defaultBillingSuspended ?? true,
  };
}

describe("suspension-type-def service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listSuspensionTypes", () => {
    it("returns global rows when the tenant has no overrides", async () => {
      (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row({ code: "VACATION_HOLD", label: "Vacation hold", sortOrder: 10 }),
        row({ code: "SEASONAL", label: "Seasonal", sortOrder: 20 }),
      ]);

      const result = await listSuspensionTypes(UID_A);

      expect(result).toHaveLength(2);
      expect(result[0].code).toBe("VACATION_HOLD");
      expect(result[0].isGlobal).toBe(true);
      expect(result[1].code).toBe("SEASONAL");
    });

    it("sorts by sortOrder then code", async () => {
      (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row({ code: "LATE", sortOrder: 100 }),
        row({ code: "FIRST", sortOrder: 10 }),
        row({ code: "MIDDLE_B", sortOrder: 50 }),
        row({ code: "MIDDLE_A", sortOrder: 50 }),
      ]);

      const result = await listSuspensionTypes(UID_A);

      expect(result.map((r) => r.code)).toEqual([
        "FIRST",
        "MIDDLE_A",
        "MIDDLE_B",
        "LATE",
      ]);
    });

    it("tenant-specific row shadows a global row with the same code", async () => {
      // Both a global and a tenant-scoped row for the same code. The
      // tenant row carries a different label; the shadow-resolution
      // logic should keep the tenant row.
      (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row({ id: "global", utilityId: null, code: "DISPUTE", label: "Dispute (stock)" }),
        row({ id: "tenant", utilityId: UID_A, code: "DISPUTE", label: "Dispute — Acme flavor" }),
      ]);

      const result = await listSuspensionTypes(UID_A);

      expect(result).toHaveLength(1);
      expect(result[0].label).toBe("Dispute — Acme flavor");
      expect(result[0].isGlobal).toBe(false);
    });

    it("includes inactive rows only when includeInactive is true", async () => {
      // The service adds isActive=true to the where clause by default,
      // so the mock here has no inactive rows mixed in — we only verify
      // the where-clause shape gets set correctly for the two paths.
      (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await listSuspensionTypes(UID_A);
      let call = (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.where.isActive).toBe(true);

      (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mockClear();
      await listSuspensionTypes(UID_A, { includeInactive: true });
      call = (prisma.suspensionTypeDef.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.where.isActive).toBeUndefined();
    });
  });

  describe("assertSuspensionTypeCode", () => {
    it("resolves when a matching active code exists", async () => {
      (prisma.suspensionTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "found",
      });

      await expect(
        assertSuspensionTypeCode(UID_A, "VACATION_HOLD"),
      ).resolves.toBeUndefined();
    });

    it("throws 400 SUSPENSION_TYPE_UNKNOWN when no row matches", async () => {
      (prisma.suspensionTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        assertSuspensionTypeCode(UID_A, "BOGUS"),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "SUSPENSION_TYPE_UNKNOWN",
      });
    });

    it("scopes its lookup to global OR tenant-specific rows", async () => {
      (prisma.suspensionTypeDef.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "x",
      });

      await assertSuspensionTypeCode(UID_A, "VACATION_HOLD");

      const call = (prisma.suspensionTypeDef.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.where.code).toBe("VACATION_HOLD");
      expect(call.where.isActive).toBe(true);
      // The OR clause lets the same code resolve against either a
      // global seed row or a tenant row. Both branches must be present.
      expect(call.where.OR).toContainEqual({ utilityId: null });
      expect(call.where.OR).toContainEqual({ utilityId: UID_A });
    });
  });
});
