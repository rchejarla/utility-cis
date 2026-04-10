import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { auditCreate, auditUpdate } from "../lib/audit-wrap.js";
import { domainEvents } from "../events/emitter.js";
import type { DomainEvent } from "@utility-cis/shared";

describe("auditWrap", () => {
  let captured: DomainEvent[];
  const handler = (e: DomainEvent) => {
    captured.push(e);
  };

  beforeEach(() => {
    captured = [];
    domainEvents.on("domain-event", handler);
  });

  afterEach(() => {
    domainEvents.off("domain-event", handler);
  });

  const ctx = {
    utilityId: "u-1",
    actorId: "a-1",
    actorName: "Alice",
    entityType: "Customer",
  };

  it("auditCreate emits a create event with beforeState=null and the created entity", async () => {
    const entity = { id: "new-1", name: "Acme" };
    const result = await auditCreate(ctx, "customer.created", async () => entity);

    expect(result).toBe(entity);
    expect(captured).toHaveLength(1);
    const event = captured[0];
    expect(event.type).toBe("customer.created");
    expect(event.entityType).toBe("Customer");
    expect(event.entityId).toBe("new-1");
    expect(event.utilityId).toBe("u-1");
    expect(event.actorId).toBe("a-1");
    expect(event.actorName).toBe("Alice");
    expect(event.beforeState).toBeNull();
    expect(event.afterState).toEqual(entity);
    expect(typeof event.timestamp).toBe("string");
  });

  it("auditUpdate emits an update event carrying the provided before snapshot", async () => {
    const before = { id: "x-1", name: "old" };
    const after = { id: "x-1", name: "new" };
    await auditUpdate(ctx, "customer.updated", before, async () => after);

    expect(captured).toHaveLength(1);
    const event = captured[0];
    expect(event.type).toBe("customer.updated");
    expect(event.beforeState).toEqual(before);
    expect(event.afterState).toEqual(after);
  });

  it("auditUpdate coerces undefined before-state to null to match DomainEvent contract", async () => {
    await auditUpdate(
      ctx,
      "customer.updated",
      undefined,
      async () => ({ id: "x-2" })
    );
    expect(captured[0].beforeState).toBeNull();
  });

  it("propagates errors from the wrapped operation without emitting an event", async () => {
    const boom = new Error("db down");
    await expect(
      auditCreate(ctx, "customer.created", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(captured).toHaveLength(0);
  });
});
