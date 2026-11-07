import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler, ParseRowResult, RowResult } from "../types.js";

/**
 * Importing interval data (spec 26, TOU-INT-2).
 *
 * **The ingress the interval path never had.** Everything downstream of
 * `meter_read_interval` was built and tested — tiling, classification,
 * the roll-up into TOU buckets, the coverage queue, the pre-run blocker,
 * the bill — while the table's only writer was `seed/tou-service.js`. A
 * utility with an AMI head-end could not deliver a day of data.
 *
 * **Long format only, one row per interval.** The framework maps
 * columns, so that is the shape it can read. Head-end exports are often
 * *wide* — one row per day with 24 or 96 quantity columns — and reading
 * those means a handler that emits many rows per source row, which no
 * handler does. Deliberately not built for a format nobody has sent
 * yet: the decision is recorded in spec 26 §3b with what it would take.
 *
 * **A scale limit worth knowing.** The framework is row-at-a-time, each
 * row in its own transaction, which is right for a few thousand rows of
 * customers. A month of 15-minute data is 2,976 rows *per meter*, so a
 * hundred meters is 300,000 — and that will be slow enough to notice.
 * It is still the right first move: an operator gets per-row errors, a
 * history, cancel and retry for free, and the shape of a real head-end
 * file is still a guess. A bulk path can come when a real file proves
 * it necessary (spec 26 §3b).
 */

/** The four the `meter_read_interval_quality_known` CHECK allows. */
const QUALITIES = ["actual", "estimated", "missing", "edited"] as const;
/** The four `meter_read_interval_length_known` allows. */
const LENGTHS = [5, 15, 30, 60] as const;

/**
 * An ISO-ish timestamp, with the zone optional.
 *
 * A date alone is refused rather than read as midnight: a day is not an
 * interval start, and taking it as one would put a file's 96 rows on a
 * single timestamp — where the unique index keeps the first and errors
 * the rest, which reads as "the import half worked".
 */
const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export interface IntervalRow {
  meterNumber: string;
  /** Optional: a meter whose registers report separately. */
  registerNumber: number | null;
  /**
   * The instant, once known. When `zoneAssumed` is true this is a
   * placeholder and `localWallClock` is the fact — `processRow`
   * resolves it against the tenant's timezone.
   */
  intervalStart: Date;
  /** `YYYY-MM-DDTHH:mm:ss`, set only when the file named no zone. */
  localWallClock: string | null;
  /**
   * Whether the file left the zone out. Carried rather than decided,
   * because deciding needs the tenant and this function is pure.
   */
  zoneAssumed: boolean;
  lengthMinutes: number;
  /** A string, so a decimal survives the trip to Postgres unrounded. */
  quantity: string;
  quality: (typeof QUALITIES)[number];
}

/**
 * Exported for its own tests: this is where a file's wording becomes a
 * row, and all three of the things an interval file gets silently
 * wrong — the length, the quality, the zone — are decided here.
 */
export function parseIntervalRow(raw: Record<string, string>): ParseRowResult<IntervalRow> {
  const meterNumber = (raw.meterNumber ?? "").trim();
  if (!meterNumber) {
    return { ok: false, code: "MISSING_METER_NUMBER", message: "meter_number is required" };
  }

  const startRaw = (raw.intervalStart ?? "").trim();
  const m = TIMESTAMP.exec(startRaw);
  if (!m) {
    return {
      ok: false,
      code: "INVALID_INTERVAL_START",
      message:
        `interval_start "${raw.intervalStart}" is not a date and time. ` +
        "Expected 2026-02-08T01:00:00Z, or the same without a zone, which is read in the tenant's timezone.",
    };
  }
  const [, date, clock, zone] = m;
  const seconds = clock!.length === 5 ? `${clock}:00` : clock!;
  const zoneAssumed = !zone;
  /*
   * Normalised to a `Z`-less wall clock when the file named no zone, so
   * `processRow` can place it in the tenant's zone. The `Date` below is
   * then a placeholder — right only for a UTC tenant — and
   * `zoneAssumed` is what stops anybody trusting it.
   */
  const localWallClock = zoneAssumed ? `${date}T${seconds}` : null;
  const intervalStart = new Date(
    zoneAssumed ? `${date}T${seconds}Z` : `${date}T${seconds}${zone === "Z" ? "Z" : zone}`,
  );
  if (Number.isNaN(intervalStart.getTime())) {
    return {
      ok: false,
      code: "INVALID_INTERVAL_START",
      message: `interval_start "${raw.intervalStart}" is not a valid date and time`,
    };
  }

  const lengthMinutes = Number((raw.lengthMinutes ?? "").trim());
  if (!LENGTHS.includes(lengthMinutes as (typeof LENGTHS)[number])) {
    return {
      ok: false,
      code: "INVALID_LENGTH",
      message:
        `length_minutes "${raw.lengthMinutes}" is not one of 5, 15, 30, 60. ` +
        "Those are the lengths a TOU calendar's boundaries can divide.",
    };
  }

  const quantityRaw = (raw.quantity ?? "").trim();
  if (quantityRaw === "" || !Number.isFinite(Number(quantityRaw))) {
    return {
      ok: false,
      code: "INVALID_QUANTITY",
      message: `quantity "${raw.quantity}" is not a number`,
    };
  }

  const qualityRaw = (raw.quality ?? "").trim().toLowerCase();
  const quality = (qualityRaw || "actual") as (typeof QUALITIES)[number];
  if (!QUALITIES.includes(quality)) {
    return {
      ok: false,
      code: "INVALID_QUALITY",
      message: `quality "${raw.quality}" is not one of ${QUALITIES.join(", ")}`,
    };
  }

  const registerRaw = (raw.registerNumber ?? "").trim();
  let registerNumber: number | null = null;
  if (registerRaw !== "") {
    registerNumber = Number(registerRaw);
    if (!Number.isInteger(registerNumber) || registerNumber < 1) {
      return {
        ok: false,
        code: "INVALID_REGISTER",
        message: `register_number "${raw.registerNumber}" is not a register number`,
      };
    }
  }

  return {
    ok: true,
    row: {
      meterNumber,
      registerNumber,
      intervalStart,
      localWallClock,
      zoneAssumed,
      lengthMinutes,
      // The string, not the number: 0.000001 of a kWh is still a
      // quantity, and `Number` would round where Postgres would not.
      quantity: quantityRaw,
      quality,
    },
  };
}

