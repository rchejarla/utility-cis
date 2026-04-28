import { EVENT_TYPES } from "@utility-cis/shared";
import { writeAuditRow } from "../../lib/audit-wrap.js";
import { prisma } from "../../lib/prisma.js";
import {
  computeConsumption,
  resolveServiceAgreementId,
} from "../../services/meter-read.service.js";
import { registerImportKind } from "../registry.js";
import type { ImportKindHandler } from "../types.js";

/**
 * Meter-read import kind handler. Encapsulates the per-row processing
 * logic the framework dispatches to once per row.
 *
 * Per-row pipeline (within the framework-supplied tx):
 *   1. Look up meter by `meterNumber` from the prepared map (built
 *      once per batch in `prepareBatch`).
 *   2. Reject if meter unknown (METER_NOT_FOUND) or REMOVED.
 *   3. Resolve service agreement id from the SAM junction at the
 *      read date. Surfaces METER_NOT_ASSIGNED through the existing
 *      service helper.
 *   4. Compute prior reading + consumption from prior history.
 *   5. INSERT one MeterRead row.
 *   6. Emit audit row.
 *
 * Chronological ordering: the framework sorts rows by (rowIndex) but
 * not by (meter, datetime). For multiple reads on the same meter
 * within one batch, `computeConsumption` looks at prior reads in the
 * DB — so as long as rows for the same meter arrive in chronological
 * order in the source file, the consumption math is correct. If
 * operators mix order within a meter, the imports service sorts the
 * input by (meterNumber, readDatetime ASC) before per-row dispatch
 * (see imports.service.ts).
 */

interface MeterReadRow {
  meterNumber: string;
  readDatetime: string;
  reading: number;
  readType?: "ACTUAL" | "ESTIMATED" | "CORRECTED" | "FINAL" | "AMI";
  readSource?: "MANUAL" | "AMR" | "AMI" | "CUSTOMER_SELF" | "SYSTEM";
}

interface BatchData {
  meterByNumber: Map<
    string,
    { id: string; meterNumber: string; status: string; uomId: string }
  >;
  /** Default readSource derived from the batch's source enum. */
  defaultReadSource: "MANUAL" | "AMR" | "AMI" | "SYSTEM";
}

const READ_TYPES = ["ACTUAL", "ESTIMATED", "CORRECTED", "FINAL", "AMI"] as const;
const READ_SOURCES = ["MANUAL", "AMR", "AMI", "CUSTOMER_SELF", "SYSTEM"] as const;

