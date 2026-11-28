import { z } from "zod";
import type { PrismaClient } from "@utility-cis/shared/src/generated/prisma";
import type { VariableKey, VariableValue } from "../../rate-engine/types.js";
import { Decimal } from "../../rate-engine/decimal.js";
import type { Loader, LoaderCapability } from "../types.js";

/**
 * Peak demand for rating (spec 31, slice 2).
 *
 *   - `demand:peak:<meter_id>`  → one meter's measured peak for the period
 *   - `demand:history:<sa_id>`  → the agreement's measured peaks before it
 *
 * **Both read `meter_read` rows in a DEMAND unit, and nothing else.** A
 * demand register's read lands there (stored as the peak since slice 1),
 * and slice 3's interval roll-up writes the period's interval peak there
 * too — so the two sources arrive in one shape, and no peak-history table
 * is needed (the architectural check in spec 31).
 *
 * **A peak is the maximum, never a sum** (DEM-ENG-1a): a meter read twice
 * in a period has two peaks, and its demand is the higher. The engine then
 * adds meters together (DEM-ENG-2).
 */

/** Peaks per meter for one period. */
export interface DemandPeak {
  /** Null when the meter has a demand register but no read this period. */
  quantity: Decimal | null;
  unit: string;
  /** The read the peak came from, so a bill can say when. */
  readDate: string | null;
}

/** One month of the agreement's history: its meters' peaks, added. */
export interface DemandHistoryEntry {
  /** YYYY-MM of the reads. */
  month: string;
  /** The latest read date in the month, YYYY-MM-DD — what a lookback is measured against. */
  readDate: string;
  quantity: Decimal;
  unit: string;
}

/**
 * How far back history is loaded. The grammar caps a ratchet's lookback
 * at 36 months, so one fetch serves any component on the schedule.
 */
const HISTORY_MONTHS = 36;

const DEMAND = { uom: { measureType: { code: "DEMAND" } } } as const;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class DemandLoader implements Loader {
  constructor(
    private prisma: PrismaClient,
    private utilityId: string,
    private saId: string,
    private period: { startDate: Date; endDate: Date },
  ) {}

  capabilities(): LoaderCapability[] {
    return [
      {
        pattern: "demand:peak:<meter_id>",
        paramTypes: { meter_id: z.string().uuid() },
        scope: "per_sa",
        description: "A meter's measured peak demand for the billing period",
      },
      {
        pattern: "demand:history:<sa_id>",
        paramTypes: { sa_id: z.string().uuid() },
        scope: "per_sa",
        description: "The agreement's measured peak demand by month, before this period",
      },
    ];
  }

  async load(keys: VariableKey[]): Promise<Map<VariableKey, VariableValue>> {
    const out = new Map<VariableKey, VariableValue>();
    const meterIds = keys.filter((k) => k.startsWith("demand:peak:")).map((k) => k.slice("demand:peak:".length));
    if (meterIds.length > 0) {
      for (const [meterId, peak] of await this.peaks(meterIds)) out.set(`demand:peak:${meterId}`, peak);
    }
    if (keys.includes(`demand:history:${this.saId}`)) {
      out.set(`demand:history:${this.saId}`, await this.history());
    }
    return out;
  }

  /**
   * Each meter's peak in the period, or a gap marker for a meter that has
   * a demand register and no read — and **no entry at all** for a meter
   * that measures no demand. The engine treats those three differently:
   * a gap stops the bill (the peak may be the one missing), and a meter
   * with no demand register simply contributes nothing.
   */
  private async peaks(meterIds: string[]): Promise<Map<string, DemandPeak>> {
    const [reads, registers] = await Promise.all([
      this.prisma.meterRead.findMany({
        where: {
          utilityId: this.utilityId,
          meterId: { in: meterIds },
          readDate: { gte: this.period.startDate, lte: this.period.endDate },
          // A total peak; an on-peak-window peak (slice 3) carries its period's code.
          peakCode: null,
          ...DEMAND,
        },
        select: { meterId: true, consumption: true, readDate: true, uom: { select: { code: true } } },
      }),
      this.prisma.meterRegister.findMany({
        where: { utilityId: this.utilityId, meterId: { in: meterIds }, isActive: true, ...DEMAND },
        select: { meterId: true, uom: { select: { code: true } } },
      }),
    ]);

    const out = new Map<string, DemandPeak>();
    for (const r of reads) {
      const q = new Decimal(r.consumption.toString());
      const best = out.get(r.meterId);
      if (!best || best.quantity === null || q.gt(best.quantity)) {
        out.set(r.meterId, { quantity: q, unit: r.uom.code, readDate: isoDay(r.readDate) });
      }
    }
    for (const reg of registers) {
      if (!out.has(reg.meterId)) out.set(reg.meterId, { quantity: null, unit: reg.uom.code, readDate: null });
    }
    return out;
  }

  /**
   * The agreement's peaks by month, before this period. **Reads taken
   * under this agreement only** (D1): a customer moving into a building is
   * a new agreement, and is not billed on the previous occupant's peak.
   * Within a month, each meter's highest read, then the meters added.
   */
  private async history(): Promise<DemandHistoryEntry[]> {
    const from = new Date(this.period.startDate);
    from.setUTCMonth(from.getUTCMonth() - HISTORY_MONTHS);
    const reads = await this.prisma.meterRead.findMany({
      where: {
        utilityId: this.utilityId,
        serviceAgreementId: this.saId,
        readDate: { gte: from, lt: this.period.startDate },
        peakCode: null,
        ...DEMAND,
      },
      select: { meterId: true, consumption: true, readDate: true, uom: { select: { code: true } } },
    });

    const byMonth = new Map<string, { perMeter: Map<string, Decimal>; latest: string; unit: string }>();
    for (const r of reads) {
      const day = isoDay(r.readDate);
      const month = day.slice(0, 7);
      const m = byMonth.get(month) ?? { perMeter: new Map(), latest: day, unit: r.uom.code };
      const q = new Decimal(r.consumption.toString());
      const prior = m.perMeter.get(r.meterId);
      if (!prior || q.gt(prior)) m.perMeter.set(r.meterId, q);
      if (day > m.latest) m.latest = day;
      byMonth.set(month, m);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({
        month,
        readDate: m.latest,
        quantity: [...m.perMeter.values()].reduce((a, b) => a.plus(b), new Decimal(0)),
        unit: m.unit,
      }));
  }
}