interface BatchData {
  /** Meter number → id and default unit. */
  meterByNumber: Map<string, { id: string; uomId: string }>;
  /** `${meterId}:${registerNumber}` → register id. */
  registerByKey: Map<string, string>;
  /**
   * The tenant's own timezone, for rows whose file named none.
   *
   * `utility_config.timezone`, which is the zone the tenant already
   * schedules everything else by. A head-end file of local times is
   * read in it, and the import's summary says so — naming the
   * assumption beats guessing quietly, and a file crossing a DST
   * boundary is exactly where a silent guess goes wrong.
   */
  timezone: string;
}

/** The UTC instant for a wall clock in `zone`. Two passes settle DST. */
function instantFor(wallClock: string, zone: string): Date {
  const naive = new Date(`${wallClock}Z`);
  const offsetAt = (instant: Date): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return asUtc - instant.getTime();
  };
  const firstGuess = new Date(naive.getTime() - offsetAt(naive));
  return new Date(naive.getTime() - offsetAt(firstGuess));
}

const handler: ImportKindHandler<IntervalRow, BatchData> = {
  kind: "meter_read_interval",
  label: "Interval data",
  module: "meter_reads",
  permission: "CREATE",
  wizardPath: "/meter-reads/intervals/import",

  canonicalFields: [
    {
      name: "meterNumber",
      label: "Meter number",
      required: true,
      description: "Identifier matching an existing meter on this tenant.",
      example: "TOU-AMI-001",
      aliases: ["^meternumber$", "^meter$", "^meterid$", "^metercode$", "^mtr$", "^serial$"],
    },
    {
      name: "intervalStart",
      label: "Interval start",
      required: true,
      description:
        "When the interval begins. With a zone (2026-02-08T01:00:00Z) or without, in which case the tenant's timezone is used.",
      example: "2026-02-08T01:00:00Z",
      aliases: [
        "^intervalstart$",
        "^start$",
        "^starttime$",
        "^startdatetime$",
        "^timestamp$",
        "^datetime$",
        "^readtime$",
      ],
    },
    {
      name: "lengthMinutes",
      label: "Interval length (minutes)",
      required: true,
      description: "5, 15, 30 or 60 — the lengths a TOU period boundary can divide.",
      example: "15",
      aliases: ["^lengthminutes$", "^length$", "^minutes$", "^interval$", "^duration$"],
    },
    {
      name: "quantity",
      label: "Quantity",
      required: true,
      description:
        "Consumption in the meter's unit for this interval. Negative for a meter exporting.",
      example: "1.25",
      aliases: ["^quantity$", "^value$", "^usage$", "^kwh$", "^consumption$"],
    },
    {
      name: "quality",
      label: "Quality",
      required: false,
      description:
        "actual (default), estimated, missing or edited. `missing` records that the meter had no value — a hole it knows about, which bills differently from one nobody noticed.",
      example: "actual",
      aliases: ["^quality$", "^status$", "^flag$"],
    },
    {
      name: "registerNumber",
      label: "Register number",
      required: false,
      description: "Only for a meter whose registers report intervals separately.",
      example: "1",
      aliases: ["^registernumber$", "^register$", "^channel$"],
    },
  ],

  templateRows: [
    {
      meterNumber: "TOU-AMI-001",
      intervalStart: "2026-02-08T00:00:00Z",
      lengthMinutes: "60",
      quantity: "0.4",
      quality: "actual",
      registerNumber: "",
    },
    {
      meterNumber: "TOU-AMI-001",
      intervalStart: "2026-02-08T01:00:00Z",
      lengthMinutes: "60",
      quantity: "0.3",
      quality: "actual",
      registerNumber: "",
    },
  ],

  parseRow: parseIntervalRow,

  async prepareBatch(ctx, rows) {
    const numbers = [...new Set(rows.map((r) => r.meterNumber))];
    const meters = await prisma.meter.findMany({
      where: { utilityId: ctx.utilityId, meterNumber: { in: numbers } },
      select: { id: true, meterNumber: true, uomId: true },
    });
    const meterByNumber = new Map(
      meters.map((m) => [m.meterNumber, { id: m.id, uomId: m.uomId }]),
    );

    /*
     * Registers only for the meters a row actually names one for —
     * most files name none, and loading every register of every meter
     * would be a query for nothing.
     */
    const registerByKey = new Map<string, string>();
    const withRegisters = rows.filter((r) => r.registerNumber !== null);
    if (withRegisters.length > 0) {
      const ids = [
        ...new Set(
          withRegisters
            .map((r) => meterByNumber.get(r.meterNumber)?.id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const registers = await prisma.meterRegister.findMany({
        where: { utilityId: ctx.utilityId, meterId: { in: ids } },
        select: { id: true, meterId: true, registerNumber: true },
      });
      for (const r of registers) {
        registerByKey.set(`${r.meterId}:${r.registerNumber}`, r.id);
      }
    }

    const config = await prisma.utilityConfig.findFirst({
      where: { utilityId: ctx.utilityId },
      select: { timezone: true },
    });

    return {
      meterByNumber,
      registerByKey,
      timezone: config?.timezone ?? "UTC",
    };
  },

  async processRow(ctx, row, batch): Promise<RowResult> {
    const meter = batch.meterByNumber.get(row.meterNumber);
    if (!meter) {
      return {
        ok: false,
        code: "UNKNOWN_METER",
        message: `No meter "${row.meterNumber}" on this tenant`,
      };
    }

    let registerId: string | null = null;
    if (row.registerNumber !== null) {
      registerId = batch.registerByKey.get(`${meter.id}:${row.registerNumber}`) ?? null;
      if (!registerId) {
        return {
          ok: false,
          code: "UNKNOWN_REGISTER",
          message: `Meter "${row.meterNumber}" has no register ${row.registerNumber}`,
        };
      }
    }

    /*
     * The zone, resolved here because here is where the tenant is
     * known. A file that named one is already an instant.
     */
    const intervalStart = row.zoneAssumed && row.localWallClock
      ? instantFor(row.localWallClock, batch.timezone)
      : row.intervalStart;

    /*
     * **Replace, not a second row.** The database's own key is
     * `(meter_id, register_id, interval_start)` — two partial unique
     * indexes, one per branch of `register_id IS NULL` — so a re-sent
     * day is the same rows, and a head-end re-sending usually means
     * corrected values. Prisma cannot `upsert` on a partial index, so
     * this is find-then-write; the index is still what makes it safe,
     * since a racing duplicate fails the insert and errors that row
     * rather than doubling the day.
     *
     * Nothing is deleted that the file did not mention. Re-importing a
     * day at a *different* resolution therefore leaves the old rows
     * beside the new ones, which the roll-up sees as an `overlap` and
     * refuses — visible in the coverage queue rather than silently
     * resolved by throwing away data the operator did not ask to lose.
     */
    const existing = await ctx.tx.meterReadInterval.findFirst({
      where: {
        utilityId: ctx.utilityId,
        meterId: meter.id,
        registerId,
        intervalStart,
      },
      select: { id: true },
    });

    if (existing) {
      /*
       * `updateMany` rather than `update`: the primary key is
       * `(id, interval_start)` — TimescaleDB requires the partitioning
       * column in every unique constraint — so there is no single-field
       * `where` for Prisma's typed `update` to take.
       */
      await ctx.tx.meterReadInterval.updateMany({
        where: { id: existing.id, intervalStart },
        data: {
          lengthMinutes: row.lengthMinutes,
          quantity: row.quantity,
          quality: row.quality,
        },
      });
      return { ok: true, entityId: existing.id };
    }

    /*
     * No audit row per interval. A month of one meter's 15-minute data
     * is 2,976 of them, and they would say nothing `import_batch` does
     * not already record — who imported what, when, and with what
     * result per row. The framework audits the batch. A meter *read* is
     * audited one at a time because somebody disputes one at a time;
     * an interval is part of a series.
     */
    const created = await ctx.tx.meterReadInterval.create({
      data: {
        utilityId: ctx.utilityId,
        meterId: meter.id,
        registerId,
        uomId: meter.uomId,
        intervalStart,
        lengthMinutes: row.lengthMinutes,
        quantity: row.quantity,
        quality: row.quality,
        // Which file put this here — the question somebody asks when a
        // head-end sends a bad day, and what the table's
        // `(utility_id, import_batch_id)` index is for.
        importBatchId: ctx.batchId,
      },
      select: { id: true },
    });

    return { ok: true, entityId: created.id };
  },
};

registerImportKind(handler as unknown as ImportKindHandler<unknown, unknown>);

export default handler;
