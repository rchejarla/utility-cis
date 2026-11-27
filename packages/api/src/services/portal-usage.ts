/**
 * A customer's usage by month, for the portal.
 *
 * **Totals and TOU buckets are summed separately, and the total wins where
 * both exist** — the rule the rating engine's meter loader uses
 * (`rate-engine-loaders/loaders/meter-loader.ts`). Since the
 * `tou_registers` migration a TOU meter carries a total read *and* a row
 * per TOU period for the same month, which reconcile. The portal used to
 * add every row up, so a TOU customer's month showed roughly double what
 * they used and what they were billed for. A meter with no total read — an
 * interval meter, whose roll-up writes only buckets — falls back to the sum
 * of its buckets, as the engine does.
 *
 * Grouped per meter before per month, because the rule is about one
 * meter's rows: a premise with an ordinary meter and a TOU meter must not
 * let one meter's total suppress the other's buckets.
 */
export interface UsageRead {
  readDate: Date | string;
  consumption: unknown;
  peakCode: string | null;
  meterId: string;
}

export function monthlyUsage(reads: UsageRead[]): { month: string; total: number }[] {
  // month -> meter -> sums
  const byMonth = new Map<string, Map<string, { total: number; buckets: number; hasTotal: boolean }>>();
  for (const r of reads) {
    const month = (typeof r.readDate === "string" ? r.readDate : r.readDate.toISOString()).slice(0, 7);
    const meters = byMonth.get(month) ?? new Map();
    const m = meters.get(r.meterId) ?? { total: 0, buckets: 0, hasTotal: false };
    const c = Number(r.consumption);
    if (r.peakCode === null) {
      m.total += c;
      m.hasTotal = true;
    } else {
      m.buckets += c;
    }
    meters.set(r.meterId, m);
    byMonth.set(month, meters);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, meters]) => {
      let total = 0;
      for (const m of meters.values()) total += m.hasTotal ? m.total : m.buckets;
      return { month, total: Math.round(total * 100) / 100 };
    });
}
