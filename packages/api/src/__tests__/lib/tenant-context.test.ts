import { describe, it, expect } from "vitest";
import {
  runAsTenant,
  runAsPlatform,
  currentTenant,
} from "../../lib/tenant-context.js";

/**
 * Who the current work is acting for, carried across async boundaries.
 *
 * This exists because row-level security binds to a setting on the
 * connection, and the connection is chosen by the pool at the moment a
 * query runs — not by the request that caused it. Middleware cannot pin
 * one to the other. So the tenant travels with the *execution*, and
 * `lib/prisma.ts` reads it when a connection is checked out.
 *
 * The cases below are about the three ways that goes wrong: a sibling
 * branch seeing another's tenant, a nested scope destroying its outer
 * one, and work running with no scope at all being mistaken for work
 * belonging to nobody.
 */

const A = "00000000-0000-4000-8000-0000000000aa";
const B = "00000000-0000-4000-8000-0000000000bb";

describe("tenant context", () => {
  it("is absent outside any scope, rather than defaulting to somebody", async () => {
    expect(currentTenant()).toBeNull();
  });

  it("names the tenant inside its scope", async () => {
    await runAsTenant(A, async () => {
      expect(currentTenant()).toEqual({ kind: "tenant", utilityId: A });
    });
  });

  it("distinguishes platform work from a tenant's", async () => {
    await runAsPlatform(async () => {
      expect(currentTenant()).toEqual({ kind: "platform" });
    });
  });

  /*
   * The case the whole mechanism exists for. Two tenants' work in flight
   * at once is the ordinary state of this server — six queues sweep
   * several tenants in one process — and a store shared between them
   * would be a cross-tenant read that raises no error.
   */
  it("keeps concurrent branches from seeing each other's tenant", async () => {
    const seen: string[] = [];
    const branch = (id: string) =>
      runAsTenant(id, async () => {
        // Yield, so the branches genuinely interleave rather than
        // running to completion one after the other.
        await new Promise((r) => setTimeout(r, 5));
        const ctx = currentTenant();
        seen.push(ctx?.kind === "tenant" ? ctx.utilityId : "none");
      });

    await Promise.all([branch(A), branch(B), branch(A)]);
    expect(seen.sort()).toEqual([A, A, B].sort());
  });

  it("restores the outer scope when an inner one ends", async () => {
    await runAsTenant(A, async () => {
      await runAsTenant(B, async () => {
        expect(currentTenant()).toEqual({ kind: "tenant", utilityId: B });
      });
      expect(currentTenant()).toEqual({ kind: "tenant", utilityId: A });
    });
    expect(currentTenant()).toBeNull();
  });

  it("restores the outer scope even when the inner one throws", async () => {
    await runAsTenant(A, async () => {
      await expect(
        runAsPlatform(async () => {
          throw new Error("inner failed");
        }),
      ).rejects.toThrow("inner failed");
      expect(currentTenant()).toEqual({ kind: "tenant", utilityId: A });
    });
  });

  /*
   * A malformed id must not reach a `set_config`. It is interpolated
   * into SQL at checkout — parameterising a SET is not possible — so
   * this is the gate that keeps that safe, and it belongs here rather
   * than at the point of use.
   */
  it("refuses an id that is not a uuid", async () => {
    await expect(runAsTenant("'; DROP TABLE account; --", async () => 1)).rejects.toThrow(
      /utility id/i,
    );
    await expect(runAsTenant("", async () => 1)).rejects.toThrow(/utility id/i);
  });

  it("hands back whatever the scoped work returned", async () => {
    expect(await runAsTenant(A, async () => "done")).toBe("done");
    expect(await runAsPlatform(async () => 42)).toBe(42);
  });
});
