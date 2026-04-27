import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for the in-transaction audit-wrap. The wrapper runs `op(tx)`
 * and `tx.auditLog.create(...)` inside a single `prisma.$transaction`,
 * closing the atomicity gap the prior EventEmitter pipeline had.
 *
 * Mock approach: stub `prisma.$transaction` so it invokes the run-fn
 * with a controllable `tx` mock. Assert against `tx.auditLog.create`
 * call args directly. No DB, no testcontainers — full path of the
 * wrapper is exercised in process.
 */

// Build the tx + prisma mocks inside vi.hoisted so vi.mock's factory
// can close over them. Top-level variables aren't allowed inside
// vi.mock factories because the call is hoisted above all imports.
const { txMock, prismaMock } = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
  };
  type TxShape = typeof tx;
  const p = {
    $transaction: vi.fn(async (run: (txArg: TxShape) => unknown) => run(tx)),
  };
  return { txMock: tx, prismaMock: p };
});

vi.mock("../lib/prisma.js", () => ({
  prisma: prismaMock,
}));

import { auditCreate, auditUpdate, writeAuditRow } from "../lib/audit-wrap.js";

const ctx = {
  utilityId: "u-1",
  actorId: "a-1",
  actorName: "Alice",
  entityType: "Customer",
};

describe("audit-wrap", () => {
  beforeEach(() => {
    txMock.$executeRaw.mockClear();
    txMock.auditLog.create.mockClear();
    prismaMock.$transaction.mockClear();
  });

  describe("auditCreate", () => {
    it("opens a $transaction, runs op(tx), then writes audit with beforeState=null", async () => {
      const created = { id: "new-1", name: "Acme" };
      const opMock = vi.fn(async () => created);

      const result = await auditCreate(ctx, "customer.created", opMock);

      expect(result).toBe(created);
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
      // op was invoked with the tx (not the global prisma).
      expect(opMock).toHaveBeenCalledWith(txMock);
      // RLS context set transactionally before the audit insert.
      expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
      // Audit row landed with beforeState=null and afterState=entity.
      expect(txMock.auditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = (txMock.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      expect(auditCall.data.action).toBe("CREATE");
      expect(auditCall.data.entityType).toBe("Customer");
      expect(auditCall.data.entityId).toBe("new-1");
      expect(auditCall.data.utilityId).toBe("u-1");
      expect(auditCall.data.actorId).toBe("a-1");
      expect(auditCall.data.actorName).toBe("Alice");
      expect(auditCall.data.afterState).toEqual(created);
      expect(auditCall.data.metadata).toEqual({ eventType: "customer.created" });
    });

    it("uses existingTx when provided — does NOT open a new $transaction", async () => {
      const created = { id: "new-2" };
      const opMock = vi.fn(async () => created);

      // Caller supplies its own tx (e.g., from an outer prisma.$transaction).
      const callerTx = {
        $executeRaw: vi.fn(async () => 0),
        auditLog: { create: vi.fn(async () => ({ id: "audit-2" })) },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await auditCreate(ctx, "customer.created", opMock, callerTx as any);

      expect(prismaMock.$transaction).not.toHaveBeenCalled();
      expect(opMock).toHaveBeenCalledWith(callerTx);
      expect(callerTx.auditLog.create).toHaveBeenCalledTimes(1);
      // The internal prismaMock's tx wasn't used.
      expect(txMock.auditLog.create).not.toHaveBeenCalled();
    });

    it("propagates errors from op without writing the audit row", async () => {
      const boom = new Error("db down");
      const opMock = vi.fn(async () => {
        throw boom;
      });

      await expect(auditCreate(ctx, "customer.created", opMock)).rejects.toBe(boom);
      // The transaction was started, but auditLog.create was never called
      // because op threw first. Atomicity: no audit row lands without the
      // entity (and vice versa).
      expect(txMock.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("auditUpdate", () => {
    it("writes audit with the supplied before snapshot and the entity returned by op", async () => {
      const before = { id: "x-1", name: "old" };
      const after = { id: "x-1", name: "new" };
      const opMock = vi.fn(async () => after);

      await auditUpdate(ctx, "customer.updated", before, opMock);

      const auditCall = (txMock.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      expect(auditCall.data.action).toBe("UPDATE");
      expect(auditCall.data.beforeState).toEqual(before);
      expect(auditCall.data.afterState).toEqual(after);
      expect(auditCall.data.metadata).toEqual({ eventType: "customer.updated" });
    });

    it("coerces undefined before-state to JsonNull", async () => {
      const opMock = vi.fn(async () => ({ id: "x-2" }));
      await auditUpdate(ctx, "customer.updated", undefined, opMock);

      const auditCall = (txMock.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      // Prisma.JsonNull is an object, not literal null. Accept either —
      // what matters is the value isn't `undefined` (Prisma rejects that).
      expect(auditCall.data.beforeState).toBeDefined();
    });
  });

  describe("writeAuditRow", () => {
    it("writes a standalone audit row using the provided tx", async () => {
      const callerTx = {
        $executeRaw: vi.fn(async () => 0),
        auditLog: { create: vi.fn(async () => ({ id: "audit-3" })) },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeAuditRow(callerTx as any, ctx, "meter.created", "meter-1", null, { id: "meter-1" });

      expect(callerTx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(callerTx.auditLog.create).toHaveBeenCalledTimes(1);
      const auditCall = (callerTx.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      expect(auditCall.data.action).toBe("CREATE");
      expect(auditCall.data.entityId).toBe("meter-1");
    });

    it("maps eventType suffix to action — .deleted -> DELETE", async () => {
      const callerTx = {
        $executeRaw: vi.fn(async () => 0),
        auditLog: { create: vi.fn(async () => ({ id: "audit-4" })) },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeAuditRow(callerTx as any, ctx, "meter.deleted", "meter-2", { id: "meter-2" }, null);
      const auditCall1 = (callerTx.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      expect(auditCall1.data.action).toBe("DELETE");
    });

    it("maps eventType suffix to action — .revised -> UPDATE", async () => {
      const callerTx = {
        $executeRaw: vi.fn(async () => 0),
        auditLog: { create: vi.fn(async () => ({ id: "audit-5" })) },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await writeAuditRow(callerTx as any, ctx, "rate_schedule.revised", "r-1", null, null);
      const auditCall2 = (callerTx.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0];
      expect(auditCall2.data.action).toBe("UPDATE");
    });
  });
});
