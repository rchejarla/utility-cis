import type { VariableKey, VariableValue } from "../rate-engine/types.js";
import type { Loader, LoaderCapability } from "./types.js";

export class VariableRegistry {
  private capabilities: Array<{ cap: LoaderCapability; loader: Loader; regex: RegExp }> = [];

  register(loader: Loader): void {
    for (const cap of loader.capabilities()) {
      if (this.capabilities.some((existing) => existing.cap.pattern === cap.pattern)) {
        throw new Error(`Conflicting loader capability: ${cap.pattern}`);
      }
      const regex = patternToRegex(cap.pattern);
      this.capabilities.push({ cap, loader, regex });
    }
  }

  validateKey(key: VariableKey): { valid: boolean; capability?: LoaderCapability; error?: string } {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) return { valid: false, error: `No registered loader matches key: ${key}` };
    return { valid: true, capability: match.cap };
  }

  resolveLoader(key: VariableKey): Loader {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) throw new Error(`No registered loader for key: ${key}`);
    return match.loader;
  }

  scopeOf(key: VariableKey): "per_sa" | "per_tenant" | "global" {
    const match = this.capabilities.find(({ regex }) => regex.test(key));
    if (!match) throw new Error(`No registered loader for key: ${key}`);
    return match.cap.scope;
  }

  describeAll(): LoaderCapability[] {
    return this.capabilities.map((c) => c.cap);
  }

  async loadVariables(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const keysByLoader = new Map<Loader, VariableKey[]>();
    for (const key of keys) {
      const loader = this.resolveLoader(key);
      const list = keysByLoader.get(loader) ?? [];
      list.push(key);
      keysByLoader.set(loader, list);
    }

    const results = await Promise.all(
      [...keysByLoader.entries()].map(([loader, ks]) => loader.load(ks)),
    );

    const merged = new Map<VariableKey, VariableValue>();
    for (const r of results) {
      for (const [k, v] of r) merged.set(k, v);
    }
    return merged;
  }
}

function patternToRegex(pattern: string): RegExp {
  // "meter:reads:<meter_id>" → /^meter:reads:[^:]+$/
  // "index:<index_name>:<period>" → /^index:[^:]+:[^:]+$/
  const escaped = pattern.replace(/<[^>]+>/g, "[^:]+");
  return new RegExp(`^${escaped}$`);
}
