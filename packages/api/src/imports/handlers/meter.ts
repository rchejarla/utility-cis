import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { prisma } from "../../lib/prisma.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Meter import kind handler. Used for vendor inventory uploads, AMR
 * fleet rollouts, and legacy meter migrations.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Resolve premise by composite (addressLine1, zip) via the lookup
 *      map built in prepareBatch. Ambiguous matches (>1 premise with
 *      that address+zip) are recorded as PREMISE_AMBIGUOUS errors so
 *      the operator can see the data quality issue.
 *   2. Resolve commodity by code.
 *   3. Resolve UoM by code (scoped to the resolved commodity — UoM
 *      codes are unique per commodity, not globally).
 *   4. Insert one Meter row.
 *   5. Emit audit row.
 *
 * The unique constraint on (utility_id, meter_number) means re-running
 * the same file produces DUPLICATE_METER errors per row rather than
 * silent updates — explicit is better than overwriting prod data on
 * a careless re-import. De-dupe sweep is a phase 2 concern.
 */

const METER_TYPES = ["AMR", "AMI", "MANUAL", "SMART"] as const;
const METER_STATUSES = ["ACTIVE", "REMOVED", "DEFECTIVE", "PENDING_INSTALL"] as const;
type MeterType = (typeof METER_TYPES)[number];
type MeterStatus = (typeof METER_STATUSES)[number];

interface MeterRow {
  meterNumber: string;
  premiseAddress: string;
  premiseZip: string;
  commodityCode: string;
  uomCode: string;
  meterType: MeterType;
  installDate: Date;
  status?: MeterStatus;
  dialCount?: number;
  multiplier?: number;
  notes?: string;
}

interface BatchData {
  /** Composite key "addr1|zip" (lower-cased) → premise id, OR the
   *  literal sentinel "__ambiguous__" when the same address+zip
   *  matched more than one premise. */
  premiseByAddressZip: Map<string, string>;
  /** Upper-cased commodity code → commodity id. */
  commodityByCode: Map<string, string>;
  /** Composite "<commodityId>|<UPPER UoM code>" → uom id. UoM codes
   *  are unique per commodity, not globally. */
  uomByCommodityCode: Map<string, string>;
}

const AMBIGUOUS = "__ambiguous__";

function premiseKey(addr1: string, zip: string): string {
  return `${addr1.toLowerCase().trim()}|${zip.trim()}`;
}
function uomKey(commodityId: string, code: string): string {
  return `${commodityId}|${code.toUpperCase()}`;
}

