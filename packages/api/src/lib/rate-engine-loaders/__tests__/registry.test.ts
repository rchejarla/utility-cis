import { describe, it, expect } from "vitest";
import { VariableRegistry } from "../registry.js";
import type { Loader, LoaderCapability } from "../types.js";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";

class StubLoader implements Loader {
  loadCalls: VariableKey[][] = [];
  constructor(
    private caps: LoaderCapability[],
    private values: Record<string, VariableValue> = {},
  ) {}
  capabilities() {
    return this.caps;
  }
  async load(keys: VariableKey[]) {
    this.loadCalls.push([...keys]);
    return new Map(keys.map((k) => [k, this.values[k]] as [VariableKey, VariableValue]));
  }
}

describe("VariableRegistry", () => {
  it("validateKey returns capability for a matching key", () => {
    const registry = new VariableRegistry();
    const loader = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance",
      },
    ]);
    registry.register(loader);

    const result = registry.validateKey("account:balance:acct-123");
    expect(result.valid).toBe(true);
    expect(result.capability?.pattern).toBe("account:balance:<account_id>");
    expect(result.error).toBeUndefined();
  });

  it("validateKey rejects an unmatched key", () => {
    const registry = new VariableRegistry();
    const loader = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance",
      },
    ]);
    registry.register(loader);

    const result = registry.validateKey("meter:reads:m-1");
    expect(result.valid).toBe(false);
    expect(result.capability).toBeUndefined();
    expect(result.error).toMatch(/No registered loader matches key/);
  });

  it("throws on conflicting patterns at registration time", () => {
    const registry = new VariableRegistry();
    const loaderA = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance (A)",
      },
    ]);
    const loaderB = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance (B)",
      },
    ]);
    registry.register(loaderA);
    expect(() => registry.register(loaderB)).toThrow(/Conflicting loader capability/);
  });

  it("loadVariables dispatches keys to the correct loader", async () => {
    const registry = new VariableRegistry();
    const accountLoader = new StubLoader(
      [
        {
          pattern: "account:balance:<account_id>",
          scope: "per_sa",
          description: "Account balance",
        },
      ],
      { "account:balance:a-1": 100, "account:balance:a-2": 200 },
    );
    const meterLoader = new StubLoader(
      [
        {
          pattern: "meter:reads:<meter_id>",
          scope: "per_sa",
          description: "Meter reads",
        },
      ],
      { "meter:reads:m-1": [{ value: 42 }] },
    );
    registry.register(accountLoader);
    registry.register(meterLoader);

    const result = await registry.loadVariables([
      "account:balance:a-1",
      "meter:reads:m-1",
      "account:balance:a-2",
    ]);

    expect(result.get("account:balance:a-1")).toBe(100);
    expect(result.get("account:balance:a-2")).toBe(200);
    expect(result.get("meter:reads:m-1")).toEqual([{ value: 42 }]);
    expect(accountLoader.loadCalls).toHaveLength(1);
    expect(meterLoader.loadCalls).toHaveLength(1);
  });

  it("loadVariables batches all keys for a loader into a single call", async () => {
    const registry = new VariableRegistry();
    const accountLoader = new StubLoader(
      [
        {
          pattern: "account:balance:<account_id>",
          scope: "per_sa",
          description: "Account balance",
        },
      ],
      { "account:balance:a-1": 1, "account:balance:a-2": 2, "account:balance:a-3": 3 },
    );
    registry.register(accountLoader);

    await registry.loadVariables([
      "account:balance:a-1",
      "account:balance:a-2",
      "account:balance:a-3",
    ]);

    expect(accountLoader.loadCalls).toHaveLength(1);
    expect(accountLoader.loadCalls[0]).toEqual([
      "account:balance:a-1",
      "account:balance:a-2",
      "account:balance:a-3",
    ]);
  });

  it("describeAll returns every registered capability", () => {
    const registry = new VariableRegistry();
    const loader = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance",
      },
      {
        pattern: "meter:reads:<meter_id>",
        scope: "per_sa",
        description: "Meter reads",
      },
    ]);
    registry.register(loader);

    const all = registry.describeAll();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.pattern)).toEqual([
      "account:balance:<account_id>",
      "meter:reads:<meter_id>",
    ]);
  });

  it("scopeOf returns the registered scope for a matching key", () => {
    const registry = new VariableRegistry();
    const loader = new StubLoader([
      {
        pattern: "account:balance:<account_id>",
        scope: "per_sa",
        description: "Account balance",
      },
      {
        pattern: "index:<index_name>:<period>",
        scope: "global",
        description: "Published index value",
      },
      {
        pattern: "tenant:fee_table:<table_name>",
        scope: "per_tenant",
        description: "Tenant fee table",
      },
    ]);
    registry.register(loader);

    expect(registry.scopeOf("account:balance:a-1")).toBe("per_sa");
    expect(registry.scopeOf("index:cpi:2025-01")).toBe("global");
    expect(registry.scopeOf("tenant:fee_table:late_fees")).toBe("per_tenant");
    expect(() => registry.scopeOf("nope:nope")).toThrow(/No registered loader/);
  });
});
