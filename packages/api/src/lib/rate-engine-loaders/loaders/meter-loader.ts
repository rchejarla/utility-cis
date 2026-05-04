import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import { Decimal, ZERO } from "../../rate-engine/decimal.js";
import type { Loader, LoaderCapability } from "../types.js";
import { UnsupportedInSlice4Error } from "../types.js";

/**
 * Slice 4 task 3 — meter-domain variable loader.
 *
 * Capabilities:
 *   - `meter:reads:<meter_id>`            → { quantity: Decimal, unit: string }
 *                                            (sum of MeterRead.consumption inside the period)
 *   - `meter:size:<meter_id>`             → string | null (meter.customFields.size)
 *   - `meter:role:<meter_id>`             → string | null (meter.customFields.role)
 *   - `meter:peak_demand:<meter_id>:<window>` → throws UnsupportedInSlice4Error
 *
 * The Meter model has no dedicated `size`/`role` columns — both live on
 * `customFields` (JSONB). Reads are aggregated against the period
 * supplied at construction time so the loader is bound to a single
 * rating run.
 */
export class MeterLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private period: { startDate: Date; endDate: Date },
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "meter:reads:<meter_id>",
        paramTypes: { meter_id: z.string().uuid() },
        scope: "per_sa",
        returns: z.object({ quantity: z.unknown(), unit: z.string() }),
        description: "Aggregated meter consumption for the billing period",
      },
      {
        pattern: "meter:size:<meter_id>",
        paramTypes: { meter_id: z.string().uuid() },
        scope: "per_sa",
        returns: z.string().nullable(),
        description: "Meter size (e.g. '5/8\"', '1\"', '2\"')",
      },
      {
        pattern: "meter:role:<meter_id>",
        paramTypes: { meter_id: z.string().uuid() },
        scope: "per_sa",
        returns: z.string().nullable(),
        description: "Meter role (e.g. primary, irrigation, sub-meter)",
      },
      {
        pattern: "meter:peak_demand:<meter_id>:<window>",
        paramTypes: { meter_id: z.string().uuid(), window: z.string() },
        scope: "per_sa",
        description: "Peak demand for a meter — not implemented in Slice 4",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const meterIdsForReads = new Set<string>();
    const meterIdsForMeta = new Set<string>(); // size + role
    const peakDemandKeys: VariableKey[] = [];

    for (const k of keys) {
      if (k.startsWith("meter:reads:")) {
        meterIdsForReads.add(k.slice("meter:reads:".length));
      } else if (k.startsWith("meter:size:")) {
        meterIdsForMeta.add(k.slice("meter:size:".length));
      } else if (k.startsWith("meter:role:")) {
        meterIdsForMeta.add(k.slice("meter:role:".length));
      } else if (k.startsWith("meter:peak_demand:")) {
        peakDemandKeys.push(k);
      }
    }

    // Fail fast on peak_demand — Slice 4 explicitly does not implement
    // it. Surfacing the error early keeps the trace readable: the
    // engine sees one clean exception with the offending key.
    if (peakDemandKeys.length > 0) {
      throw new UnsupportedInSlice4Error(`meter:peak_demand variable (${peakDemandKeys[0]})`);
    }

    // One Meter query covers size + role for all distinct meter ids.
    if (meterIdsForMeta.size > 0) {
      const meters = await this.prisma.meter.findMany({
        where: { id: { in: [...meterIdsForMeta] }, utilityId: this.utilityId },
        select: { id: true, customFields: true },
      });
      const byId = new Map(meters.map((m) => [m.id, m]));

      for (const k of keys) {
        if (k.startsWith("meter:size:")) {
          const id = k.slice("meter:size:".length);
          const m = byId.get(id);
          const cf = (m?.customFields as Record<string, unknown> | null) ?? {};
          const v = cf.size;
          out.set(k, typeof v === "string" ? v : null);
        } else if (k.startsWith("meter:role:")) {
          const id = k.slice("meter:role:".length);
          const m = byId.get(id);
          const cf = (m?.customFields as Record<string, unknown> | null) ?? {};
          const v = cf.role;
          out.set(k, typeof v === "string" ? v : null);
        }
      }
    }

    // One MeterRead query, then sum in-process by meter id. Decimal
    // precision is preserved by routing through decimal.js — the
    // Prisma Decimal value gets stringified before construction so
    // we don't lose digits to a JS number round-trip.
    if (meterIdsForReads.size > 0) {
      const reads = await this.prisma.meterRead.findMany({
        where: {
          meterId: { in: [...meterIdsForReads] },
          utilityId: this.utilityId,
          readDate: { gte: this.period.startDate, lte: this.period.endDate },
        },
        select: {
          meterId: true,
          consumption: true,
          uom: { select: { code: true } },
        },
      });

      const sumByMeter = new Map<string, { quantity: Decimal; unit: string }>();
      for (const r of reads) {
        const existing = sumByMeter.get(r.meterId);
        const c = new Decimal(r.consumption.toString());
        const q = existing ? existing.quantity.plus(c) : c;
        sumByMeter.set(r.meterId, { quantity: q, unit: r.uom?.code ?? "HCF" });
      }

      for (const meterId of meterIdsForReads) {
        const summary = sumByMeter.get(meterId) ?? { quantity: ZERO, unit: "HCF" };
        out.set(`meter:reads:${meterId}`, summary);
      }
    }

    return out;
  }
}