const handler: ImportKindHandler<MeterReadRow, BatchData> = {
  kind: "meter_read",
  label: "Meter reads",
  module: "meter_reads",
  permission: "CREATE",

  canonicalFields: [
    {
      name: "meterNumber",
      label: "Meter number",
      required: true,
      description: "Identifier matching an existing meter on this tenant.",
      example: "MTR-001",
      aliases: ["^meternumber$", "^meter$", "^meterid$", "^metercode$", "^mtr$"],
    },
    {
      name: "readDatetime",
      label: "Read datetime",
      required: true,
      description: "ISO 8601 date-time of the reading. Time portion optional.",
      example: "2026-04-15T09:00:00Z",
      aliases: [
        "^readdatetime$",
        "^datetime$",
        "^readdate$",
        "^date$",
        "^timestamp$",
        "^readtime$",
      ],
    },
    {
      name: "reading",
      label: "Reading",
      required: true,
      description: "Numeric meter reading. Decimals allowed.",
      example: "12345.67",
      aliases: ["^reading$", "^value$", "^read$", "^current$", "^index$"],
    },
    {
      name: "readType",
      label: "Read type",
      required: false,
      description: "ACTUAL (default), ESTIMATED, CORRECTED, FINAL, AMI.",
      example: "ACTUAL",
      aliases: ["^readtype$", "^type$"],
    },
    {
      name: "readSource",
      label: "Read source",
      required: false,
      description: "MANUAL, AMR, AMI, CUSTOMER_SELF, SYSTEM.",
      example: "MANUAL",
      aliases: ["^readsource$", "^source$", "^channel$"],
    },
  ],

  templateRows: [
    {
      meterNumber: "MTR-001",
      readDatetime: "2026-04-15T09:00:00Z",
      reading: "12345.67",
      readType: "ACTUAL",
      readSource: "MANUAL",
    },
    {
      meterNumber: "MTR-002",
      readDatetime: "2026-04-15T09:05:00Z",
      reading: "8901.23",
      readType: "ACTUAL",
      readSource: "AMR",
    },
  ],

  parseRow: (raw) => {
    const meterNumber = (raw.meterNumber ?? "").trim();
    if (!meterNumber) {
      return { ok: false, code: "MISSING_METER_NUMBER", message: "meter_number is required" };
    }

    const datetimeRaw = (raw.readDatetime ?? "").trim();
    if (!datetimeRaw) {
      return {
        ok: false,
        code: "MISSING_READ_DATETIME",
        message: "read_datetime is required",
      };
    }

    const parsedDate = new Date(datetimeRaw);
    if (Number.isNaN(parsedDate.getTime())) {
      return {
        ok: false,
        code: "INVALID_READ_DATETIME",
        message: `Could not parse "${datetimeRaw}" as a date-time`,
      };
    }

    const readingRaw = (raw.reading ?? "").trim();
    const reading = Number(readingRaw);
    if (!readingRaw || !Number.isFinite(reading)) {
      return {
        ok: false,
        code: "INVALID_READING",
        message: `"${readingRaw}" is not a valid number`,
      };
    }
    if (reading < 0) {
      return {
        ok: false,
        code: "NEGATIVE_READING",
        message: "Reading must be non-negative",
      };
    }

    const typeRaw = (raw.readType ?? "").trim().toUpperCase();
    const readType =
      typeRaw && READ_TYPES.includes(typeRaw as (typeof READ_TYPES)[number])
        ? (typeRaw as (typeof READ_TYPES)[number])
        : undefined;
    if (typeRaw && !readType) {
      return {
        ok: false,
        code: "INVALID_READ_TYPE",
        message: `read_type "${raw.readType}" must be one of ${READ_TYPES.join(", ")}`,
      };
    }

    const sourceRaw = (raw.readSource ?? "").trim().toUpperCase();
    const readSource =
      sourceRaw && READ_SOURCES.includes(sourceRaw as (typeof READ_SOURCES)[number])
        ? (sourceRaw as (typeof READ_SOURCES)[number])
        : undefined;
    if (sourceRaw && !readSource) {
      return {
        ok: false,
        code: "INVALID_READ_SOURCE",
        message: `read_source "${raw.readSource}" must be one of ${READ_SOURCES.join(", ")}`,
      };
    }

    return {
      ok: true,
      row: {
        meterNumber,
        readDatetime: parsedDate.toISOString(),
        reading,
        readType,
        readSource,
      },
    };
  },

  async prepareBatch(ctx, rows) {
    const meterNumbers = [...new Set(rows.map((r) => r.meterNumber))];
    const meters = await prisma.meter.findMany({
      where: { utilityId: ctx.utilityId, meterNumber: { in: meterNumbers } },
      select: { id: true, meterNumber: true, status: true, uomId: true },
    });
    const meterByNumber = new Map(
      meters.map((m) => [m.meterNumber, m] as const),
    );
    return {
      meterByNumber,
      defaultReadSource: meterReadDefaultSource(ctx.source),
    };
  },

  async processRow(ctx, row, batchData) {
    const meter = batchData.meterByNumber.get(row.meterNumber);
    if (!meter) {
      return {
        ok: false,
        code: "METER_NOT_FOUND",
        message: `Meter "${row.meterNumber}" not found on this tenant`,
      };
    }
    if (meter.status === "REMOVED") {
      return {
        ok: false,
        code: "METER_REMOVED",
        message: `Meter "${row.meterNumber}" is REMOVED — reads cannot be imported against it`,
      };
    }

    const readDatetime = new Date(row.readDatetime);
    const readDate = new Date(readDatetime.toISOString().slice(0, 10));

    let serviceAgreementId: string;
    try {
      serviceAgreementId = await resolveServiceAgreementId(
        ctx.utilityId,
        meter.id,
        readDate,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not resolve service agreement";
      return { ok: false, code: "METER_NOT_ASSIGNED", message };
    }

    const { priorReading, consumption, exceptionCode } = await computeConsumption(
      ctx.utilityId,
      meter.id,
      null,
      row.reading,
      readDatetime,
    );

    const created = await ctx.tx.meterRead.create({
      data: {
        utilityId: ctx.utilityId,
        meterId: meter.id,
        serviceAgreementId,
        uomId: meter.uomId,
        readDate,
        readDatetime,
        reading: row.reading,
        priorReading,
        consumption,
        readType: row.readType ?? "ACTUAL",
        readSource: row.readSource ?? batchData.defaultReadSource,
        exceptionCode: exceptionCode ?? null,
        readerId: ctx.actorId,
      },
    });

    await writeAuditRow(
      ctx.tx,
      {
        utilityId: ctx.utilityId,
        actorId: ctx.actorId,
        actorName: ctx.actorName,
        entityType: "MeterRead",
      },
      EVENT_TYPES.METER_CREATED,
      created.id,
      null,
      created,
    );

    return { ok: true, entityId: created.id };
  },
};

registerImportKind(handler);

/**
 * Map ImportBatchSource → MeterRead.readSource when the row didn't
 * specify its own. Used by the imports service when constructing
 * `batchData.defaultReadSource` for this handler.
 */
export function meterReadDefaultSource(
  batchSource: "AMR" | "AMI" | "MANUAL_UPLOAD" | "API",
): "MANUAL" | "AMR" | "AMI" | "SYSTEM" {
  switch (batchSource) {
    case "AMR":
      return "AMR";
    case "AMI":
      return "AMI";
    case "MANUAL_UPLOAD":
      return "MANUAL";
    case "API":
      return "SYSTEM";
  }
}
