import { describe, it, expect, vi, beforeEach } from "vitest";
import { selectBillMessages } from "../../services/bill-message.service.js";
import { prisma } from "../../lib/prisma.js";

/**
 * Targeting is the whole logic of this service: a message with a null
 * accountTypeDefId or commodityId means "all", so each side is an OR of
 * "untargeted" with "targeted at this bill". The window is evaluated at
 * the bill's own billDate — never now() — so reprinting an old bill
 * reproduces the messages it carried.
 *
 * These assert the query shape rather than returned rows, because the
 * filtering happens in Postgres; the integration tests in Task 6 prove
 * the query matches real rows.
 */

const onDate = new Date("2026-03-15T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

function whereOf(call: unknown): Record<string, unknown> {
  return (call as { where: Record<string, unknown> }).where;
}

describe("selectBillMessages", () => {
  it("asks only for messages whose window contains the bill date", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: "at-1", commodityIds: ["c-1"], onDate });

    const where = whereOf(findMany.mock.calls[0][0]);
    expect(where.utilityId).toBe("util-1");
    expect(where.activeFrom).toEqual({ lte: onDate });
    expect(where.OR).toEqual(
      expect.arrayContaining([{ activeTo: null }, { activeTo: { gte: onDate } }]),
    );
  });

  it("includes untargeted messages alongside ones matching this bill", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: "at-1", commodityIds: ["c-1"], onDate });

    expect(whereOf(findMany.mock.calls[0][0]).AND).toEqual([
      { OR: [{ accountTypeDefId: null }, { accountTypeDefId: "at-1" }] },
      { OR: [{ commodityId: null }, { commodityId: { in: ["c-1"] } }] },
    ]);
  });

  it("matches only untargeted messages when the bill has no account type or services", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: null, commodityIds: [], onDate });

    expect(whereOf(findMany.mock.calls[0][0]).AND).toEqual([
      { OR: [{ accountTypeDefId: null }] },
      { OR: [{ commodityId: null }] },
    ]);
  });

  it("orders by priority then label so output is stable", async () => {
    const findMany = vi.mocked(prisma.billMessage.findMany).mockResolvedValue([] as never);

    await selectBillMessages("util-1", { accountTypeDefId: null, commodityIds: [], onDate });

    expect((findMany.mock.calls[0][0] as { orderBy: unknown }).orderBy).toEqual([
      { priority: "asc" },
      { label: "asc" },
    ]);
  });

  it("returns the rows a bill prints, and only those fields", async () => {
    vi.mocked(prisma.billMessage.findMany).mockResolvedValue([
      { id: "m-1", label: "Notice", body: "Water restrictions begin June 1.", priority: 10 },
    ] as never);

    const rows = await selectBillMessages("util-1", {
      accountTypeDefId: null,
      commodityIds: [],
      onDate,
    });

    expect(rows).toEqual([
      { id: "m-1", label: "Notice", body: "Water restrictions begin June 1.", priority: 10 },
    ]);
  });
});
