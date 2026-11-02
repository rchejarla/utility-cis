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
        pattern: "meter:tou:<meter_id>:<peak_code>",
        paramTypes: { meter_id: z.string().uuid(), peak_code: z.string() },
        scope: "per_sa",
        returns: z.object({ quantity: z.unknown(), unit: z.string() }),
        description: "One TOU period's consumption for the billing period (spec 26, TOU-REG-1)",
      },
      {
        pattern: "meter:peak_demand:<meter_id>:<window>",
        paramTypes: { meter_id: z.string().uuid(), window: z.string() },
        scope: "per_sa",
        description: "Peak demand for a meter — not implemented in Slice 4",
        unsupported: true,
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    if (keys.length === 0) return out;

    const meterIdsForReads = new Set<string>();
    const meterIdsForMeta = new Set<string>(); // size + role
    const peakDemandKeys: VariableKey[] = [];
    /** `meter:tou:<meterId>:<peakCode>` → the two parts, parsed. */
    const touKeys: Array<{ key: VariableKey; meterId: string; peakCode: string }> = [];

    for (const k of keys) {
      if (k.startsWith("meter:tou:")) {
        // Parsed, not suffix-matched: peak codes mostly end in "peak",
        // so a suffix test would answer one period's key with
        // another's usage.
        const parts = k.split(":");
        if (parts.length === 4) {
          touKeys.push({ key: k, meterId: parts[2]!, peakCode: parts[3]! });
        }
      } else if (k.startsWith("meter:reads:")) {
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
          peakCode: true,
          uom: { select: { code: true } },
        },
      });

      /*
       * **Totals and TOU buckets are summed separately**, and the total
       * wins where both exist.
       *
       * Since the `tou_registers` migration a meter may carry a total
       * read *and* a row per TOU period for the same month — TOU-REG-1
       * expects them to reconcile. Summing the lot would count the month
       * twice, and the symptom would not be an error: it would be a
       * tiered charge at double the usage, on an ordinary-looking bill.
       *
       * Falling back to the buckets matters just as much. A TOU meter
       * with no total register still has a month's total, and it is the
       * sum of its periods — without the fallback, a flat or tiered
       * component on the same schedule would bill such a customer zero.
       */
      const totals = new Map<string, { quantity: Decimal; unit: string }>();
      const buckets = new Map<string, { quantity: Decimal; unit: string }>();
      for (const r of reads) {
        const into = r.peakCode === null ? totals : buckets;
        const existing = into.get(r.meterId);
        const c = new Decimal(r.consumption.toString());
        into.set(r.meterId, {
          quantity: existing ? existing.quantity.plus(c) : c,
          unit: r.uom?.code ?? "HCF",
        });
      }

      for (const meterId of meterIdsForReads) {
        const summary =
          totals.get(meterId) ?? buckets.get(meterId) ?? { quantity: ZERO, unit: "HCF" };
        out.set(`meter:reads:${meterId}`, summary);
      }
    }

    /*
     * TOU buckets (spec 26, TOU-REG-1).
     *
     * **The mapped registers decide which periods are answerable.** A
     * register carrying a peak code is the meter's declaration that it
     * counts that period, so this answers for a mapped period — zero
     * included, since a customer who used nothing on-peak owes nothing
     * — and answers *not at all* for a period no register covers.
     *
     * That asymmetry is the point. A two-register meter cannot report
     * mid-peak, and a zero there would bill nothing for mid-peak usage
     * the meter rolled into one of its two registers. Leaving the key
     * unset makes the `tou_period` quantity source raise, which stops
     * the bill and names the period.
     */
    if (touKeys.length > 0) {
      const meterIds = [...new Set(touKeys.map((t) => t.meterId))];
      const peakCodes = [...new Set(touKeys.map((t) => t.peakCode))];

      const registers = await this.prisma.meterRegister.findMany({
        where: {
          meterId: { in: meterIds },
          utilityId: this.utilityId,
          isActive: true,
          peakCode: { in: peakCodes },
        },
        select: { meterId: true, peakCode: true, uom: { select: { code: true } } },
      });
      const mapped = new Map(registers.map((r) => [`${r.meterId}:${r.peakCode}`, r]));

      const touReads = await this.prisma.meterRead.findMany({
        where: {
          meterId: { in: meterIds },
          utilityId: this.utilityId,
          peakCode: { in: peakCodes },
          readDate: { gte: this.period.startDate, lte: this.period.endDate },
        },
        select: {
          meterId: true,
          peakCode: true,
          consumption: true,
          uom: { select: { code: true } },
        },
      });

      const summed = new Map<string, { quantity: Decimal; unit: string }>();
      for (const r of touReads) {
        const slot = `${r.meterId}:${r.peakCode}`;
        const existing = summed.get(slot);
        const c = new Decimal(r.consumption.toString());
        summed.set(slot, {
          quantity: existing ? existing.quantity.plus(c) : c,
          unit: r.uom?.code ?? "HCF",
        });
      }

      for (const { key, meterId, peakCode } of touKeys) {
        const slot = `${meterId}:${peakCode}`;
        const register = mapped.get(slot);
        if (!register) continue; // Not a period this meter reports.
        out.set(
          key,
          summed.get(slot) ?? { quantity: ZERO, unit: register.uom?.code ?? "HCF" },
        );
      }
    }

    return out;
  }
}