const handler: ImportKindHandler<MeterRow, BatchData> = {
  kind: "meter",
  label: "Meters",
  module: "meters",
  permission: "CREATE",

  canonicalFields: [
    {
      name: "meterNumber",
      label: "Meter number",
      required: true,
      example: "WM-1001",
      aliases: ["^meternumber$", "^meterid$", "^metercode$", "^serial$", "^serialnumber$"],
    },
    {
      name: "premiseAddress",
      label: "Premise address line 1",
      required: true,
      description: "Used together with premise_zip to look up the premise.",
      example: "742 Evergreen Terrace",
      aliases: ["^premiseaddress$", "^address$", "^addressline1$", "^street$"],
    },
    {
      name: "premiseZip",
      label: "Premise ZIP",
      required: true,
      example: "62704",
      aliases: ["^premisezip$", "^zip$", "^zipcode$", "^postal$"],
    },
    {
      name: "commodityCode",
      label: "Commodity code",
      required: true,
      example: "WATER",
      aliases: ["^commoditycode$", "^commodity$", "^service$"],
    },
    {
      name: "uomCode",
      label: "Unit of measure",
      required: true,
      description: "UoM code valid for the chosen commodity (e.g. GAL for WATER).",
      example: "GAL",
      aliases: ["^uomcode$", "^uom$", "^unit$", "^units$", "^measure$"],
    },
    {
      name: "meterType",
      label: "Meter type",
      required: true,
      description: "AMR, AMI, MANUAL, or SMART.",
      example: "AMI",
      aliases: ["^metertype$", "^type$"],
    },
    {
      name: "installDate",
      label: "Install date",
      required: true,
      description: "ISO 8601 date (YYYY-MM-DD).",
      example: "2025-01-15",
      aliases: ["^installdate$", "^installed$", "^installedon$"],
    },
    {
      name: "status",
      label: "Status",
      required: false,
      description: "ACTIVE (default), REMOVED, DEFECTIVE, PENDING_INSTALL.",
      example: "ACTIVE",
      aliases: ["^status$", "^state$"],
    },
    {
      name: "dialCount",
      label: "Dial count",
      required: false,
      example: "5",
      aliases: ["^dialcount$", "^dials$"],
    },
    {
      name: "multiplier",
      label: "Multiplier",
      required: false,
      description: "Default 1.0.",
      example: "1.0",
      aliases: ["^multiplier$", "^factor$"],
    },
    {
      name: "notes",
      label: "Notes",
      required: false,
      example: "Sub-meter for irrigation",
      aliases: ["^notes$", "^comments$"],
    },
  ],

  templateRows: [
    {
      meterNumber: "WM-1001",
      premiseAddress: "742 Evergreen Terrace",
      premiseZip: "62704",
      commodityCode: "WATER",
      uomCode: "GAL",
      meterType: "AMI",
      installDate: "2025-01-15",
      status: "ACTIVE",
      dialCount: "5",
      multiplier: "1.0",
      notes: "",
    },
  ],

  parseRow: (raw) => {
    const meterNumber = (raw.meterNumber ?? "").trim();
    if (!meterNumber) {
      return { ok: false, code: "MISSING_METER_NUMBER", message: "meter_number is required" };
    }
    const premiseAddress = (raw.premiseAddress ?? "").trim();
    if (!premiseAddress) {
      return {
        ok: false,
        code: "MISSING_PREMISE_ADDRESS",
        message: "premise_address is required",
      };
    }
    const premiseZip = (raw.premiseZip ?? "").trim();
    if (!premiseZip) {
      return { ok: false, code: "MISSING_PREMISE_ZIP", message: "premise_zip is required" };
    }
    const commodityCode = (raw.commodityCode ?? "").trim().toUpperCase();
    if (!commodityCode) {
      return {
        ok: false,
        code: "MISSING_COMMODITY",
        message: "commodity_code is required",
      };
    }
    const uomCode = (raw.uomCode ?? "").trim().toUpperCase();
    if (!uomCode) {
      return { ok: false, code: "MISSING_UOM", message: "uom_code is required" };
    }
    const mtRaw = (raw.meterType ?? "").trim().toUpperCase();
    if (!METER_TYPES.includes(mtRaw as MeterType)) {
      return {
        ok: false,
        code: "INVALID_METER_TYPE",
        message: `meter_type "${raw.meterType}" must be one of ${METER_TYPES.join(", ")}`,
      };
    }
    const meterType = mtRaw as MeterType;

    const installRaw = (raw.installDate ?? "").trim();
    if (!installRaw) {
      return { ok: false, code: "MISSING_INSTALL_DATE", message: "install_date is required" };
    }
    const installDate = new Date(installRaw);
    if (Number.isNaN(installDate.getTime())) {
      return {
        ok: false,
        code: "INVALID_INSTALL_DATE",
        message: `install_date "${raw.installDate}" is not a valid date`,
      };
    }

    const statusRaw = (raw.status ?? "").trim().toUpperCase();
    let status: MeterStatus | undefined;
    if (statusRaw) {
      if (!METER_STATUSES.includes(statusRaw as MeterStatus)) {
        return {
          ok: false,
          code: "INVALID_STATUS",
          message: `status "${raw.status}" must be one of ${METER_STATUSES.join(", ")}`,
        };
      }
      status = statusRaw as MeterStatus;
    }

    let dialCount: number | undefined;
    if ((raw.dialCount ?? "").trim()) {
      const n = parseInt(raw.dialCount, 10);
      if (!Number.isFinite(n) || n < 0) {
        return {
          ok: false,
          code: "INVALID_DIAL_COUNT",
          message: `dial_count "${raw.dialCount}" must be a non-negative integer`,
        };
      }
      dialCount = n;
    }

    let multiplier: number | undefined;
    if ((raw.multiplier ?? "").trim()) {
      const n = Number(raw.multiplier);
      if (!Number.isFinite(n) || n <= 0) {
        return {
          ok: false,
          code: "INVALID_MULTIPLIER",
          message: `multiplier "${raw.multiplier}" must be a positive number`,
        };
      }
      multiplier = n;
    }

    return {
      ok: true,
      row: {
        meterNumber,
        premiseAddress,
        premiseZip,
        commodityCode,
        uomCode,
        meterType,
        installDate,
        status,
        dialCount,
        multiplier,
        notes: ((raw.notes ?? "").trim()) || undefined,
      },
    };
  },

  async prepareBatch(ctx, rows) {
    // Premise lookup: composite (addressLine1 lower-cased, zip).
    // Group source rows by (addr,zip), query Postgres in one shot.
    const addrZipSet = new Set<string>();
    const commodityCodes = new Set<string>();
    for (const r of rows) {
      addrZipSet.add(premiseKey(r.premiseAddress, r.premiseZip));
      commodityCodes.add(r.commodityCode);
    }

    const premiseByAddressZip = new Map<string, string>();
    if (addrZipSet.size > 0) {
      // Fetch every premise whose zip matches any in the batch, then
      // bucket by composite key client-side. Postgres has no composite
      // OR in Prisma, so this is the cleanest pattern.
      const zips = new Set<string>();
      for (const k of addrZipSet) zips.add(k.split("|")[1]);
      const candidates = await prisma.premise.findMany({
        where: { utilityId: ctx.utilityId, zip: { in: [...zips] } },
        select: { id: true, addressLine1: true, zip: true },
      });
      const counts = new Map<string, number>();
      for (const p of candidates) {
        const k = premiseKey(p.addressLine1, p.zip);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        premiseByAddressZip.set(k, p.id);
      }
      for (const [k, n] of counts) {
        if (n > 1) premiseByAddressZip.set(k, AMBIGUOUS);
      }
    }

    // Case-insensitive — same rationale as premise.ts. Pull all
    // commodities for the tenant; cardinality is low (~10 per tenant).
    const commodityByCode = new Map<string, string>();
    let commodities: Array<{ id: string; code: string }> = [];
    if (commodityCodes.size > 0) {
      commodities = await prisma.commodity.findMany({
        where: { utilityId: ctx.utilityId },
        select: { id: true, code: true },
      });
      for (const c of commodities) commodityByCode.set(c.code.toUpperCase(), c.id);
    }

    // UoM lookup is scoped per commodity. One query for all UoMs of
    // commodities the batch touches.
    const uomByCommodityCode = new Map<string, string>();
    if (commodities.length > 0) {
      const uoms = await prisma.unitOfMeasure.findMany({
        where: {
          utilityId: ctx.utilityId,
          commodityId: { in: commodities.map((c) => c.id) },
        },
        select: { id: true, code: true, commodityId: true },
      });
      for (const u of uoms) uomByCommodityCode.set(uomKey(u.commodityId, u.code), u.id);
    }

    return { premiseByAddressZip, commodityByCode, uomByCommodityCode };
  },

  async processRow(ctx, row, batch) {
    const pKey = premiseKey(row.premiseAddress, row.premiseZip);
    const premiseId = batch.premiseByAddressZip.get(pKey);
    if (!premiseId) {
      return {
        ok: false,
        code: "PREMISE_NOT_FOUND",
        message: `No premise at "${row.premiseAddress}" / ${row.premiseZip}`,
      };
    }
    if (premiseId === AMBIGUOUS) {
      return {
        ok: false,
        code: "PREMISE_AMBIGUOUS",
        message: `Multiple premises match "${row.premiseAddress}" / ${row.premiseZip}`,
      };
    }

    const commodityId = batch.commodityByCode.get(row.commodityCode);
    if (!commodityId) {
      return {
        ok: false,
        code: "COMMODITY_NOT_FOUND",
        message: `No commodity with code "${row.commodityCode}"`,
      };
    }

    const uomId = batch.uomByCommodityCode.get(uomKey(commodityId, row.uomCode));
    if (!uomId) {
      return {
        ok: false,
        code: "UOM_NOT_FOUND",
        message: `No UoM "${row.uomCode}" defined for commodity "${row.commodityCode}"`,
      };
    }

    try {
      const created = await ctx.tx.meter.create({
        data: {
          utilityId: ctx.utilityId,
          premiseId,
          meterNumber: row.meterNumber,
          commodityId,
          uomId,
          meterType: row.meterType,
          installDate: row.installDate,
          status: row.status ?? "ACTIVE",
          dialCount: row.dialCount ?? null,
          multiplier: row.multiplier ?? 1.0,
          notes: row.notes ?? null,
        },
      });

      await writeAuditRow(
        ctx.tx,
        {
          utilityId: ctx.utilityId,
          actorId: ctx.actorId,
          actorName: ctx.actorName,
          entityType: "Meter",
        },
        EVENT_TYPES.METER_CREATED,
        created.id,
        null,
        created,
      );

      return { ok: true, entityId: created.id };
    } catch (err: unknown) {
      // Catch the unique (utility_id, meter_number) conflict and turn
      // it into a friendly DUPLICATE_METER row error rather than
      // surfacing a Prisma constraint message.
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        return {
          ok: false,
          code: "DUPLICATE_METER",
          message: `meter_number "${row.meterNumber}" already exists`,
        };
      }
      throw err;
    }
  },
};

registerImportKind(handler);
