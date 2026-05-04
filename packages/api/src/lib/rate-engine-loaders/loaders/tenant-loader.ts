import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Slice 4 task 4 — tenant-domain variable loader.
 *
 * Capabilities:
 *   - `tenant:drought_stage`         → 0 | 1 | 2 | 3 | 4
 *                                       (currently-declared drought stage; 0 = none)
 *   - `tenant:flags:<flag_name>`     → boolean
 *
 * Both pull from the generic per-tenant `tenant_setting` table. The
 * setting `name` column is shaped to match the variable key minus the
 * `tenant:` prefix:
 *
 *   tenant:drought_stage  →  name = "drought_stage"
 *   tenant:flags:autopay  →  name = "flags.autopay"
 *
 * Missing rows fall through to safe defaults (drought_stage = 0,
 * unknown flags = false) so the engine never observes `undefined` for
 * a registered key.
 */
const DROUGHT_STAGE_KEY: VariableKey = "tenant:drought_stage";
const FLAG_PREFIX = "tenant:flags:";

export class TenantLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "tenant:drought_stage",
        scope: "per_tenant",
        returns: z.union([
          z.literal(0),
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
        ]),
        description: "Currently declared drought stage (0 = none, 1-4 = stages)",
      },
      {
        pattern: "tenant:flags:<flag_name>",
        paramTypes: { flag_name: z.string() },
        scope: "per_tenant",
        returns: z.boolean(),
        description: "Boolean tenant-level flag (e.g. autopay, paperless_default)",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    // Map each requested variable key to the tenant_setting.name we
    // expect to find. Keep the key→name pairing local so we can map
    // results back to their original keys after the batched query.
    const settingNames = new Set<string>();
    const keyToSettingName = new Map<VariableKey, string>();
    for (const k of keys) {
      if (k === DROUGHT_STAGE_KEY) {
        const name = "drought_stage";
        settingNames.add(name);
        keyToSettingName.set(k, name);
      } else if (k.startsWith(FLAG_PREFIX)) {
        const flag = k.slice(FLAG_PREFIX.length);
        const name = `flags.${flag}`;
        settingNames.add(name);
        keyToSettingName.set(k, name);
      }
    }

    if (keyToSettingName.size === 0) return out;

    const rows = await this.prisma.tenantSetting.findMany({
      where: { utilityId: this.utilityId, name: { in: [...settingNames] } },
      select: { name: true, value: true },
    });
    const byName = new Map(rows.map((r) => [r.name, r.value]));

    for (const [key, settingName] of keyToSettingName) {
      const v = byName.get(settingName);
      if (key === DROUGHT_STAGE_KEY) {
        // drought_stage stored as a JSON number; treat any non-number
        // (including undefined / null) as "no drought declared" = 0.
        out.set(key, typeof v === "number" ? v : 0);
      } else {
        // Flags coerce truthy/falsy JSON to a strict boolean. Missing
        // rows → false. Lets configurators reference flags that haven't
        // been seeded yet without breaking the rating run.
        out.set(key, Boolean(v));
      }
    }

    return out;
  }
}
